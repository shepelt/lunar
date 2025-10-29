/**
 * Mock LLM Proxy for testing parameter transformations
 * Intercepts requests from Kong and returns mock responses
 * Validates that parameters were correctly transformed before reaching the "LLM"
 */

import express from 'express';

const app = express();
const PORT = 11435;

// Store intercepted requests
const interceptedRequests = [];

// Middleware to parse JSON
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', intercepted_count: interceptedRequests.length });
});

// Clear intercepted requests
app.post('/test/clear', (req, res) => {
  interceptedRequests.length = 0;
  res.json({ message: 'Cleared', count: 0 });
});

// Get intercepted requests
app.get('/test/requests', (req, res) => {
  res.json({ requests: interceptedRequests });
});

// Mock LLM response generator
function generateMockResponse(model, messages, maxTokens) {
  const mockMessage = "Hello! This is a mock response for testing.";
  const completionTokens = Math.min(maxTokens || 10, 10); // Cap at 10 tokens for tests

  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: mockMessage
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: completionTokens,
      total_tokens: 10 + completionTokens
    }
  };
}

// Proxy all requests - returns mock responses for testing
app.all('*', async (req, res) => {
  // Detect provider based on model in request body
  let provider = 'ollama';

  if (req.body && req.body.model) {
    const model = req.body.model;
    // OpenAI models: gpt-*, o1-*, etc.
    if (model.startsWith('gpt-') || model.startsWith('o1')) {
      provider = 'openai';
    }
  }

  console.log(`\n📨 Intercepted ${req.method} ${req.path} [${provider}]`);

  // Capture request details
  const intercepted = {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    provider: provider,
    headers: { ...req.headers },
    body: req.body
  };

  // Log parameter transformations if it's a chat completion
  if (req.path.includes('/chat/completions') && req.body) {
    console.log(`  Model: ${req.body.model}`);
    console.log(`  Provider: ${provider}`);

    if (req.body.max_tokens !== undefined) {
      console.log(`  ✓ max_tokens: ${req.body.max_tokens}`);
    }

    if (req.body.max_completion_tokens !== undefined) {
      console.log(`  ✓ max_completion_tokens: ${req.body.max_completion_tokens}`);
    }

    if (req.body.max_tokens === undefined && req.body.max_completion_tokens === undefined) {
      console.log(`  ⚠️  No token limit parameters found`);
    }
  }

  // Store intercepted request
  interceptedRequests.push(intercepted);

  // Keep only last 100 requests
  if (interceptedRequests.length > 100) {
    interceptedRequests.shift();
  }

  // Return mock response for chat completions
  if (req.path.includes('/chat/completions') && req.body) {
    const maxTokens = req.body.max_tokens || req.body.max_completion_tokens || 10;
    const mockResponse = generateMockResponse(req.body.model, req.body.messages, maxTokens);

    console.log(`  → Returning mock response (${mockResponse.usage.completion_tokens} tokens)`);
    return res.status(200).json(mockResponse);
  }

  // For other endpoints, return a simple success
  res.status(200).json({ status: 'ok', message: 'Mock proxy' });
});

app.listen(PORT, () => {
  console.log(`\n🔍 Mock LLM Proxy listening on port ${PORT}`);
  console.log(`   Returns mock responses for all LLM requests`);
  console.log(`   Intercepts and validates parameter transformations`);
  console.log(`   Test endpoint: http://localhost:${PORT}/test/requests\n`);
});

export default app;
