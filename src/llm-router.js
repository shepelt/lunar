import express from 'express';
import { Readable } from 'stream';
import { estimateTokenCount } from 'tokenx';

const router = express.Router();

// Cache for model context limits (Hybrid Cache - Option 4)
const modelContextCache = new Map();

// Get context limit for a model (query once, cache results)
async function getContextLimit(modelName, provider) {
  // Only applicable for Ollama
  if (provider !== 'ollama') {
    return null; // OpenAI/Anthropic handle their own limits
  }

  const cacheKey = modelName;

  // Check cache first
  if (modelContextCache.has(cacheKey)) {
    return modelContextCache.get(cacheKey);
  }

  // Query Ollama /api/show endpoint
  try {
    const ollamaUrl = process.env.OLLAMA_BACKEND_URL || 'http://macserver.tailcdff5e.ts.net:11434';
    const response = await fetch(`${ollamaUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName })
    });

    if (!response.ok) {
      console.warn(`Failed to query Ollama model info for ${modelName}: ${response.status}`);
      return 131072; // fallback to common max
    }

    const info = await response.json();

    // Extract context_length from model_info
    // Format: model_info["modelname.context_length"]
    const modelBaseName = modelName.split(':')[0];
    const contextLength = info.model_info?.[`${modelBaseName}.context_length`] || 131072;

    console.log(`Context limit for ${modelName}: ${contextLength} tokens (cached)`);

    // Cache the result
    modelContextCache.set(cacheKey, contextLength);
    return contextLength;

  } catch (error) {
    console.error(`Error fetching context limit for ${modelName}:`, error);
    return 131072; // fallback
  }
}

// Estimate token count for a request
function estimateRequestTokens(body) {
  let totalText = '';

  // Accumulate all message content
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.content) {
        if (typeof msg.content === 'string') {
          totalText += msg.content + ' ';
        } else if (Array.isArray(msg.content)) {
          // Handle content array (multimodal)
          for (const part of msg.content) {
            if (part.type === 'text' && part.text) {
              totalText += part.text + ' ';
            }
          }
        }
      }
    }
  }

  // Use tokenx for estimation (94% accurate)
  const estimated = estimateTokenCount(totalText);
  console.log(`Token estimation: ~${estimated} tokens for ${totalText.length} characters`);
  return estimated;
}

// Apply request transformations based on provider
function transformRequest(body, provider) {
  const model = body.model || '';
  let modified = false;

  // Detect provider type
  const isOpenAI = provider === 'openai';
  const isOllama = provider === 'ollama';
  const isGPT5OrO1 = isOpenAI && (model.match(/^gpt-5/) || model.match(/^o1/));

  console.log(`Transform: provider=${provider}, model=${model}, isOpenAI=${isOpenAI}, isGPT5OrO1=${isGPT5OrO1}, isOllama=${isOllama}`);

  // 1. Transform max_tokens ↔ max_completion_tokens based on provider
  if (isGPT5OrO1) {
    // GPT-5/o1 models: Use max_completion_tokens
    if (body.max_tokens && !body.max_completion_tokens) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
      modified = true;
      console.log(`Transform: max_tokens → max_completion_tokens (${body.max_completion_tokens})`);
    }
  } else if (isOllama) {
    // Ollama models: Use max_tokens
    if (body.max_completion_tokens && !body.max_tokens) {
      body.max_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
      modified = true;
      console.log(`Transform: max_completion_tokens → max_tokens (${body.max_tokens})`);
    }
  }
  // GPT-4 and older OpenAI models: Keep max_tokens as-is (no transformation needed)

  // 2. Add stream_options for usage tracking (OpenAI streaming only)
  if (body.stream && isOpenAI && !body.stream_options) {
    body.stream_options = {
      include_usage: true
    };
    modified = true;
    console.log(`Transform: Added stream_options.include_usage for streaming`);
  }

  if (modified) {
    console.log(`Transform: Request body modified`);
  }

  return body;
}

// Shared routing logic
async function routeToProvider(req, res) {
  try {
    let body = req.body;
    const model = body.model || '';

    console.log(`LLM Router: Received request for model: ${model}`);

    // Parse provider/model format (e.g., "openai/gpt-4", "anthropic/claude", "ollama/gpt-oss:120b")
    const providerMatch = model.match(/^(openai|anthropic|ollama)\/(.+)$/);

    if (!providerMatch) {
      return res.status(400).json({
        error: 'Invalid model format. Use provider/model format (e.g., "openai/gpt-4o", "anthropic/claude-sonnet-4", "ollama/gpt-oss:120b")'
      });
    }

    const provider = providerMatch[1];
    const modelName = providerMatch[2];

    // Strip provider prefix from model name
    body.model = modelName;
    console.log(`LLM Router: Provider: ${provider}, Model: ${modelName}`);

    // Pricing validation - reject requests for unsupported models before proxying
    // This prevents wasting upstream API quota and ensures proper cost tracking
    try {
      const { getPricing } = await import('./pricing.js');
      getPricing(provider, modelName);
    } catch (pricingError) {
      console.warn(`Pricing validation failed: ${pricingError.message}`);
      return res.status(400).json({
        error: {
          message: pricingError.message,
          type: 'invalid_request_error',
          param: 'model',
          code: 'unsupported_model'
        }
      });
    }

    // Token validation (Ollama only - OpenAI/Anthropic handle their own limits)
    if (provider === 'ollama') {
      const estimatedTokens = estimateRequestTokens(body);
      const contextLimit = await getContextLimit(modelName, provider);

      if (contextLimit && estimatedTokens > contextLimit) {
        console.warn(`Token limit exceeded: ${estimatedTokens} > ${contextLimit} for model ${modelName}`);
        return res.status(400).json({
          error: {
            message: `This model's maximum context length is ${contextLimit} tokens. However, your messages resulted in approximately ${estimatedTokens} tokens. Please reduce the length of the messages.`,
            type: 'invalid_request_error',
            param: 'messages',
            code: 'context_length_exceeded'
          }
        });
      }

      console.log(`Token validation passed: ${estimatedTokens} <= ${contextLimit}`);
    }

    // Apply transformations
    body = transformRequest(body, provider);

    // Route based on provider
    let internalRoute;
    if (provider === 'openai') {
      internalRoute = 'http://localhost:8000/internal/openai';
      console.log(`LLM Router: Routing to OpenAI`);
    } else if (provider === 'anthropic') {
      internalRoute = 'http://localhost:8000/internal/anthropic';
      console.log(`LLM Router: Routing to Anthropic`);
    } else if (provider === 'ollama') {
      internalRoute = 'http://localhost:8000/internal/ollama';
      console.log(`LLM Router: Routing to Ollama`);
    }

    // Forward to Kong internal route with ai-proxy
    const response = await fetch(internalRoute, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Forward consumer headers from Kong
        ...(req.headers['x-consumer-id'] && { 'x-consumer-id': req.headers['x-consumer-id'] }),
        ...(req.headers['x-consumer-username'] && { 'x-consumer-username': req.headers['x-consumer-username'] }),
        ...(req.headers['x-consumer-custom-id'] && { 'x-consumer-custom-id': req.headers['x-consumer-custom-id'] }),
      },
      body: JSON.stringify(body)
    });

    // Forward response status
    res.status(response.status);

    // Forward response headers (exclude encoding-related headers to avoid conflicts)
    const headersToSkip = ['content-encoding', 'transfer-encoding', 'content-length'];
    response.headers.forEach((value, key) => {
      if (!headersToSkip.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    // Stream response body back to client
    // Note: We intentionally skip content-encoding header above (line 210)
    // This tells Kong the response is NOT compressed, even if upstream sent it compressed
    // Express will automatically decompress gzipped responses, so Kong receives plain text
    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.pipe(res);

  } catch (error) {
    console.error('LLM Router error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Unified LLM endpoint (OpenRouter-style)
router.post('/v1/chat/completions', routeToProvider);

// Legacy endpoints (for backward compatibility)
router.post('/', async (req, res) => {
  console.log('LLM Router: Legacy /llm endpoint hit, routing to OpenAI');
  // /llm always goes to OpenAI
  try {
    // Apply transformations
    let body = transformRequest(req.body);

    const response = await fetch('http://localhost:8000/internal/openai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers['x-consumer-id'] && { 'x-consumer-id': req.headers['x-consumer-id'] }),
        ...(req.headers['x-consumer-username'] && { 'x-consumer-username': req.headers['x-consumer-username'] }),
        ...(req.headers['x-consumer-custom-id'] && { 'x-consumer-custom-id': req.headers['x-consumer-custom-id'] }),
      },
      body: JSON.stringify(body)
    });

    res.status(response.status);

    // Forward response headers (exclude encoding-related headers to avoid conflicts)
    const headersToSkip = ['content-encoding', 'transfer-encoding', 'content-length'];
    response.headers.forEach((value, key) => {
      if (!headersToSkip.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.pipe(res);
  } catch (error) {
    console.error('LLM Router error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
