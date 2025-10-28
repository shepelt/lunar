import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Web3 } from 'web3';
import dotenv from 'dotenv';
import { pool } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

const PRIVATE_KEY = process.env.BLOCKCHAIN_PRIVATE_KEY;
const RPC_URL = process.env.BLOCKCHAIN_RPC_URL || 'https://sepolia.hpp.io';
const CONTRACT_ADDRESS = process.env.BLOCKCHAIN_CONTRACT_ADDRESS;

// Batching configuration
const BATCH_SIZE = parseInt(process.env.BLOCKCHAIN_BATCH_SIZE || '50');
const BATCH_INTERVAL_MS = parseInt(process.env.BLOCKCHAIN_BATCH_INTERVAL_MS || '10000');

let web3;
let contract;
let account;

/**
 * Batching queue for blockchain transactions
 * Accumulates logs and submits them in batches for better performance
 */
class BlockchainQueue {
  constructor() {
    this.batch = [];           // Current batch of logs
    this.batchTimer = null;    // Timer for time-based flushing
    this.processing = false;   // Currently processing a batch
  }

  /**
   * Add a log to the current batch
   * @param {Object} logData - The log data to add
   * @returns {Promise} Resolves when log is submitted to blockchain
   */
  async add(logData) {
    return new Promise((resolve, reject) => {
      // Add to batch with promise handlers
      this.batch.push({ logData, resolve, reject });

      // Start timer on first item in batch
      if (this.batch.length === 1 && !this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          this.flush();
        }, BATCH_INTERVAL_MS);
      }

      // Flush immediately if batch is full
      if (this.batch.length >= BATCH_SIZE) {
        this.flush();
      }
    });
  }

  /**
   * Flush current batch to blockchain
   */
  async flush() {
    // Nothing to flush
    if (this.batch.length === 0) {
      return;
    }

    // Already processing, skip (will be called again after current completes)
    if (this.processing) {
      return;
    }

    // Clear timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Take current batch and reset
    const batchToProcess = this.batch;
    this.batch = [];
    this.processing = true;

    try {
      // Submit batch to blockchain
      await this.submitBatch(batchToProcess);
    } catch (error) {
      console.error('Batch submission failed:', error.message);
      // Reject all promises in batch
      batchToProcess.forEach(item => item.reject(error));
    } finally {
      this.processing = false;

      // If new items were added while processing, flush again
      if (this.batch.length > 0) {
        this.flush();
      }
    }
  }

  /**
   * Submit a batch of logs to the blockchain
   */
  async submitBatch(batch) {
    if (!contract || !account) {
      throw new Error('Blockchain not initialized');
    }

    const logIds = [];
    const consumerIds = [];
    const providers = [];
    const models = [];
    const promptTokens = [];
    const completionTokens = [];
    const requestHashes = [];
    const responseHashes = [];

    // Extract data from batch
    batch.forEach(item => {
      const { logData } = item;
      logIds.push(logData.logId);
      consumerIds.push(logData.consumerId);
      providers.push(logData.provider);
      models.push(logData.model);
      promptTokens.push(logData.promptTokens);
      completionTokens.push(logData.completionTokens);
      requestHashes.push(logData.requestHash);
      responseHashes.push(logData.responseHash);
    });

    try {
      // Get nonce with 'pending' state to include queued transactions
      const nonce = await web3.eth.getTransactionCount(account.address, 'pending');

      const tx = contract.methods.logRequestBatch(
        logIds,
        consumerIds,
        providers,
        models,
        promptTokens,
        completionTokens,
        requestHashes,
        responseHashes
      );

      // Estimate gas
      const gas = await tx.estimateGas({ from: account.address });

      // Send transaction with explicit nonce
      const receipt = await tx.send({
        from: account.address,
        gas: gas.toString(),
        nonce: nonce
      });

      console.log(`✅ Blockchain batch: ${batch.length} logs (tx: ${receipt.transactionHash}, nonce: ${nonce})`);

      // Update database with transaction hash for all logs in batch
      for (const item of batch) {
        try {
          await pool.query(
            'UPDATE usage_logs SET blockchain_tx_hash = $1 WHERE id = $2',
            [receipt.transactionHash, item.logData.logId]
          );
          // Resolve promise
          item.resolve(receipt);
        } catch (error) {
          console.error(`Failed to update DB for ${item.logData.logId}:`, error.message);
          item.reject(error);
        }
      }

      return receipt;
    } catch (error) {
      console.error(`❌ Blockchain batch failed (${batch.length} logs):`, error.message);
      throw error;
    }
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queueLength: this.batch.length,
      processing: this.processing,
      batchSize: BATCH_SIZE,
      batchInterval: BATCH_INTERVAL_MS
    };
  }
}

const blockchainQueue = new BlockchainQueue();

// Initialize blockchain connection
export function initBlockchain() {
  if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
    console.warn('⚠️  Blockchain not configured. Set BLOCKCHAIN_PRIVATE_KEY and BLOCKCHAIN_CONTRACT_ADDRESS in .env');
    return false;
  }

  try {
    // Load contract ABI
    const deploymentPath = path.join(__dirname, '..', 'contracts', 'deployed.json');
    const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

    // Connect to network
    web3 = new Web3(RPC_URL);
    account = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY);
    web3.eth.accounts.wallet.add(account);

    // Create contract instance
    contract = new web3.eth.Contract(deployment.abi, CONTRACT_ADDRESS);

    console.log('✅ Blockchain initialized');
    console.log('   Contract:', CONTRACT_ADDRESS);
    console.log('   Account:', account.address);

    return true;
  } catch (error) {
    console.error('❌ Failed to initialize blockchain:', error.message);
    return false;
  }
}

/**
 * Log a request to the blockchain (batched for performance)
 * @param {Object} logData - The log data
 * @returns {Promise<Object>} Status and queue info
 */
export async function logToBlockchain(logData) {
  if (!contract || !account) {
    throw new Error('Blockchain not initialized');
  }

  // Add to batch queue (will be submitted when batch is full or timer expires)
  blockchainQueue.add(logData).catch(error => {
    console.error(`Failed to add ${logData.logId} to batch:`, error.message);
  });

  // Return immediately (async batching in background)
  return { status: 'batched', logId: logData.logId, queueStatus: blockchainQueue.getStatus() };
}

/**
 * Get contract statistics
 */
export async function getBlockchainStats() {
  if (!contract) {
    throw new Error('Blockchain not initialized');
  }

  const totalLogs = await contract.methods.totalLogs().call();
  const version = await contract.methods.version().call();

  return {
    totalLogs: totalLogs.toString(),
    version,
    contractAddress: CONTRACT_ADDRESS,
    network: 'HPP Sepolia',
    queue: blockchainQueue.getStatus()
  };
}

/**
 * Get blockchain queue status
 */
export function getQueueStatus() {
  return blockchainQueue.getStatus();
}

/**
 * Check if blockchain is enabled/configured
 */
export function isBlockchainEnabled() {
  return !!(contract && account);
}
