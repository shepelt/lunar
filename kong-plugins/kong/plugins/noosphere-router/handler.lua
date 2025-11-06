local http = require "resty.http"
local cjson = require "cjson.safe"

local NoosphereRouterHandler = {
  PRIORITY = 1100,  -- Run before ai-proxy (priority ~800)
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

-- Rewrite phase: No longer used (transformations moved to backend)
function NoosphereRouterHandler:rewrite(conf)
  -- Transformations now handled by Express backend (src/llm-router.js)
end

-- Access phase: Check quota before allowing request
function NoosphereRouterHandler:access(conf)

  -- Capture request body (must be done in access phase before proxying)
  -- Try to get body from memory first
  local request_body, err = kong.request.get_raw_body()

  if request_body then
    kong.ctx.plugin.request_body = request_body
    kong.log.debug("Captured request body from memory: ", string.len(request_body), " bytes")
  else
    -- If body is too large and buffered to disk, read from temporary file
    kong.log.debug("Body not in memory, checking for buffered file: ", err or "empty")

    -- Force nginx to read the body into the buffer/file
    ngx.req.read_body()

    -- Check if body was buffered to a file
    local body_file = ngx.req.get_body_file()

    if body_file then
      kong.log.info("Reading request body from temporary file: ", body_file)

      -- Read the file
      local file = io.open(body_file, "r")
      if file then
        request_body = file:read("*all")
        file:close()

        if request_body then
          kong.ctx.plugin.request_body = request_body
          kong.log.info("Successfully captured request body from file: ", string.len(request_body), " bytes")
        else
          kong.log.warn("Failed to read request body from file")
        end
      else
        kong.log.warn("Failed to open request body file: ", body_file)
      end
    else
      kong.log.debug("No request body file, body might be empty or already consumed")
    end
  end

  -- Request body transformations now handled by Express backend (src/llm-router.js)
  -- This plugin now only handles quota checking and audit logging

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
    -- Fail open: allow request if backend is unavailable (continue processing)
  elseif quota_data and not quota_data.allowed then
    -- Check if consumer has sufficient quota (only if we got valid quota_data)
    return kong.response.exit(429, {
      message = "Quota exceeded",
      remaining = quota_data.remaining or 0,
      quota = quota_data.quota or 0
    })
  end

  -- Model-based routing (if enabled)
  kong.log.info("Lunar Gateway: enable_routing=", conf.enable_routing, " has_body=", request_body ~= nil)

  if conf.enable_routing then
    kong.log.info("Lunar Gateway: Routing enabled, checking body")

    if not request_body then
      kong.log.warn("Lunar Gateway: No request body available for routing")
      return
    end

    local body_json, decode_err = cjson.decode(request_body)

    if not body_json then
      kong.log.warn("Lunar Gateway: Failed to decode body: ", decode_err or "unknown")
      return
    end

    kong.log.info("Lunar Gateway: Body decoded, model=", body_json.model or "nil")

    if body_json.model then
      local model = body_json.model
      local target_route = nil

      -- Detect provider from model pattern
      if model:match("^gpt") or model:match("^o1") then
        target_route = "/internal/openai"
        kong.log.info("Lunar Gateway: Routing model '", model, "' to OpenAI")
      elseif model:match("^claude") then
        target_route = "/internal/anthropic"
        kong.log.info("Lunar Gateway: Routing model '", model, "' to Anthropic")
      else
        target_route = "/internal/ollama"
        kong.log.info("Lunar Gateway: Routing model '", model, "' to Ollama")
      end

      -- Internal redirect to the target route
      if target_route then
        kong.log.info("Lunar Gateway: Executing internal redirect to: ", target_route)

        -- Re-set the request body to ensure it's available in the subrequest
        ngx.req.set_body_data(request_body)

        return ngx.exec(target_route)
      end
    else
      kong.log.warn("Lunar Gateway: No model field in request body")
    end
  end
end

-- Body filter phase: Capture response body chunks
function NoosphereRouterHandler:body_filter(conf)
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
function NoosphereRouterHandler:log(conf)
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

return NoosphereRouterHandler
