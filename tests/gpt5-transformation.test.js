import OpenAI from 'openai';
import { describe, test, expect, beforeAll } from '@jest/globals';

/**
 * GPT-5 Parameter Transformation Test Suite
 *
 * Tests that the lunar-gateway Kong plugin correctly handles bidirectional
 * parameter transformation between max_tokens and max_completion_tokens.
 *
 * Background:
 * - GPT-5 and o1 models require max_completion_tokens (not max_tokens)
 * - OpenAI SDK and existing apps send max_tokens
 * - Plugin transforms max_tokens → max_completion_tokens for GPT-5/o1
 * - Plugin accepts both parameters (forward compatibility)
 */
describe('GPT-5 Parameter Transformation', () => {
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

  test('should transform max_tokens to max_completion_tokens for GPT-5', async () => {
    // Simulate OpenAI SDK sending max_tokens (standard format)
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

    // Verify response
    expect(response.choices[0].message).toBeDefined();
    expect(response.usage.completion_tokens).toBeLessThanOrEqual(10);
    expect(response.usage.completion_tokens).toBeGreaterThan(0);

    console.log('✓ max_tokens → max_completion_tokens transformation works!');
  }, 30000);

  test('should accept max_completion_tokens and pass through for GPT-5', async () => {
    // Simulate GPT-5-native app sending max_completion_tokens (new format)
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
    expect(data.usage.completion_tokens).toBeGreaterThan(0);

    console.log('✓ max_completion_tokens pass-through works!');
  }, 30000);

  test('should respect token limits in both formats', async () => {
    // Test with very small limit to verify transformation preserves values
    const client = new OpenAI({
      apiKey: apiKey,
      baseURL: 'http://localhost:8000/llm',
      defaultHeaders: {
        'apikey': apiKey
      }
    });

    const response = await client.chat.completions.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Count to 100' }],
      max_tokens: 3  // Very small limit
    });

    // Should stop at 3 tokens, proving transformation preserves the value
    expect(response.usage.completion_tokens).toBeLessThanOrEqual(3);
    expect(response.choices[0].finish_reason).toBe('length');

    console.log('✓ Token limit respected:', response.usage.completion_tokens, '/ 3 tokens');
  }, 30000);
});
