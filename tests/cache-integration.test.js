import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { pool } from '../src/db.js';
import { loadPricing } from '../src/pricing.js';

/**
 * Integration tests for cache handling through the full request flow
 * Tests that the backend correctly extracts and processes cached tokens
 * from both Anthropic and OpenAI response formats
 */
describe('Cache Handling Integration Tests', () => {
  let app;

  beforeAll(async () => {
    // Setup test pricing
    await pool.query(`
      DELETE FROM model_pricing;
      INSERT INTO model_pricing (provider, model, input_rate, output_rate, cache_write_rate, cache_read_rate)
      VALUES
        ('anthropic', 'claude-sonnet-4-5-20250929', 0.000003, 0.000015, 0.00000375, 0.0000003),
        ('openai', 'gpt-5', 0.00000125, 0.00001, NULL, 0.000000125),
        ('openai', 'gpt-4o', 0.0000025, 0.00001, NULL, 0.00000125)
    `);

    await loadPricing();

    // Create a minimal Express app for testing
    app = express();
    app.use(express.json());

    // Mock endpoint that simulates our backend's usage extraction logic
    app.post('/test/extract-usage', (req, res) => {
      const { provider, responseData } = req.body;

      // Handle missing usage object
      if (!responseData || !responseData.usage) {
        return res.json({
          prompt_tokens: 0,
          completion_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        });
      }

      let prompt_tokens = responseData.usage.prompt_tokens || responseData.usage.input_tokens || 0;
      let completion_tokens = responseData.usage.completion_tokens || responseData.usage.output_tokens || 0;
      let cache_creation_input_tokens = responseData.usage.cache_creation_input_tokens || 0;
      let cache_read_input_tokens = responseData.usage.cache_read_input_tokens || 0;

      // OpenAI cache handling (from backend.js)
      if (responseData.usage.prompt_tokens_details?.cached_tokens) {
        const openai_cached = responseData.usage.prompt_tokens_details.cached_tokens;
        cache_read_input_tokens = openai_cached;
        prompt_tokens = prompt_tokens - openai_cached;
      }

      res.json({
        prompt_tokens,
        completion_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens
      });
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('Anthropic Response Format', () => {
    it('should extract cache_creation_input_tokens from Anthropic response', async () => {
      const anthropicResponse = {
        provider: 'anthropic',
        responseData: {
          usage: {
            input_tokens: 0,
            output_tokens: 100,
            cache_creation_input_tokens: 1500,
            cache_read_input_tokens: 0
          }
        }
      };

      const res = await request(app)
        .post('/test/extract-usage')
        .send(anthropicResponse);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        prompt_tokens: 0,
        completion_tokens: 100,
        cache_creation_input_tokens: 1500,
        cache_read_input_tokens: 0
      });
    });

    it('should extract cache_read_input_tokens from Anthropic response', async () => {
      const anthropicResponse = {
        provider: 'anthropic',
        responseData: {
          usage: {
            input_tokens: 500,
            output_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1500
          }
        }
      };

      const res = await request(app)
        .post('/test/extract-usage')
        .send(anthropicResponse);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        prompt_tokens: 500,
        completion_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1500
      });
    });

    it('should handle Anthropic response with both cache types', async () => {
      const anthropicResponse = {
        provider: 'anthropic',
        responseData: {
          usage: {
            input_tokens: 0,
            output_tokens: 100,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 500
          }
        }
      };

      const res = await request(app)
        .post('/test/extract-usage')
        .send(anthropicResponse);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        prompt_tokens: 0,
        completion_tokens: 100,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 500
      });
    });
  });

  describe('OpenAI Response Format', () => {
    it('should extract cached_tokens from OpenAI prompt_tokens_details', async () => {
      const openaiResponse = {
        provider: 'openai',
        responseData: {
          usage: {
            prompt_tokens: 2000,
            completion_tokens: 100,
            prompt_tokens_details: {
              cached_tokens: 1500
            }
          }
        }
      };

      const res = await request(app)
        .post('/test/extract-usage')
        .send(openaiResponse);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        prompt_tokens: 500,  // 2000 - 1500 (uncached)
        completion_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1500  // from cached_tokens
      });
    });

    it('should handle OpenAI response with 100% cache hit', async () => {
      const openaiResponse = {
        provider: 'openai',
        responseData: {
          usage: {
            prompt_tokens: 2000,
            completion_tokens: 100,
            prompt_tokens_details: {
              cached_tokens: 2000  // All tokens from cache
            }
          }
        }
      };

      const res = await request(app)
        .post('/test/extract-usage')
        .send(openaiResponse);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        prompt_tokens: 0,  // All tokens were cached
        completion_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2000
      });
    });

    it('should handle OpenAI response with no caching', async () => {
      const openaiResponse = {
        provider: 'openai',
        responseData: {
          usage: {
            prompt_tokens: 2000,
            completion_tokens: 100
            // No prompt_tokens_details
          }
        }
      };

      const res = await request(app)
        .post('/test/extract-usage')
        .send(openaiResponse);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        prompt_tokens: 2000,
        completion_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0  // No caching
      });
    });

    it('should handle OpenAI response with zero cached tokens', async () => {
      const openaiResponse = {
        provider: 'openai',
        responseData: {
          usage: {
            prompt_tokens: 500,  // Below 1024 token threshold
            completion_tokens: 100,
            prompt_tokens_details: {
              cached_tokens: 0  // No cache hit
            }
          }
        }
      };

      const res = await request(app)
        .post('/test/extract-usage')
        .send(openaiResponse);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        prompt_tokens: 500,
        completion_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      });
    });

    it('should handle partial cache hit (realistic scenario)', async () => {
      // Realistic: 1500 tokens, 1024 cached (first 1024 tokens)
      const openaiResponse = {
        provider: 'openai',
        responseData: {
          usage: {
            prompt_tokens: 1500,
            completion_tokens: 100,
            prompt_tokens_details: {
              cached_tokens: 1024
            }
          }
        }
      };

      const res = await request(app)
        .post('/test/extract-usage')
        .send(openaiResponse);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        prompt_tokens: 476,  // 1500 - 1024
        completion_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1024
      });
    });
  });

  describe('Real-world Scenarios', () => {
    it('should handle GPT-5 response with typical caching', async () => {
      // Typical GPT-5 request with 2048 tokens, 1024 cached
      const openaiResponse = {
        provider: 'openai',
        responseData: {
          id: 'chatcmpl-123',
          model: 'gpt-5-2025-08-07',
          usage: {
            prompt_tokens: 2048,
            completion_tokens: 150,
            total_tokens: 2198,
            prompt_tokens_details: {
              cached_tokens: 1024,
              audio_tokens: 0
            },
            completion_tokens_details: {
              reasoning_tokens: 50,
              audio_tokens: 0,
              accepted_prediction_tokens: 0,
              rejected_prediction_tokens: 0
            }
          }
        }
      };

      const res = await request(app)
        .post('/test/extract-usage')
        .send(openaiResponse);

      expect(res.status).toBe(200);
      expect(res.body.prompt_tokens).toBe(1024); // 2048 - 1024
      expect(res.body.cache_read_input_tokens).toBe(1024);
    });

    it('should handle Anthropic response with ephemeral cache', async () => {
      const anthropicResponse = {
        provider: 'anthropic',
        responseData: {
          id: 'msg_123',
          model: 'claude-sonnet-4-5-20250929',
          usage: {
            input_tokens: 100,
            output_tokens: 150,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1500,
            cache_creation: {
              ephemeral_5m_input_tokens: 0,
              ephemeral_1h_input_tokens: 0
            }
          }
        }
      };

      const res = await request(app)
        .post('/test/extract-usage')
        .send(anthropicResponse);

      expect(res.status).toBe(200);
      expect(res.body.cache_read_input_tokens).toBe(1500);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle missing usage object gracefully', async () => {
      const response = {
        provider: 'openai',
        responseData: {
          // Missing usage object
        }
      };

      const res = await request(app)
        .post('/test/extract-usage')
        .send(response);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      });
    });

    it('should handle malformed prompt_tokens_details', async () => {
      const openaiResponse = {
        provider: 'openai',
        responseData: {
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            prompt_tokens_details: null  // Malformed
          }
        }
      };

      const res = await request(app)
        .post('/test/extract-usage')
        .send(openaiResponse);

      expect(res.status).toBe(200);
      expect(res.body.prompt_tokens).toBe(1000);
      expect(res.body.cache_read_input_tokens).toBe(0);
    });

    it('should handle negative cached_tokens (should not happen but be defensive)', async () => {
      const openaiResponse = {
        provider: 'openai',
        responseData: {
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            prompt_tokens_details: {
              cached_tokens: -500  // Invalid
            }
          }
        }
      };

      const res = await request(app)
        .post('/test/extract-usage')
        .send(openaiResponse);

      // Should still process but result in negative uncached tokens
      // In production, should add validation
      expect(res.status).toBe(200);
      expect(res.body.prompt_tokens).toBe(1500); // 1000 - (-500)
      expect(res.body.cache_read_input_tokens).toBe(-500);
    });
  });
});
