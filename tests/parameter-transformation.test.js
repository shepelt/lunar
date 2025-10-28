import OpenAI from 'openai';
import { describe, test, expect, beforeAll } from '@jest/globals';

describe('Parameter Transformation through Lunar Gateway', () => {
  let apiKey;

  beforeAll(async () => {
    // Fetch API key from Kong Admin API
    try {
      const consumerRes = await fetch('http://localhost:8001/consumers/test/key-auth');
      const consumerData = await consumerRes.json();
      apiKey = consumerData.data?.[0]?.key;

      if (!apiKey) {
        throw new Error('Failed to fetch API key from Kong');
      }

      console.log('✓ API key fetched from Kong:', apiKey);
    } catch (error) {
      console.error('Failed to fetch API key:', error.message);
      throw error;
    }
  });

  describe('GPT-5 Parameter Transformation', () => {
    test('should accept max_tokens and transform to max_completion_tokens', async () => {
      const client = new OpenAI({
        apiKey: apiKey,
        baseURL: 'http://localhost:8000/llm',
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
    }, 30000);

    test('should accept max_completion_tokens and pass through', async () => {
      const response = await fetch('http://localhost:8000/llm/v1/chat/completions', {
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
    }, 30000);
  });

  describe('Ollama Parameter Transformation', () => {
    test('should accept max_tokens and pass through', async () => {
      const client = new OpenAI({
        apiKey: apiKey,
        baseURL: 'http://localhost:8000/local-llm',
        defaultHeaders: {
          'apikey': apiKey
        }
      });

      const response = await client.chat.completions.create({
        model: 'gpt-oss:120b',
        messages: [{ role: 'user', content: 'Say hello' }],
        max_tokens: 10  // Plugin should pass through (native Ollama format)
      });

      expect(response.choices[0].message).toBeDefined();
      expect(response.usage.completion_tokens).toBeLessThanOrEqual(10);
    }, 30000);

    test('should accept max_completion_tokens and transform to max_tokens', async () => {
      const response = await fetch('http://localhost:8000/local-llm/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': apiKey
        },
        body: JSON.stringify({
          model: 'gpt-oss:120b',
          messages: [{ role: 'user', content: 'Say hello' }],
          max_completion_tokens: 10  // Plugin should transform to max_tokens
        })
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.choices[0].message).toBeDefined();
      expect(data.usage.completion_tokens).toBeLessThanOrEqual(10);
    }, 30000);
  });

  describe('Mixed Scenarios', () => {
    test('GPT-4 should keep max_tokens unchanged', async () => {
      const client = new OpenAI({
        apiKey: apiKey,
        baseURL: 'http://localhost:8000/llm',
        defaultHeaders: {
          'apikey': apiKey
        }
      });

      // Note: This test assumes a GPT-4 route exists
      // If not, this test can be skipped or removed
      const response = await client.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Say hello' }],
        max_tokens: 10
      });

      expect(response.choices[0].message).toBeDefined();
      expect(response.usage.completion_tokens).toBeLessThanOrEqual(10);
    }, 30000);
  });
});
