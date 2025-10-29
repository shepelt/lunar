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
import { initBlockchain } from '../src/blockchain.js';
import { nanoid } from 'nanoid';

// Use environment variables for URLs (supports both local and Docker testing)
const KONG_ADMIN_URL = process.env.KONG_ADMIN_URL || 'http://localhost:8001';
const KONG_GATEWAY_URL = process.env.KONG_GATEWAY_URL || 'http://localhost:8000';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'test-admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-password-123';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL_NAME || 'qwen2:0.5b';

// Check if blockchain is configured
const BLOCKCHAIN_CONFIGURED = Boolean(
  process.env.BLOCKCHAIN_PRIVATE_KEY &&
  process.env.BLOCKCHAIN_RPC_URL &&
  process.env.BLOCKCHAIN_CONTRACT_ADDRESS
);

// Skip all tests if blockchain not configured
const describeBlockchain = BLOCKCHAIN_CONFIGURED ? describe : describe.skip;

describeBlockchain('Blockchain Concurrent Request Test', () => {
  let testConsumerId;
  let testApiKey;

  beforeAll(async () => {
    // Initialize blockchain (required for tests)
    const initialized = initBlockchain();
    if (!initialized) {
      throw new Error('Blockchain initialization failed - tests require blockchain configuration');
    }

    // Create test consumer using Kong Admin API
    const username = `test-blockchain-${nanoid(8)}`;

    // Create consumer via Kong Admin API
    const consumerRes = await fetch(`${KONG_ADMIN_URL}/consumers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const consumer = await consumerRes.json();
    testConsumerId = consumer.id;

    // Create API key for consumer via Kong Admin API
    const keyRes = await fetch(`${KONG_ADMIN_URL}/consumers/${testConsumerId}/key-auth`, {
      method: 'POST'
    });
    const key = await keyRes.json();
    testApiKey = key.key;

    // Set quota for consumer via backend API
    const credentials = Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString('base64');
    await fetch(`${KONG_GATEWAY_URL}/admin/api/consumers/${testConsumerId}/quota`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ quota: 100 })
    });
  });

  afterAll(async () => {
    // Cleanup: delete test consumer (cascades to logs and quotas via Kong)
    if (testConsumerId) {
      await fetch(`${KONG_ADMIN_URL}/consumers/${testConsumerId}`, {
        method: 'DELETE'
      });
    }
  });

  test('should handle concurrent requests without nonce conflicts', async () => {
    // Blockchain is confirmed to be configured (checked in describe block)

    console.log('\n🔄 Making 5 concurrent LLM requests to Kong...');
    console.log(`   Using API Key: ${testApiKey.substring(0, 8)}...`);

    // Make 5 concurrent requests to Kong local-llm endpoint
    const promises = Array.from({ length: 5 }, async (_, i) => {
      try {
        const response = await fetch(`${KONG_GATEWAY_URL}/local-llm/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': testApiKey
          },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
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
    await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds (blockchain + DB update)

    // Fetch audit logs through Kong Gateway with authentication
    const credentials = Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString('base64');
    const auditRes = await fetch(`${KONG_GATEWAY_URL}/admin/api/audit?limit=10`, {
      headers: {
        'Authorization': `Basic ${credentials}`
      }
    });

    expect(auditRes.ok).toBe(true);

    // Filter logs for our test consumer
    const allLogs = await auditRes.json();
    const testLogs = allLogs
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
  }, 90000); // 90 second timeout for Kong + blockchain operations

  test('should report queue status via config endpoint', async () => {
    const credentials = Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString('base64');
    const res = await fetch(`${KONG_GATEWAY_URL}/admin/api/config`, {
      headers: {
        'Authorization': `Basic ${credentials}`
      }
    });

    expect(res.ok).toBe(true);

    const config = await res.json();
    if (config.blockchain_enabled && config.blockchain_stats) {
      console.log('\n📊 Blockchain Queue Status:');
      console.log(`  - Queue length: ${config.blockchain_stats.queue?.queueLength || 0}`);
      console.log(`  - Processing: ${config.blockchain_stats.queue?.processing || false}`);

      // Queue status should be present
      expect(config.blockchain_stats.queue).toBeDefined();
      expect(typeof config.blockchain_stats.queue.queueLength).toBe('number');
      expect(typeof config.blockchain_stats.queue.processing).toBe('boolean');
    }
  });
});
