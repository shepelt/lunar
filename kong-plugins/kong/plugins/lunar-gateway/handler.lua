local http = require "resty.http"
local cjson = require "cjson.safe"

local LunarGatewayHandler = {
  PRIORITY = 1000,
  VERSION = "1.0.0"
}

-- Helper function to make HTTP requests to backend
local function call_backend_sync(method, url, body)
  local httpc = http.new()
  httpc:set_timeout(5000)

  local res, err = httpc:request_uri(url, {
    method = method,
    body = body and cjson.encode(body) or nil,
    headers = {
      ["Content-Type"] = "application/json",
    },
    ssl_verify = false
  })

  if not res then
    return nil, "HTTP request failed: " .. (err or "unknown error")
  end

  if res.status >= 400 then
    return nil, "Backend returned error: " .. res.status
  end

  local data, decode_err = cjson.decode(res.body)
  if not data then
    return nil, "Failed to decode response: " .. (decode_err or "unknown error")
  end

  return data, nil
end

-- Rewrite phase: Capture request body before sending to upstream
function LunarGatewayHandler:rewrite(conf)
  -- Read and store request body
  local request_body = kong.request.get_raw_body()

  if request_body then
    kong.ctx.plugin.request_body = request_body
  end
end

-- Access phase: Check quota before allowing request
function LunarGatewayHandler:access(conf)
  -- Get consumer information
  local consumer = kong.client.get_consumer()

  if not consumer then
    return -- No consumer, skip quota check
  end

  local consumer_id = consumer.id

  -- Store consumer_id in context for log phase
  kong.ctx.plugin.consumer_id = consumer_id

  -- Check quota with backend
  local quota_url = conf.backend_url .. "/api/quota/check/" .. consumer_id
  local quota_data, err = call_backend_sync("GET", quota_url)

  if err then
    kong.log.warn("Lunar Gateway: Failed to check quota: ", err)
    -- Fail open: allow request if backend is unavailable
    return
  end

  -- Check if consumer has sufficient quota
  if not quota_data.allowed then
    return kong.response.exit(429, {
      message = "Quota exceeded",
      remaining = quota_data.remaining or 0,
      quota = quota_data.quota or 0
    })
  end
end

-- Body filter phase: Capture response body chunks
function LunarGatewayHandler:body_filter(conf)
  local ctx = kong.ctx.plugin
  local chunk = ngx.arg[1]

  -- Initialize buffer on first chunk
  if not ctx.response_body then
    ctx.response_body = {}
  end

  -- Collect chunks (response is compressed, will be decompressed by backend)
  if chunk and #chunk > 0 then
    table.insert(ctx.response_body, chunk)
  end
end

-- Log phase: Log usage after request completes (runs in background timer)
function LunarGatewayHandler:log(conf)
  -- Get consumer ID from context (stored in access phase)
  local consumer_id = kong.ctx.plugin.consumer_id

  if not consumer_id then
    return -- No consumer, nothing to log
  end

  -- Get captured request body from rewrite phase
  local request_body = kong.ctx.plugin.request_body

  -- Get captured response body from body_filter phase
  local response_body_parts = kong.ctx.plugin.response_body
  local response_body_compressed = nil

  if response_body_parts and #response_body_parts > 0 then
    response_body_compressed = table.concat(response_body_parts)
  end

  -- Get model info from Kong's response headers (set by ai-proxy plugin)
  local llm_model_header = kong.response.get_header("X-Kong-LLM-Model") or "openai/gpt-5"
  local provider, model = llm_model_header:match("^([^/]+)/(.+)$")

  if not provider or not model then
    provider = "openai"
    model = "gpt-5"
  end

  local status = kong.response.get_status() < 400 and "success" or "error"

  -- Run logging in background timer to avoid log phase network restrictions
  local ok, err = ngx.timer.at(0, function(premature)
    if premature then return end

    local log_url = conf.backend_url .. "/api/quota/log"

    -- Build log data - send request and response bodies for backend to process
    local log_data = {
      consumer_id = consumer_id,
      provider = provider,
      model = model,
      status = status
    }

    -- Add request body if available (base64 encoded for JSON transport)
    if request_body then
      log_data.request_body = ngx.encode_base64(request_body)
    end

    -- Add compressed response body if available (base64 encoded for JSON transport)
    if response_body_compressed then
      log_data.response_body_compressed = ngx.encode_base64(response_body_compressed)
    end

    local result, log_err = call_backend_sync("POST", log_url, log_data)

    if log_err then
      kong.log.err("Lunar Gateway: Failed to log usage: ", log_err)
    end
  end)

  if not ok then
    kong.log.err("Lunar Gateway: Failed to create timer: ", err)
  end
end

return LunarGatewayHandler
