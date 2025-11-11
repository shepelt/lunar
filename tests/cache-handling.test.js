import { jest } from '@jest/globals';
import { pool } from '../src/db.js';
import { loadPricing, getPricing, calculateCost } from '../src/pricing.js';

/**
 * Unit tests for cache handling logic
 * Tests both Anthropic and OpenAI cache token processing
 */
describe('Cache Token Handling', () => {
  beforeAll(async () => {
    // Setup test pricing data
    await pool.query(`
      DELETE FROM model_pricing;
      INSERT INTO model_pricing (provider, model, input_rate, output_rate, cache_write_rate, cache_read_rate)
      VALUES
        -- Anthropic with cache write and read rates
        ('anthropic', 'claude-sonnet-4-5-20250929', 0.000003, 0.000015, 0.00000375, 0.0000003),
        -- OpenAI with only cache read rate (no write charge)
        ('openai', 'gpt-5', 0.00000125, 0.00001, NULL, 0.000000125),
        ('openai', 'gpt-4o', 0.0000025, 0.00001, NULL, 0.00000125)
    `);

    await loadPricing();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('Anthropic Cache Handling', () => {
    const anthropicPricing = () => getPricing('anthropic', 'claude-sonnet-4-5-20250929');

    it('should calculate cost with cache_creation_input_tokens', () => {
      const tokens = {
        prompt_tokens: 0,
        completion_tokens: 100,
        cache_creation_input_tokens: 1500, // Writing to cache
        cache_read_input_tokens: 0
      };

      const cost = calculateCost(tokens, anthropicPricing());

      // (0 * 0.000003) + (100 * 0.000015) + (1500 * 0.00000375) + (0 * 0.0000003)
      // = 0 + 0.0015 + 0.005625 + 0 = 0.007125
      expect(cost).toBeCloseTo(0.007125, 6);
    });

    it('should calculate cost with cache_read_input_tokens', () => {
      const tokens = {
        prompt_tokens: 500,
        completion_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1500 // Reading from cache
      };

      const cost = calculateCost(tokens, anthropicPricing());

      // (500 * 0.000003) + (100 * 0.000015) + (0 * 0.00000375) + (1500 * 0.0000003)
      // = 0.0015 + 0.0015 + 0 + 0.00045 = 0.00345
      expect(cost).toBeCloseTo(0.00345, 6);
    });

    it('should calculate cost with both cache write and read', () => {
      const tokens = {
        prompt_tokens: 0,
        completion_tokens: 100,
        cache_creation_input_tokens: 2000, // Writing to cache
        cache_read_input_tokens: 500       // Reading from cache
      };

      const cost = calculateCost(tokens, anthropicPricing());

      // (0 * 0.000003) + (100 * 0.000015) + (2000 * 0.00000375) + (500 * 0.0000003)
      // = 0 + 0.0015 + 0.0075 + 0.00015 = 0.00915
      expect(cost).toBeCloseTo(0.00915, 6);
    });

    it('should verify Anthropic cache write is 25% markup', () => {
      const pricing = anthropicPricing();

      // Cache write should be input_rate * 1.25
      const expectedCacheWrite = pricing.inputRate * 1.25;
      expect(pricing.cacheWriteRate).toBeCloseTo(expectedCacheWrite, 10);
    });

    it('should verify Anthropic cache read is 90% discount', () => {
      const pricing = anthropicPricing();

      // Cache read should be input_rate * 0.1 (90% off)
      const expectedCacheRead = pricing.inputRate * 0.1;
      expect(pricing.cacheReadRate).toBeCloseTo(expectedCacheRead, 10);
    });
  });

  describe('OpenAI Cache Handling', () => {
    describe('GPT-5 Model', () => {
      const gpt5Pricing = () => getPricing('openai', 'gpt-5');

      it('should have NULL cache_write_rate (no write charge)', () => {
        const pricing = gpt5Pricing();
        expect(pricing.cacheWriteRate).toBe(0); // NULL becomes 0 in our code
      });

      it('should calculate cost with OpenAI cached tokens (simulated)', () => {
        // Simulating what backend.js does when it detects OpenAI cached tokens
        // Original: prompt_tokens=2000, cached_tokens=1500
        // After processing: prompt_tokens=500, cache_read_input_tokens=1500
        const tokens = {
          prompt_tokens: 500,          // uncached tokens (2000 - 1500)
          completion_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1500 // from prompt_tokens_details.cached_tokens
        };

        const cost = calculateCost(tokens, gpt5Pricing());

        // (500 * 0.00000125) + (100 * 0.00001) + (0 * 0) + (1500 * 0.000000125)
        // = 0.000625 + 0.001 + 0 + 0.0001875 = 0.0018125
        expect(cost).toBeCloseTo(0.0018125, 7);
      });

      it('should calculate cost without caching', () => {
        const tokens = {
          prompt_tokens: 2000,
          completion_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        };

        const cost = calculateCost(tokens, gpt5Pricing());

        // (2000 * 0.00000125) + (100 * 0.00001) + 0 + 0
        // = 0.0025 + 0.001 = 0.0035
        expect(cost).toBeCloseTo(0.0035, 6);
      });

      it('should verify GPT-5 cache read is 90% discount', () => {
        const pricing = gpt5Pricing();

        // Cache read should be input_rate * 0.1 (90% off)
        const expectedCacheRead = pricing.inputRate * 0.1;
        expect(pricing.cacheReadRate).toBeCloseTo(expectedCacheRead, 10);
      });

      it('should verify no cache write charge', () => {
        const pricing = gpt5Pricing();
        const tokens = {
          prompt_tokens: 0,
          completion_tokens: 0,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 0
        };

        const cost = calculateCost(tokens, pricing);

        // Should be 0 because OpenAI has no cache write charge
        expect(cost).toBe(0);
      });
    });

    describe('GPT-4o Model', () => {
      const gpt4oPricing = () => getPricing('openai', 'gpt-4o');

      it('should calculate cost with cached tokens', () => {
        // Simulating: prompt_tokens=1000, cached_tokens=800
        // After processing: prompt_tokens=200, cache_read_input_tokens=800
        const tokens = {
          prompt_tokens: 200,
          completion_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 800
        };

        const cost = calculateCost(tokens, gpt4oPricing());

        // (200 * 0.0000025) + (50 * 0.00001) + (0 * 0) + (800 * 0.00000125)
        // = 0.0005 + 0.0005 + 0 + 0.001 = 0.002
        expect(cost).toBeCloseTo(0.002, 6);
      });
    });
  });

  describe('Cost Comparison: With vs Without Caching', () => {
    it('should show significant savings with Anthropic cache reads', () => {
      const pricing = getPricing('anthropic', 'claude-sonnet-4-5-20250929');

      // Without caching
      const noCacheTokens = {
        prompt_tokens: 2000,
        completion_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      };

      // With caching (90% of tokens cached)
      const cachedTokens = {
        prompt_tokens: 200,
        completion_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1800
      };

      const noCacheCost = calculateCost(noCacheTokens, pricing);
      const cachedCost = calculateCost(cachedTokens, pricing);

      // Cached should be significantly cheaper
      // With 90% of input tokens cached, expect ~30-40% total savings (output cost remains constant)
      expect(cachedCost).toBeLessThan(noCacheCost * 0.5); // At least 50% savings
    });

    it('should show significant savings with OpenAI cache reads', () => {
      const pricing = getPricing('openai', 'gpt-5');

      // Without caching
      const noCacheTokens = {
        prompt_tokens: 2000,
        completion_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      };

      // With caching (90% of tokens cached)
      const cachedTokens = {
        prompt_tokens: 200,
        completion_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1800
      };

      const noCacheCost = calculateCost(noCacheTokens, pricing);
      const cachedCost = calculateCost(cachedTokens, pricing);

      // Cached should be significantly cheaper
      // With 90% of input tokens cached, expect ~30-40% total savings (output cost remains constant)
      expect(cachedCost).toBeLessThan(noCacheCost * 0.5); // At least 50% savings
    });
  });

  describe('Edge Cases', () => {
    it('should handle 100% cached tokens (OpenAI)', () => {
      const pricing = getPricing('openai', 'gpt-5');
      const tokens = {
        prompt_tokens: 0,           // All tokens were cached
        completion_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2000 // All from cache
      };

      const cost = calculateCost(tokens, pricing);

      // Only output + cache read costs
      // (0 * input) + (100 * 0.00001) + (0 * 0) + (2000 * 0.000000125)
      // = 0 + 0.001 + 0 + 0.00025 = 0.00125
      expect(cost).toBeCloseTo(0.00125, 6);
    });

    it('should handle very small cache hits (OpenAI)', () => {
      const pricing = getPricing('openai', 'gpt-5');
      const tokens = {
        prompt_tokens: 1990,
        completion_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10   // Only 10 tokens cached
      };

      const cost = calculateCost(tokens, pricing);

      // (1990 * 0.00000125) + (100 * 0.00001) + 0 + (10 * 0.000000125)
      // = 0.0024875 + 0.001 + 0 + 0.00000125 = 0.00348875
      expect(cost).toBeCloseTo(0.00348875, 8);
    });

    it('should handle mixed Anthropic cache write and read', () => {
      const pricing = getPricing('anthropic', 'claude-sonnet-4-5-20250929');
      const tokens = {
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 500
      };

      const cost = calculateCost(tokens, pricing);

      // (100 * 0.000003) + (50 * 0.000015) + (1000 * 0.00000375) + (500 * 0.0000003)
      // = 0.0003 + 0.00075 + 0.00375 + 0.00015 = 0.00495
      expect(cost).toBeCloseTo(0.00495, 6);
    });
  });
});
