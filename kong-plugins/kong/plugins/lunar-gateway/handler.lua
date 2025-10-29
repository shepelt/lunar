local http = require "resty.http"
local cjson = require "cjson.safe"

local LunarGatewayHandler = {
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

-- Rewrite phase: Modify request body before other plugins read it
function LunarGatewayHandler:rewrite(conf)

  -- Try to get body from memory first
  local request_body, err = kong.request.get_raw_body()

  if request_body then
    local body_json, decode_err = cjson.decode(request_body)

    if body_json then
      local model = body_json.model or ""
      local is_gpt5_or_o1 = model:match("^gpt%-5") or model:match("^gpt%-5%-") or model:match("^o1")

      -- Transform max_tokens → max_completion_tokens for GPT-5/o1
      if is_gpt5_or_o1 and body_json.max_tokens and not body_json.max_completion_tokens then
        body_json.max_completion_tokens = body_json.max_tokens
        body_json.max_tokens = nil

        local new_body = cjson.encode(body_json)
        ngx.req.read_body()
        ngx.req.set_body_data(new_body)
      end
    end
  end
end

-- Access phase: Check quota before allowing request
function LunarGatewayHandler:access(conf)

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

  -- Modify request body for provider compatibility
  if request_body then
    local body_json, decode_err = cjson.decode(request_body)

    if body_json then
      local modified = false

      -- Detect provider from model name or default to OpenAI
      local model = body_json.model or ""
      local is_openai = model:match("^gpt") or model:match("^o1") or model == ""
      local is_gpt5_or_o1 = model:match("^gpt%-5") or model:match("^gpt%-5%-") or model:match("^o1")
      local is_ollama = not is_openai  -- Non-OpenAI models are Ollama

      -- Transform max_tokens ↔ max_completion_tokens based on provider
      -- Accept both parameters, transform to what provider expects
      if is_gpt5_or_o1 then
        -- GPT-5/o1 models: Use max_completion_tokens
        if body_json.max_tokens and not body_json.max_completion_tokens then
          body_json.max_completion_tokens = body_json.max_tokens
          body_json.max_tokens = nil
          modified = true
        end
      elseif is_ollama then
        -- Ollama models: Use max_tokens
        if body_json.max_completion_tokens and not body_json.max_tokens then
          body_json.max_tokens = body_json.max_completion_tokens
          body_json.max_completion_tokens = nil
          modified = true
          kong.log.info("Transformed max_completion_tokens → max_tokens for Ollama model: ", model)
        end
      end
      -- GPT-4 and older OpenAI models: Keep max_tokens as-is (no transformation needed)

      -- Add stream_options for usage tracking (OpenAI streaming only)
      if body_json.stream and is_openai and not body_json.stream_options then
        body_json.stream_options = {
          include_usage = true
        }
        modified = true
        kong.log.info("Added stream_options for OpenAI model: ", model)
      end

      -- Apply modifications if any were made
      if modified then
        local new_body = cjson.encode(body_json)

        -- Update the request body so other plugins see the modification
        ngx.req.read_body()
        ngx.req.set_body_data(new_body)

        -- Also update for the upstream service
        kong.service.request.set_raw_body(new_body)
        kong.service.request.set_header("Content-Length", string.len(new_body))

        -- Store in context
        kong.ctx.plugin.request_body = new_body
      else
      end
    end
  end

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
