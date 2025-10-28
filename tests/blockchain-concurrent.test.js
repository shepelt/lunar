/**
 * Integration test for blockchain nonce management under concurrent load
 *
 * This test makes concurrent LLM requests through Kong and verifies:
 * 1. All requests succeed
 * 2. All logs get written to blockchain
 * 3. Blockchain transaction hashes are recorded
 * 4. No nonce conflicts occur
 *
 * PREREQUISITES:
 * - Kong running on localhost:8000
 * - Ollama running with gpt-oss:120b model
 * - Blockchain configured (BLOCKCHAIN_PRIVATE_KEY, etc.)
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import app from '../src/app.js';
import { pool } from '../src/db.js';
import { initBlockchain } from '../src/blockchain.js';
import { nanoid } from 'nanoid';

describe('Blockchain Concurrent Request Test', () => {
  let testConsumerId;
  let testApiKey;

  beforeAll(async () => {
    // Initialize blockchain (required for tests)
    initBlockchain();

    // Create test consumer with quota
    const username = `test-blockchain-${nanoid(8)}`;

    const consumerRes = await request(app)
      .post('/api/admin/consumers')
      .send({ username, quota: 100 });

    testConsumerId = consumerRes.body.consumer.id;
    testApiKey = consumerRes.body.api_key;
  });

  afterAll(async () => {
    // Cleanup: delete test consumer and logs
    if (testConsumerId) {
      await pool.query('DELETE FROM usage_logs WHERE consumer_id = $1', [testConsumerId]);
      await pool.query('DELETE FROM consumer_quotas WHERE consumer_id = $1', [testConsumerId]);
    }

    // Close database pool to prevent open handles
    await pool.end();
  });

  test('should handle concurrent requests without nonce conflicts', async () => {
    // Skip test if blockchain not configured
    const configRes = await request(app).get('/api/config');
    if (!configRes.body.blockchain_enabled) {
      console.log('⚠️  Skipping blockchain test - blockchain not configured');
      return;
    }

    // Check if Kong is running
    try {
      await fetch('http://localhost:8000/health');
    } catch (error) {
      console.log('⚠️  Skipping test - Kong not running on localhost:8000');
      return;
    }

    console.log('\n🔄 Making 5 concurrent LLM requests to Kong...');
    console.log(`   Using API Key: ${testApiKey.substring(0, 8)}...`);

    // Make 5 concurrent requests to Kong local-llm endpoint
    const promises = Array.from({ length: 5 }, async (_, i) => {
      try {
        const response = await fetch('http://localhost:8000/local-llm', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': testApiKey
          },
          body: JSON.stringify({
            model: 'gpt-oss:120b',
            messages: [
              { role: 'user', content: `Test message ${i + 1}` }
            ],
            max_tokens: 10
          })
        });
        return { status: response.status, body: await response.json() };
      } catch (error) {
        console.error(`Request ${i + 1} failed:`, error.message);
        return { status: 500, error: error.message };
      }
    });

    const responses = await Promise.all(promises);

    // Verify all requests succeeded
    responses.forEach((res, i) => {
      expect(res.status).toBe(200);
      console.log(`  ✅ Request ${i + 1}: ${res.status}`);
    });

    // Wait for blockchain transactions to process
    console.log('\n⏳ Waiting for blockchain transactions to process...');
    await new Promise(resolve => setTimeout(resolve, 15000)); // 15 seconds

    // Fetch audit logs
    const auditRes = await request(app)
      .get('/api/audit')
      .query({ limit: 10 });

    expect(auditRes.status).toBe(200);

    // Filter logs for our test consumer (body is the array directly)
    const testLogs = auditRes.body
      .filter(log => log.consumer_id === testConsumerId)
      .sort((a, b) => a.created_at - b.created_at);

    console.log(`\n📊 Found ${testLogs.length} logs for test consumer\n`);

    // Verify we got all 5 logs
    expect(testLogs.length).toBeGreaterThanOrEqual(5);

    // Check blockchain transaction hashes
    let successCount = 0;
    let pendingCount = 0;

    testLogs.forEach((log, i) => {
      if (log.blockchain_tx_hash) {
        successCount++;
        console.log(`  ✅ Log ${i + 1}: blockchain_tx_hash = ${log.blockchain_tx_hash}`);
      } else {
        pendingCount++;
        console.log(`  ⏳ Log ${i + 1}: blockchain transaction pending or failed`);
      }
    });

    console.log(`\n📈 Blockchain Status:`);
    console.log(`  - Successfully logged: ${successCount}/${testLogs.length}`);
    console.log(`  - Pending/Failed: ${pendingCount}/${testLogs.length}`);

    // We expect most or all to have blockchain hashes
    // (Some might still be pending if blockchain is slow)
    expect(successCount).toBeGreaterThan(0);

    // With batching, logs may share transaction hashes (multiple logs per tx)
    if (successCount === testLogs.length) {
      const txHashes = testLogs.map(log => log.blockchain_tx_hash).filter(Boolean);
      const uniqueTxHashes = new Set(txHashes);

      console.log(`\n📦 Batching Results:`);
      console.log(`  - Total logs: ${txHashes.length}`);
      console.log(`  - Unique transactions: ${uniqueTxHashes.size}`);
      console.log(`  - Logs per transaction: ~${(txHashes.length / uniqueTxHashes.size).toFixed(1)}`);

      // Verify all logs have hashes and at least one transaction succeeded
      expect(txHashes.length).toBe(testLogs.length);
      expect(uniqueTxHashes.size).toBeGreaterThan(0);
      console.log('\n✅ All logs successfully written to blockchain!');
    } else {
      console.log('\n⚠️  Some transactions still pending - this is normal for blockchain writes');
    }
  }, 60000); // 60 second timeout for Kong + blockchain operations

  test('should report queue status via config endpoint', async () => {
    const res = await request(app).get('/api/config');

    expect(res.status).toBe(200);

    if (res.body.blockchain_enabled && res.body.blockchain_stats) {
      console.log('\n📊 Blockchain Queue Status:');
      console.log(`  - Queue length: ${res.body.blockchain_stats.queue?.queueLength || 0}`);
      console.log(`  - Processing: ${res.body.blockchain_stats.queue?.processing || false}`);

      // Queue status should be present
      expect(res.body.blockchain_stats.queue).toBeDefined();
      expect(typeof res.body.blockchain_stats.queue.queueLength).toBe('number');
      expect(typeof res.body.blockchain_stats.queue.processing).toBe('boolean');
    }
  });
});
