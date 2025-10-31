import express from 'express';
import { Readable } from 'stream';

const router = express.Router();

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
