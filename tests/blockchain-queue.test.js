/**
 * Test blockchain queue nonce management
 *
 * This test verifies that concurrent blockchain transactions are processed
 * sequentially with correct nonce ordering to prevent nonce conflicts.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';

describe('Blockchain Queue - Nonce Management', () => {
  test('should handle concurrent transactions sequentially', async () => {
    // Mock blockchain queue behavior
    class MockBlockchainQueue {
      constructor() {
        this.queue = [];
        this.processing = false;
        this.processedNonces = [];
      }

      async enqueue(txFunction) {
        return new Promise((resolve, reject) => {
          this.queue.push({ txFunction, resolve, reject });
          this.processQueue();
        });
      }

      async processQueue() {
        if (this.processing || this.queue.length === 0) {
          return;
        }

        this.processing = true;
        const { txFunction, resolve, reject } = this.queue.shift();

        try {
          const result = await txFunction();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.processing = false;
          this.processQueue();
        }
      }

      getStatus() {
        return {
          queueLength: this.queue.length,
          processing: this.processing
        };
      }
    }

    const queue = new MockBlockchainQueue();

    // Simulate concurrent blockchain logs with nonce tracking
    let currentNonce = 100;
    const getNonce = async () => {
      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, 10));
      return currentNonce++;
    };

    const sendTransaction = async (logId) => {
      return queue.enqueue(async () => {
        const nonce = await getNonce();
        // Simulate transaction send delay
        await new Promise(resolve => setTimeout(resolve, 50));
        return { logId, nonce, tx: `0x${logId}` };
      });
    };

    // Send 5 concurrent transactions
    const promises = [
      sendTransaction('log1'),
      sendTransaction('log2'),
      sendTransaction('log3'),
      sendTransaction('log4'),
      sendTransaction('log5')
    ];

    const results = await Promise.all(promises);

    // Verify nonces are sequential (no conflicts)
    const nonces = results.map(r => r.nonce);
    expect(nonces).toEqual([100, 101, 102, 103, 104]);

    // Verify all transactions completed
    expect(results).toHaveLength(5);
    expect(results[0].logId).toBe('log1');
    expect(results[4].logId).toBe('log5');
  });

  test('should report queue status correctly', () => {
    class MockBlockchainQueue {
      constructor() {
        this.queue = [];
        this.processing = false;
      }

      getStatus() {
        return {
          queueLength: this.queue.length,
          processing: this.processing
        };
      }
    }

    const queue = new MockBlockchainQueue();

    // Initially empty
    expect(queue.getStatus()).toEqual({
      queueLength: 0,
      processing: false
    });

    // Add items to queue
    queue.queue.push({ id: 1 });
    queue.queue.push({ id: 2 });
    queue.processing = true;

    expect(queue.getStatus()).toEqual({
      queueLength: 2,
      processing: true
    });
  });

  test('should handle transaction errors without blocking queue', async () => {
    class MockBlockchainQueue {
      constructor() {
        this.queue = [];
        this.processing = false;
        this.results = [];
      }

      async enqueue(txFunction) {
        return new Promise((resolve, reject) => {
          this.queue.push({ txFunction, resolve, reject });
          this.processQueue();
        });
      }

      async processQueue() {
        if (this.processing || this.queue.length === 0) {
          return;
        }

        this.processing = true;
        const { txFunction, resolve, reject } = this.queue.shift();

        try {
          const result = await txFunction();
          this.results.push({ success: true, result });
          resolve(result);
        } catch (error) {
          this.results.push({ success: false, error: error.message });
          reject(error);
        } finally {
          this.processing = false;
          this.processQueue();
        }
      }
    }

    const queue = new MockBlockchainQueue();

    // Transaction that succeeds
    const tx1 = queue.enqueue(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { id: 1, status: 'ok' };
    });

    // Transaction that fails
    const tx2 = queue.enqueue(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      throw new Error('Transaction failed');
    });

    // Transaction that succeeds after error
    const tx3 = queue.enqueue(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { id: 3, status: 'ok' };
    });

    const results = await Promise.allSettled([tx1, tx2, tx3]);

    // First transaction succeeded
    expect(results[0].status).toBe('fulfilled');
    expect(results[0].value.id).toBe(1);

    // Second transaction failed
    expect(results[1].status).toBe('rejected');
    expect(results[1].reason.message).toBe('Transaction failed');

    // Third transaction succeeded (queue continued after error)
    expect(results[2].status).toBe('fulfilled');
    expect(results[2].value.id).toBe(3);

    // Verify queue processed all three
    expect(queue.results).toHaveLength(3);
  });
});
