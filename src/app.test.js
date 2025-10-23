import { jest } from '@jest/globals';
import request from 'supertest';
import app, { clearStorage } from './app.js';
import { pool } from './db.js';

describe('Lunar Gateway API (Kong Consumer-based)', () => {
  const mockConsumerHeaders = {
    'x-consumer-id': 'test-consumer-123',
    'x-consumer-username': 'test-user',
    'x-consumer-custom-id': 'user-001'
  };

  beforeEach(async () => {
    // Clear storage before each test
    await clearStorage();
  });

  afterAll(async () => {
    // Close database connection
    await pool.end();
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
    });
  });

  describe('GET /api/quota-check', () => {
    it('should return quota for new consumer with default quota', async () => {
      const response = await request(app)
        .get('/api/quota-check')
        .set(mockConsumerHeaders);

      expect(response.status).toBe(200);
      expect(response.body.has_quota).toBe(true);
      expect(response.body.quota).toBe(100);
      expect(response.body.remaining).toBe(100);
    });

    it('should return 401 without consumer headers', async () => {
      const response = await request(app).get('/api/quota-check');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('No consumer information');
    });

    it('should return no quota when quota exceeded', async () => {
      // First request to initialize consumer
      await request(app)
        .get('/api/quota-check')
        .set(mockConsumerHeaders);

      // Set quota to very low amount
      await request(app)
        .post('/api/consumers/test-consumer-123/quota')
        .send({ quota: 0.001 });

      // Use up quota
      await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'openai',
          model: 'gpt-4',
          prompt_tokens: 1000,
          completion_tokens: 500
        });

      const response = await request(app)
        .get('/api/quota-check')
        .set(mockConsumerHeaders);

      expect(response.status).toBe(200);
      expect(response.body.has_quota).toBe(false);
    });
  });

  describe('POST /api/consumers/:consumer_id/quota', () => {
    it('should set consumer quota', async () => {
      const response = await request(app)
        .post('/api/consumers/test-consumer-123/quota')
        .send({ quota: 50 });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('test-consumer-123');
      expect(response.body.quota).toBe(50);
      expect(response.body.used).toBe(0);
    });

    it('should update existing consumer quota', async () => {
      // Create consumer with quota
      await request(app)
        .post('/api/consumers/test-consumer-123/quota')
        .send({ quota: 50 });

      // Update quota
      const response = await request(app)
        .post('/api/consumers/test-consumer-123/quota')
        .send({ quota: 200 });

      expect(response.status).toBe(200);
      expect(response.body.quota).toBe(200);
    });
  });

  describe('GET /api/consumers/:consumer_id', () => {
    it('should return consumer info and usage stats', async () => {
      // Initialize consumer
      await request(app)
        .get('/api/quota-check')
        .set(mockConsumerHeaders);

      // Log some usage
      await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'openai',
          model: 'gpt-4',
          prompt_tokens: 100,
          completion_tokens: 50
        });

      const response = await request(app).get('/api/consumers/test-consumer-123');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('test-consumer-123');
      expect(response.body.requests).toBe(1);
      expect(response.body.total_tokens).toBe(150);
      expect(response.body.total_cost).toBeGreaterThan(0);
    });

    it('should return 404 for non-existent consumer', async () => {
      const response = await request(app).get('/api/consumers/invalid-consumer');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Consumer not found');
    });
  });

  describe('GET /api/consumers', () => {
    it('should return empty array when no consumers exist', async () => {
      const response = await request(app).get('/api/consumers');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it('should return all consumers', async () => {
      const consumer1 = { 'x-consumer-id': 'consumer-1', 'x-consumer-username': 'user1' };
      const consumer2 = { 'x-consumer-id': 'consumer-2', 'x-consumer-username': 'user2' };

      // Initialize two consumers
      await request(app).get('/api/quota-check').set(consumer1);
      await request(app).get('/api/quota-check').set(consumer2);

      const response = await request(app).get('/api/consumers');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
      // Consumers are ordered by created_at DESC (most recent first)
      expect(response.body[0].id).toBe('consumer-2');
      expect(response.body[1].id).toBe('consumer-1');
    });
  });

  describe('POST /api/audit', () => {
    it('should log LLM usage and calculate cost', async () => {
      const response = await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'openai',
          model: 'gpt-4',
          prompt_tokens: 100,
          completion_tokens: 50
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id');
      expect(response.body.cost).toBe((100 * 0.00001) + (50 * 0.00003));
      expect(response.body.total_tokens).toBe(150);
      expect(response.body.consumer_id).toBe('test-consumer-123');
    });

    it('should update consumer usage', async () => {
      // Log usage
      await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'openai',
          model: 'gpt-4',
          prompt_tokens: 100,
          completion_tokens: 50
        });

      const response = await request(app)
        .get('/api/quota-check')
        .set(mockConsumerHeaders);

      const expectedCost = (100 * 0.00001) + (50 * 0.00003);
      expect(response.body.remaining).toBe(100 - expectedCost);
    });

    it('should return 400 without consumer information', async () => {
      const response = await request(app)
        .post('/api/audit')
        .send({
          provider: 'openai',
          model: 'gpt-4',
          prompt_tokens: 100,
          completion_tokens: 50
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('No consumer information available');
    });

    it('should accept manual consumer_id when not authenticated via Kong', async () => {
      const response = await request(app)
        .post('/api/audit')
        .send({
          consumer_id: 'manual-consumer-123',
          provider: 'openai',
          model: 'gpt-4',
          prompt_tokens: 100,
          completion_tokens: 50
        });

      expect(response.status).toBe(200);
      expect(response.body.consumer_id).toBe('manual-consumer-123');
    });
  });

  describe('GET /api/usage', () => {
    it('should return usage statistics for authenticated consumer', async () => {
      // Log some usage
      await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'openai',
          model: 'gpt-4',
          prompt_tokens: 100,
          completion_tokens: 50
        });

      const response = await request(app)
        .get('/api/usage')
        .set(mockConsumerHeaders);

      expect(response.status).toBe(200);
      expect(response.body.consumer_id).toBe('test-consumer-123');
      expect(response.body.username).toBe('test-user');
      expect(response.body.requests).toBe(1);
      expect(response.body.total_tokens).toBe(150);
      expect(response.body.total_cost).toBeGreaterThan(0);
    });

    it('should return 401 without consumer headers', async () => {
      const response = await request(app).get('/api/usage');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('No consumer information');
    });
  });

  describe('GET /api/audit', () => {
    it('should return audit log for authenticated consumer', async () => {
      // Log some requests
      await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'openai',
          model: 'gpt-4',
          prompt_tokens: 100,
          completion_tokens: 50
        });

      await request(app)
        .post('/api/audit')
        .set(mockConsumerHeaders)
        .send({
          provider: 'anthropic',
          model: 'claude-3',
          prompt_tokens: 200,
          completion_tokens: 100
        });

      const response = await request(app)
        .get('/api/audit')
        .set(mockConsumerHeaders);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(response.body[0].provider).toBe('anthropic'); // Most recent first
      expect(response.body[1].provider).toBe('openai');
      expect(response.body[0].consumer_id).toBe('test-consumer-123');
    });

    it('should filter audit log by consumer_id query param', async () => {
      const consumer1 = { 'x-consumer-id': 'consumer-1' };
      const consumer2 = { 'x-consumer-id': 'consumer-2' };

      // Log usage for both consumers
      await request(app)
        .post('/api/audit')
        .set(consumer1)
        .send({
          provider: 'openai',
          model: 'gpt-4',
          prompt_tokens: 100,
          completion_tokens: 50
        });

      await request(app)
        .post('/api/audit')
        .set(consumer2)
        .send({
          provider: 'anthropic',
          model: 'claude-3',
          prompt_tokens: 200,
          completion_tokens: 100
        });

      const response = await request(app).get('/api/audit?consumer_id=consumer-1');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].consumer_id).toBe('consumer-1');
    });

    it('should respect limit parameter', async () => {
      // Create 3 requests
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post('/api/audit')
          .set(mockConsumerHeaders)
          .send({
            provider: 'openai',
            model: 'gpt-4',
            prompt_tokens: 100,
            completion_tokens: 50
          });
      }

      const response = await request(app)
        .get('/api/audit?limit=2')
        .set(mockConsumerHeaders);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
    });
  });

  describe('POST /api/admin/consumers', () => {
    it('should create a new consumer in Kong with API key', async () => {
      const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const username = `test-user-${uniqueId}`;
      const customId = `custom-${uniqueId}`;

      const response = await request(app)
        .post('/api/admin/consumers')
        .send({
          username,
          custom_id: customId,
          quota: 150
        });

      expect(response.status).toBe(200);
      expect(response.body.consumer).toHaveProperty('id');
      expect(response.body.consumer.username).toBe(username);
      expect(response.body).toHaveProperty('api_key');
      expect(response.body.quota).toBe(150);
    });

    it('should create consumer with default quota if not specified', async () => {
      const username = `test-user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const response = await request(app)
        .post('/api/admin/consumers')
        .send({
          username
        });

      expect(response.status).toBe(200);
      expect(response.body.quota).toBe(100);
    });

    it('should return 400 if username is missing', async () => {
      const response = await request(app)
        .post('/api/admin/consumers')
        .send({
          quota: 50
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Username is required');
    });
  });

  describe('DELETE /api/admin/consumers/:consumer_id', () => {
    it('should delete consumer from Kong and database', async () => {
      // First create a consumer
      const username = `test-user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const createResponse = await request(app)
        .post('/api/admin/consumers')
        .send({
          username,
          quota: 50
        });

      const consumerId = createResponse.body.consumer.id;

      // Delete the consumer
      const deleteResponse = await request(app)
        .delete(`/api/admin/consumers/${consumerId}`);

      expect(deleteResponse.status).toBe(200);
      expect(deleteResponse.body.message).toBe('Consumer deleted successfully');

      // Verify consumer is gone
      const getResponse = await request(app)
        .get(`/api/consumers/${consumerId}`);

      expect(getResponse.status).toBe(404);
    });

    it('should handle deleting non-existent consumer gracefully', async () => {
      const response = await request(app)
        .delete('/api/admin/consumers/non-existent-id');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Consumer deleted successfully');
    });
  });
});
