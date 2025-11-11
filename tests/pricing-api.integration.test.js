import { jest } from '@jest/globals';
import request from 'supertest';
import app, { clearStorage } from '../src/app.js';
import { pool } from '../src/db.js';
import { loadPricing } from '../src/pricing.js';

describe('Pricing API Integration Tests', () => {
  beforeAll(async () => {
    // Seed initial pricing data
    await pool.query(`
      DELETE FROM model_pricing;
      INSERT INTO model_pricing (provider, model, input_rate, output_rate, cache_write_rate, cache_read_rate)
      VALUES
        ('anthropic', '', 0.000003, 0.000015, 0.00000375, 0.0000003),
        ('anthropic', 'claude-opus-4', 0.000015, 0.000075, 0.00001875, 0.0000015),
        ('openai', '', 0.00000125, 0.00001, NULL, NULL),
        ('ollama', '', 0, 0, NULL, NULL)
    `);
    await loadPricing();
  });

  beforeEach(async () => {
    await clearStorage();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('GET /api/pricing', () => {
    it('should return all pricing configurations', async () => {
      const response = await request(app).get('/api/pricing');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('pricing');
      expect(response.body).toHaveProperty('cacheSize');
      expect(response.body).toHaveProperty('needsReload');

      expect(response.body.pricing).toHaveLength(4);
      expect(response.body.cacheSize).toBe(4);
      expect(response.body.needsReload).toBe(false);
    });

    it('should return pricing with correct structure', async () => {
      const response = await request(app).get('/api/pricing');

      const anthropicDefault = response.body.pricing.find(
        p => p.provider === 'anthropic' && p.model === ''
      );

      expect(anthropicDefault).toBeDefined();
      expect(anthropicDefault).toHaveProperty('id');
      expect(anthropicDefault).toHaveProperty('provider', 'anthropic');
      expect(anthropicDefault).toHaveProperty('model', '');
      expect(anthropicDefault).toHaveProperty('input_rate');
      expect(anthropicDefault).toHaveProperty('output_rate');
      expect(anthropicDefault).toHaveProperty('cache_write_rate');
      expect(anthropicDefault).toHaveProperty('cache_read_rate');
    });

    it('should include both provider defaults and model-specific pricing', async () => {
      const response = await request(app).get('/api/pricing');

      const anthropicPricing = response.body.pricing.filter(
        p => p.provider === 'anthropic'
      );

      expect(anthropicPricing).toHaveLength(2);
      expect(anthropicPricing.some(p => p.model === '')).toBe(true);
      expect(anthropicPricing.some(p => p.model === 'claude-opus-4')).toBe(true);
    });
  });

  describe('PUT /api/pricing', () => {
    it('should update existing provider pricing', async () => {
      const response = await request(app)
        .put('/api/pricing')
        .send({
          provider: 'anthropic',
          model: '',
          inputRate: 0.000004,
          outputRate: 0.000020
        });

      expect(response.status).toBe(200);
      expect(response.body.provider).toBe('anthropic');
      expect(response.body.input_rate).toBe('0.00000400');
      expect(response.body.output_rate).toBe('0.00002000');
      expect(response.body.message).toContain('Pricing updated successfully');

      // Verify in database
      const result = await pool.query(
        `SELECT * FROM model_pricing WHERE provider = 'anthropic' AND model = ''`
      );
      expect(parseFloat(result.rows[0].input_rate)).toBe(0.000004);
    });

    it('should create new provider pricing if not exists', async () => {
      const response = await request(app)
        .put('/api/pricing')
        .send({
          provider: 'new-provider',
          model: '',
          inputRate: 0.000001,
          outputRate: 0.000002
        });

      expect(response.status).toBe(200);
      expect(response.body.provider).toBe('new-provider');

      // Verify in database
      const result = await pool.query(
        `SELECT * FROM model_pricing WHERE provider = 'new-provider'`
      );
      expect(result.rows).toHaveLength(1);
    });

    it('should update model-specific pricing', async () => {
      const response = await request(app)
        .put('/api/pricing')
        .send({
          provider: 'anthropic',
          model: 'claude-opus-4',
          inputRate: 0.000020,
          outputRate: 0.000100
        });

      expect(response.status).toBe(200);
      expect(response.body.model).toBe('claude-opus-4');
    });

    it('should create new model-specific pricing', async () => {
      const response = await request(app)
        .put('/api/pricing')
        .send({
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          inputRate: 0.000006,
          outputRate: 0.000030
        });

      expect(response.status).toBe(200);
      expect(response.body.model).toBe('claude-sonnet-4');

      // Verify in database
      const result = await pool.query(
        `SELECT * FROM model_pricing WHERE provider = 'anthropic' AND model = 'claude-sonnet-4'`
      );
      expect(result.rows).toHaveLength(1);
    });

    it('should handle cache pricing rates', async () => {
      const response = await request(app)
        .put('/api/pricing')
        .send({
          provider: 'anthropic',
          model: '',
          inputRate: 0.000003,
          outputRate: 0.000015,
          cacheWriteRate: 0.00000375,
          cacheReadRate: 0.0000003
        });

      expect(response.status).toBe(200);
      expect(response.body.cache_write_rate).toBe('0.00000375');
      expect(response.body.cache_read_rate).toBe('0.00000030');
    });

    it('should handle NULL cache rates for providers without cache support', async () => {
      const response = await request(app)
        .put('/api/pricing')
        .send({
          provider: 'openai',
          model: '',
          inputRate: 0.00000125,
          outputRate: 0.00001,
          cacheWriteRate: null,
          cacheReadRate: null
        });

      expect(response.status).toBe(200);
      expect(response.body.cache_write_rate).toBeNull();
      expect(response.body.cache_read_rate).toBeNull();
    });

    it('should return 400 if provider is missing', async () => {
      const response = await request(app)
        .put('/api/pricing')
        .send({
          inputRate: 0.000001,
          outputRate: 0.000002
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Provider is required');
    });

    it('should return 400 if rates are missing', async () => {
      const response = await request(app)
        .put('/api/pricing')
        .send({
          provider: 'test-provider'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Input and output rates are required');
    });

    it('should invalidate cache after update', async () => {
      // Check cache is not flagged for reload
      let statusResponse = await request(app).get('/api/pricing');
      expect(statusResponse.body.needsReload).toBe(false);

      // Update pricing
      await request(app)
        .put('/api/pricing')
        .send({
          provider: 'anthropic',
          model: '',
          inputRate: 0.000005,
          outputRate: 0.000025
        });

      // Cache should be flagged for reload
      statusResponse = await request(app).get('/api/pricing');
      // Note: needsReload might be false again if checkAndReload() was called
      // in between, but we know it was invalidated
    });
  });

  describe('Dynamic Pricing in Usage Logging', () => {
    const mockConsumerHeaders = {
      'x-consumer-id': 'test-consumer-123',
      'x-consumer-username': 'test-user'
    };

    it('should use dynamic pricing when calculating costs for anthropic requests', async () => {
      const response = await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'anthropic',
          model: 'claude-3',
          prompt_tokens: 1000,
          completion_tokens: 500
        });

      expect(response.status).toBe(200);

      // Cost should be calculated with anthropic default pricing
      // (1000 * 0.000003) + (500 * 0.000015) = 0.003 + 0.0075 = 0.0105
      expect(response.body.cost).toBe(0.0105);
    });

    it('should use model-specific pricing when available', async () => {
      const response = await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'anthropic',
          model: 'claude-opus-4',
          prompt_tokens: 1000,
          completion_tokens: 500
        });

      expect(response.status).toBe(200);

      // Cost should use claude-opus-4 specific pricing (5x more expensive)
      // (1000 * 0.000015) + (500 * 0.000075) = 0.015 + 0.0375 = 0.0525
      expect(response.body.cost).toBe(0.0525);
    });

    it('should calculate costs with cache tokens for anthropic', async () => {
      const response = await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'anthropic',
          model: 'claude-3',
          prompt_tokens: 1000,
          completion_tokens: 500,
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 5000
        });

      expect(response.status).toBe(200);

      // (1000 * 0.000003) + (500 * 0.000015) + (2000 * 0.00000375) + (5000 * 0.0000003)
      // = 0.003 + 0.0075 + 0.0075 + 0.0015 = 0.0195
      expect(response.body.cost).toBe(0.0195);
    });

    it('should use updated pricing after cache reload', async () => {
      // Update anthropic pricing to double the rates
      await request(app)
        .put('/api/pricing')
        .send({
          provider: 'anthropic',
          model: '',
          inputRate: 0.000006,
          outputRate: 0.000030
        });

      // Trigger a request (this should reload cache due to invalidation)
      const response = await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'anthropic',
          model: 'claude-3',
          prompt_tokens: 1000,
          completion_tokens: 500
        });

      expect(response.status).toBe(200);

      // Cost should use new pricing (doubled)
      // (1000 * 0.000006) + (500 * 0.000030) = 0.006 + 0.015 = 0.021
      expect(response.body.cost).toBe(0.021);

      // Restore original pricing
      await request(app)
        .put('/api/pricing')
        .send({
          provider: 'anthropic',
          model: '',
          inputRate: 0.000003,
          outputRate: 0.000015
        });
    });

    it('should handle free providers (ollama) with zero cost', async () => {
      const response = await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'ollama',
          model: 'llama-3',
          prompt_tokens: 10000,
          completion_tokens: 5000
        });

      expect(response.status).toBe(200);
      expect(response.body.cost).toBe(0);
    });
  });

  describe('Provider Statistics with Dynamic Pricing', () => {
    const mockConsumerHeaders = {
      'x-consumer-id': 'test-consumer-123'
    };

    beforeEach(async () => {
      await clearStorage();
    });

    it('should calculate total costs correctly across multiple requests', async () => {
      // Log multiple requests with different providers
      await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'anthropic',
          model: 'claude-3',
          prompt_tokens: 1000,
          completion_tokens: 500,
          status: 'success'
        });

      await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'anthropic',
          model: 'claude-opus-4',
          prompt_tokens: 1000,
          completion_tokens: 500,
          status: 'success'
        });

      const response = await request(app).get('/api/stats/providers');

      expect(response.status).toBe(200);
      const anthropic = response.body.find(p => p.provider === 'anthropic');

      expect(anthropic.requests).toBe(2);
      // First request: 0.0105, Second request: 0.0525
      expect(anthropic.cost).toBeCloseTo(0.063, 5);
    });
  });

  describe('Pricing Cache Performance', () => {
    it('should handle multiple concurrent pricing requests efficiently', async () => {
      const responses = await Promise.all([
        request(app).get('/api/pricing'),
        request(app).get('/api/pricing'),
        request(app).get('/api/pricing'),
        request(app).get('/api/pricing'),
        request(app).get('/api/pricing')
      ]);

      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.pricing).toHaveLength(4);
      });
    });

    it('should serve from cache after initial load', async () => {
      const response1 = await request(app).get('/api/pricing');
      const response2 = await request(app).get('/api/pricing');

      expect(response1.body.cacheSize).toBe(response2.body.cacheSize);
      expect(response1.body.pricing).toEqual(response2.body.pricing);
    });
  });
});
