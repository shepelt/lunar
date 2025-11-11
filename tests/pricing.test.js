import { jest } from '@jest/globals';
import { pool } from '../src/db.js';
import {
  loadPricing,
  getPricing,
  calculateCost,
  invalidateCache,
  checkAndReload,
  getCacheSize,
  needsReloadFlag
} from '../src/pricing.js';

describe('Dynamic Pricing Module', () => {
  beforeAll(async () => {
    // Ensure pricing table exists and has test data
    await pool.query(`
      DELETE FROM model_pricing;
      INSERT INTO model_pricing (provider, model, input_rate, output_rate, cache_write_rate, cache_read_rate)
      VALUES
        ('anthropic', '', 0.000003, 0.000015, 0.00000375, 0.0000003),
        ('anthropic', 'claude-opus-4', 0.000015, 0.000075, 0.00001875, 0.0000015),
        ('openai', '', 0.00000125, 0.00001, NULL, NULL),
        ('ollama', '', 0, 0, NULL, NULL)
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('loadPricing()', () => {
    it('should load all pricing configs from database into memory', async () => {
      const count = await loadPricing();

      expect(count).toBe(4);
      expect(getCacheSize()).toBe(4);
    });

    it('should clear needsReload flag after loading', async () => {
      invalidateCache();
      expect(needsReloadFlag()).toBe(true);

      await loadPricing();
      expect(needsReloadFlag()).toBe(false);
    });

    it('should handle empty string model as provider default', async () => {
      await loadPricing();

      // Should be able to get anthropic default pricing (empty string model)
      const pricing = getPricing('anthropic');
      expect(pricing.provider).toBe('anthropic');
      expect(pricing.model).toBeNull();
    });
  });

  describe('getPricing()', () => {
    beforeEach(async () => {
      await loadPricing();
    });

    it('should return specific model pricing when available', async () => {
      const pricing = getPricing('anthropic', 'claude-opus-4');

      expect(pricing.provider).toBe('anthropic');
      expect(pricing.model).toBe('claude-opus-4');
      expect(pricing.inputRate).toBe(0.000015);
      expect(pricing.outputRate).toBe(0.000075);
      expect(pricing.cacheWriteRate).toBe(0.00001875);
      expect(pricing.cacheReadRate).toBe(0.0000015);
    });

    it('should fall back to provider default when specific model not found', async () => {
      const pricing = getPricing('anthropic', 'unknown-model');

      expect(pricing.provider).toBe('anthropic');
      expect(pricing.model).toBeNull(); // Falls back to provider default
      expect(pricing.inputRate).toBe(0.000003);
      expect(pricing.outputRate).toBe(0.000015);
    });

    it('should return provider default when model is null', async () => {
      const pricing = getPricing('anthropic', null);

      expect(pricing.provider).toBe('anthropic');
      expect(pricing.model).toBeNull();
      expect(pricing.inputRate).toBe(0.000003);
    });

    it('should return provider default when model is empty string', async () => {
      const pricing = getPricing('anthropic', '');

      expect(pricing.provider).toBe('anthropic');
      expect(pricing.model).toBeNull();
      expect(pricing.inputRate).toBe(0.000003);
    });

    it('should throw error when provider is not found', () => {
      expect(() => {
        getPricing('invalid-provider');
      }).toThrow('No pricing found for provider: invalid-provider');
    });

    it('should throw error when provider is missing', () => {
      expect(() => {
        getPricing(null);
      }).toThrow('Provider is required');
    });

    it('should handle providers without cache pricing', async () => {
      const pricing = getPricing('openai');

      expect(pricing.provider).toBe('openai');
      expect(pricing.inputRate).toBe(0.00000125);
      expect(pricing.outputRate).toBe(0.00001);
      expect(pricing.cacheWriteRate).toBe(0);
      expect(pricing.cacheReadRate).toBe(0);
    });

    it('should handle providers with zero pricing (ollama)', async () => {
      const pricing = getPricing('ollama');

      expect(pricing.provider).toBe('ollama');
      expect(pricing.inputRate).toBe(0);
      expect(pricing.outputRate).toBe(0);
    });
  });

  describe('calculateCost()', () => {
    let anthropicPricing;
    let openaiPricing;

    beforeEach(async () => {
      await loadPricing();
      anthropicPricing = getPricing('anthropic');
      openaiPricing = getPricing('openai');
    });

    it('should calculate cost for basic input/output tokens', () => {
      const tokens = {
        prompt_tokens: 1000,
        completion_tokens: 500
      };

      const cost = calculateCost(tokens, anthropicPricing);

      // (1000 * 0.000003) + (500 * 0.000015) = 0.003 + 0.0075 = 0.0105
      expect(cost).toBeCloseTo(0.0105, 5);
    });

    it('should calculate cost including cache creation tokens', () => {
      const tokens = {
        prompt_tokens: 1000,
        completion_tokens: 500,
        cache_creation_input_tokens: 2000
      };

      const cost = calculateCost(tokens, anthropicPricing);

      // (1000 * 0.000003) + (500 * 0.000015) + (2000 * 0.00000375)
      // = 0.003 + 0.0075 + 0.0075 = 0.018
      expect(cost).toBeCloseTo(0.018, 5);
    });

    it('should calculate cost including cache read tokens', () => {
      const tokens = {
        prompt_tokens: 1000,
        completion_tokens: 500,
        cache_read_input_tokens: 5000
      };

      const cost = calculateCost(tokens, anthropicPricing);

      // (1000 * 0.000003) + (500 * 0.000015) + (5000 * 0.0000003)
      // = 0.003 + 0.0075 + 0.0015 = 0.012
      expect(cost).toBeCloseTo(0.012, 5);
    });

    it('should calculate cost with all token types', () => {
      const tokens = {
        prompt_tokens: 1000,
        completion_tokens: 500,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 5000
      };

      const cost = calculateCost(tokens, anthropicPricing);

      // (1000 * 0.000003) + (500 * 0.000015) + (2000 * 0.00000375) + (5000 * 0.0000003)
      // = 0.003 + 0.0075 + 0.0075 + 0.0015 = 0.0195
      expect(cost).toBeCloseTo(0.0195, 5);
    });

    it('should handle missing token values as zero', () => {
      const tokens = {
        prompt_tokens: 1000
        // completion_tokens missing
      };

      const cost = calculateCost(tokens, anthropicPricing);

      // Only prompt tokens counted
      expect(cost).toBeCloseTo(0.003, 5);
    });

    it('should calculate zero cost for providers with null cache rates', () => {
      const tokens = {
        prompt_tokens: 1000,
        completion_tokens: 500,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 5000
      };

      const cost = calculateCost(tokens, openaiPricing);

      // (1000 * 0.00000125) + (500 * 0.00001) + (2000 * 0) + (5000 * 0)
      // = 0.00125 + 0.005 + 0 + 0 = 0.00625
      expect(cost).toBeCloseTo(0.00625, 5);
    });

    it('should return zero cost for free providers (ollama)', () => {
      const ollamaPricing = getPricing('ollama');
      const tokens = {
        prompt_tokens: 10000,
        completion_tokens: 5000
      };

      const cost = calculateCost(tokens, ollamaPricing);

      expect(cost).toBe(0);
    });
  });

  describe('invalidateCache() and checkAndReload()', () => {
    beforeEach(async () => {
      await loadPricing();
    });

    it('should set needsReload flag when cache is invalidated', () => {
      expect(needsReloadFlag()).toBe(false);

      invalidateCache();

      expect(needsReloadFlag()).toBe(true);
    });

    it('should reload pricing when checkAndReload is called with needsReload=true', async () => {
      // Add a new pricing entry
      await pool.query(`
        INSERT INTO model_pricing (provider, model, input_rate, output_rate)
        VALUES ('test-provider', '', 0.00001, 0.00002)
      `);

      invalidateCache();
      expect(getCacheSize()).toBe(4); // Still old cache

      await checkAndReload();

      expect(needsReloadFlag()).toBe(false);
      expect(getCacheSize()).toBe(5); // Now includes new entry

      // Should be able to get new pricing
      const pricing = getPricing('test-provider');
      expect(pricing.inputRate).toBe(0.00001);

      // Cleanup
      await pool.query(`DELETE FROM model_pricing WHERE provider = 'test-provider'`);
    });

    it('should not reload if needsReload is false', async () => {
      const sizeBefore = getCacheSize();

      await checkAndReload();

      const sizeAfter = getCacheSize();
      expect(sizeAfter).toBe(sizeBefore);
    });
  });

  describe('Cache behavior with pricing updates', () => {
    it('should reflect updated pricing after invalidation and reload', async () => {
      await loadPricing();

      const oldPricing = getPricing('anthropic');
      expect(oldPricing.inputRate).toBe(0.000003);

      // Update pricing in database
      await pool.query(`
        UPDATE model_pricing
        SET input_rate = 0.000005
        WHERE provider = 'anthropic' AND model = ''
      `);

      // Still using old pricing from cache
      const cachedPricing = getPricing('anthropic');
      expect(cachedPricing.inputRate).toBe(0.000003);

      // Invalidate and reload
      invalidateCache();
      await checkAndReload();

      // Now using new pricing
      const newPricing = getPricing('anthropic');
      expect(newPricing.inputRate).toBe(0.000005);

      // Cleanup - restore original pricing
      await pool.query(`
        UPDATE model_pricing
        SET input_rate = 0.000003
        WHERE provider = 'anthropic' AND model = ''
      `);
    });
  });

  describe('Edge cases', () => {
    beforeEach(async () => {
      await loadPricing();
    });

    it('should handle very large token counts', () => {
      const pricing = getPricing('anthropic');
      const tokens = {
        prompt_tokens: 1000000,
        completion_tokens: 500000
      };

      const cost = calculateCost(tokens, pricing);

      // Should calculate correctly without overflow
      expect(cost).toBe(10.5);
    });

    it('should handle zero token counts', () => {
      const pricing = getPricing('anthropic');
      const tokens = {
        prompt_tokens: 0,
        completion_tokens: 0
      };

      const cost = calculateCost(tokens, pricing);

      expect(cost).toBe(0);
    });

    it('should maintain pricing precision for very small costs', () => {
      const pricing = getPricing('anthropic');
      const tokens = {
        prompt_tokens: 1,
        completion_tokens: 1
      };

      const cost = calculateCost(tokens, pricing);

      // (1 * 0.000003) + (1 * 0.000015) = 0.000018
      expect(cost).toBeCloseTo(0.000018, 7);
    });
  });

  describe('Model-specific pricing priority', () => {
    beforeEach(async () => {
      await loadPricing();
    });

    it('should prioritize specific model pricing over provider default', () => {
      // Get specific model pricing
      const opusPricing = getPricing('anthropic', 'claude-opus-4');
      expect(opusPricing.inputRate).toBe(0.000015);

      // Get provider default
      const defaultPricing = getPricing('anthropic');
      expect(defaultPricing.inputRate).toBe(0.000003);

      // Specific model is 5x more expensive
      expect(opusPricing.inputRate).toBe(defaultPricing.inputRate * 5);
    });

    it('should correctly calculate costs for different models of same provider', () => {
      const defaultPricing = getPricing('anthropic');
      const opusPricing = getPricing('anthropic', 'claude-opus-4');

      const tokens = {
        prompt_tokens: 1000,
        completion_tokens: 500
      };

      const defaultCost = calculateCost(tokens, defaultPricing);
      const opusCost = calculateCost(tokens, opusPricing);

      // Opus should be more expensive
      expect(opusCost).toBeGreaterThan(defaultCost);
      expect(opusCost).toBeCloseTo(defaultCost * 5, 5);
    });
  });
});
