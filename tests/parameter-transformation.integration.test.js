import OpenAI from 'openai';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { nanoid } from 'nanoid';

// Use environment variables for URLs (supports both local and Docker testing)
const KONG_ADMIN_URL = process.env.KONG_ADMIN_URL || 'http://localhost:8001';
const KONG_GATEWAY_URL = process.env.KONG_GATEWAY_URL || 'http://localhost:8000';
const TEST_PROXY_URL = process.env.TEST_PROXY_URL || 'http://localhost:11435';

// Model name from environment (defaults to test model)
const OLLAMA_MODEL = process.env.OLLAMA_MODEL_NAME || 'qwen2:0.5b';

// Check if OpenAI is configured (for GPT-5 tests)
const OPENAI_CONFIGURED = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'test-key');

// Helper to clear and get intercepted requests from test proxy
async function clearProxyRequests() {
  try {
    await fetch(`${TEST_PROXY_URL}/test/clear`, { method: 'POST' });
  } catch (err) {
    console.warn('Could not clear proxy requests:', err.message);
  }
}

async function getProxyRequests() {
  try {
    const res = await fetch(`${TEST_PROXY_URL}/test/requests`);
    const data = await res.json();
    return data.requests || [];
  } catch (err) {
    console.warn('Could not get proxy requests:', err.message);
    return [];
  }
}

describe('Parameter Transformation through Lunar Gateway', () => {
  let apiKey;
  let testConsumerId;
  let testUsername;

  beforeAll(async () => {
    // Create test consumer with unique name
    testUsername = `test-param-${nanoid(8)}`;

    console.log(`🔍 Test environment:`);
    console.log(`   KONG_ADMIN_URL: ${KONG_ADMIN_URL}`);
    console.log(`   KONG_GATEWAY_URL: ${KONG_GATEWAY_URL}`);

    try {
      const consumerRes = await fetch(`${KONG_ADMIN_URL}/consumers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: testUsername })
      });

      const consumer = await consumerRes.json();
      testConsumerId = consumer.id;

      // Create API key for this consumer
      const keyRes = await fetch(`${KONG_ADMIN_URL}/consumers/${testUsername}/key-auth`, {
        method: 'POST'
      });

      const keyData = await keyRes.json();
      apiKey = keyData.key;

      console.log(`✓ Test consumer created: ${testUsername}`);
      console.log(`✓ API key: ${apiKey}`);
    } catch (error) {
      console.error('Failed to create test consumer:', error.message);
      throw error;
    }
  });

  afterAll(async () => {
    // Cleanup: delete test consumer
    if (testConsumerId) {
      try {
        await fetch(`${KONG_ADMIN_URL}/consumers/${testConsumerId}`, {
          method: 'DELETE'
        });
        console.log(`✓ Cleaned up test consumer: ${testUsername}`);
      } catch (error) {
        console.warn('Failed to cleanup test consumer:', error.message);
      }
    }
  });

  const describeGPT5 = OPENAI_CONFIGURED ? describe : describe.skip;

  describeGPT5('GPT-5 Parameter Transformation', () => {
    test('should accept max_tokens and transform to max_completion_tokens', async () => {
      // Clear proxy requests before test
      await clearProxyRequests();

      const client = new OpenAI({
        apiKey: apiKey,
        baseURL: `${KONG_GATEWAY_URL}/llm/v1`,
        defaultHeaders: {
          'apikey': apiKey
        }
      });

      const response = await client.chat.completions.create({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'Say hello' }],
        max_tokens: 10  // Plugin should transform to max_completion_tokens
      });

      expect(response.choices[0].message).toBeDefined();
      expect(response.usage.completion_tokens).toBeLessThanOrEqual(10);

      // Validate transformation happened via proxy
      const proxyRequests = await getProxyRequests();
      const chatRequest = proxyRequests.find(r => r.path.includes('/chat/completions'));

      if (chatRequest) {
        console.log('✓ Intercepted request to OpenAI:', chatRequest.body);
        expect(chatRequest.body.max_tokens).toBeUndefined();
        expect(chatRequest.body.max_completion_tokens).toBe(10);
      }
    }, 30000);

    test('should accept max_completion_tokens and pass through', async () => {
      // Clear proxy requests before test
      await clearProxyRequests();

      const response = await fetch(`${KONG_GATEWAY_URL}/llm/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': apiKey
        },
        body: JSON.stringify({
          model: 'gpt-5',
          messages: [{ role: 'user', content: 'Say hello' }],
          max_completion_tokens: 10  // Plugin should pass through (already correct)
        })
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.choices[0].message).toBeDefined();
      expect(data.usage.completion_tokens).toBeLessThanOrEqual(10);

      // Validate no transformation (already correct format)
      const proxyRequests = await getProxyRequests();
      const chatRequest = proxyRequests.find(r => r.path.includes('/chat/completions'));

      if (chatRequest) {
        console.log('✓ Intercepted request to OpenAI:', chatRequest.body);
        expect(chatRequest.body.max_tokens).toBeUndefined();
        expect(chatRequest.body.max_completion_tokens).toBe(10);
      }
    }, 30000);
  });

  describe('Ollama Parameter Transformation', () => {
    test('should accept max_tokens and pass through', async () => {
      // Clear proxy requests before test
      await clearProxyRequests();

      const client = new OpenAI({
        apiKey: apiKey,
        baseURL: `${KONG_GATEWAY_URL}/llm/v1`,  // Use unified endpoint
        defaultHeaders: {
          'apikey': apiKey
        }
      });

      const response = await client.chat.completions.create({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: 'Say hello' }],
        max_tokens: 10  // Backend router should pass through (native Ollama format)
      });

      expect(response.choices[0].message).toBeDefined();
      expect(response.usage.completion_tokens).toBeLessThanOrEqual(10);

      // Validate no transformation (already correct format for Ollama)
      const proxyRequests = await getProxyRequests();
      const chatRequest = proxyRequests.find(r => r.path.includes('/chat/completions'));

      if (chatRequest) {
        console.log('✓ Intercepted request to Ollama:', chatRequest.body);
        expect(chatRequest.body.max_tokens).toBe(10);
        expect(chatRequest.body.max_completion_tokens).toBeUndefined();
      }
    }, 30000);

    test('should accept max_completion_tokens and transform to max_tokens', async () => {
      // Clear proxy requests before test
      await clearProxyRequests();

      const response = await fetch(`${KONG_GATEWAY_URL}/llm/v1/chat/completions`, {  // Use unified endpoint
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': apiKey
        },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: [{ role: 'user', content: 'Say hello' }],
          max_completion_tokens: 10  // Backend router should transform to max_tokens
        })
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.choices[0].message).toBeDefined();
      expect(data.usage.completion_tokens).toBeLessThanOrEqual(10);

      // Validate transformation happened via proxy
      const proxyRequests = await getProxyRequests();
      const chatRequest = proxyRequests.find(r => r.path.includes('/chat/completions'));

      if (chatRequest) {
        console.log('✓ Intercepted request to Ollama:', chatRequest.body);
        expect(chatRequest.body.max_tokens).toBe(10);
        expect(chatRequest.body.max_completion_tokens).toBeUndefined();
      }
    }, 30000);
  });
});
