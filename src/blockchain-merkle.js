import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Web3 } from 'web3';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { pool } from './db.js';
import { buildMerkleTree, generateMerkleProof, hashLogEntry } from './merkle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

const PRIVATE_KEY = process.env.BLOCKCHAIN_PRIVATE_KEY;
const RPC_URL = process.env.BLOCKCHAIN_RPC_URL || 'https://sepolia.hpp.io';
const CONTRACT_ADDRESS = process.env.BLOCKCHAIN_CONTRACT_ADDRESS;

// Batching configuration
const BATCH_SIZE = parseInt(process.env.BLOCKCHAIN_BATCH_SIZE || '50');
const BATCH_INTERVAL_MS = parseInt(process.env.BLOCKCHAIN_BATCH_INTERVAL_MS || '60000'); // 1 minute default
const MAX_TXS_PER_DAY = parseInt(process.env.BLOCKCHAIN_MAX_TXS_PER_DAY || '2000');
const ENABLE_ADAPTIVE_BATCHING = process.env.BLOCKCHAIN_ADAPTIVE_BATCHING !== 'false'; // Enabled by default

let web3;
let contract;
let account;

/**
 * Sequential transaction queue to prevent nonce collisions
 */
class TransactionQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  async add(txFunction) {
    return new Promise((resolve, reject) => {
      this.queue.push({ txFunction, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      try {
        const result = await item.txFunction();
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      }
    }

    this.processing = false;
  }
}

const txQueue = new TransactionQueue();

/**
 * Merkle-based audit chain manager
 * Batches logs into Merkle trees and chains batches via nonces
 */
class MerkleAuditChain {
  constructor() {
    this.initialized = false;
    this.currentBatch = [];
    this.batchTimer = null;
    this.currentBatchSize = BATCH_SIZE;
    this.todayStats = null; // Cached daily stats
  }

  /**
   * Get the next available nonce from blockchain
   */
  async getNextNonce() {
    if (!account) throw new Error('Blockchain not initialized');
    const nonce = await web3.eth.getTransactionCount(account.address, 'pending');
    return Number(nonce);
  }

  /**
   * Get today's transaction statistics
   */
  async getTodayStats() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    const result = await pool.query(`
      SELECT
        COALESCE(tx_count, 0) as tx_count,
        COALESCE(request_count, 0) as request_count
      FROM blockchain_budget
      WHERE period = $1
    `, [today]);

    if (result.rows.length === 0) {
      // Initialize today's record
      await pool.query(`
        INSERT INTO blockchain_budget (period, tx_count, request_count)
        VALUES ($1, 0, 0)
        ON CONFLICT (period) DO NOTHING
      `, [today]);
      return { tx_count: 0, request_count: 0, period: today };
    }

    return { ...result.rows[0], period: today };
  }

  /**
   * Increment today's transaction count
   */
  async incrementTxCount() {
    const today = new Date().toISOString().split('T')[0];
    await pool.query(`
      INSERT INTO blockchain_budget (period, tx_count, request_count)
      VALUES ($1, 1, 0)
      ON CONFLICT (period)
      DO UPDATE SET tx_count = blockchain_budget.tx_count + 1, last_updated = CURRENT_TIMESTAMP
    `, [today]);
  }

  /**
   * Increment today's request count
   */
  async incrementRequestCount() {
    const today = new Date().toISOString().split('T')[0];
    await pool.query(`
      INSERT INTO blockchain_budget (period, request_count)
      VALUES ($1, 1)
      ON CONFLICT (period)
      DO UPDATE SET request_count = blockchain_budget.request_count + 1, last_updated = CURRENT_TIMESTAMP
    `, [today]);
  }

  /**
   * Adaptively adjust batch size based on daily budget
   */
  async adjustBatchSize() {
    if (!ENABLE_ADAPTIVE_BATCHING) {
      return BATCH_SIZE;
    }

    const stats = await this.getTodayStats();
    const txsRemaining = MAX_TXS_PER_DAY - stats.tx_count;

    if (txsRemaining <= 0) {
      console.warn('⚠️  Daily blockchain transaction budget exhausted');
      return Infinity; // Don't flush until tomorrow
    }

    // Calculate hours remaining in day
    const now = new Date();
    const hoursLeft = 24 - now.getHours();

    if (hoursLeft <= 0) {
      // End of day, use large batch size
      return Infinity;
    }

    // Estimate request rate (requests per hour)
    const requestRate = stats.request_count / (24 - hoursLeft) || 1;
    const estimatedRequestsRemaining = requestRate * hoursLeft;

    // Calculate needed batch size to stay under budget
    const neededBatchSize = Math.ceil(estimatedRequestsRemaining / txsRemaining);

    // Use the larger of configured size or needed size
    const adaptiveBatchSize = Math.max(BATCH_SIZE, neededBatchSize);

    if (adaptiveBatchSize > BATCH_SIZE) {
      console.log(`📊 Adaptive batching: ${adaptiveBatchSize} logs/batch (${txsRemaining} txs remaining)`);
    }

    return adaptiveBatchSize;
  }

  /**
   * Add a log to the current batch
   */
  async add(logData) {
    await this.incrementRequestCount();

    return new Promise((resolve, reject) => {
      this.currentBatch.push({ logData, resolve, reject });

      // Start timer on first item
      if (this.currentBatch.length === 1 && !this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          this.flush();
        }, BATCH_INTERVAL_MS);
      }

      // Check if batch should be flushed
      this.adjustBatchSize().then(batchSize => {
        if (this.currentBatch.length >= batchSize) {
          this.flush();
        }
      });
    });
  }

  /**
   * Flush current batch to blockchain
   */
  async flush() {
    if (this.currentBatch.length === 0) {
      return;
    }

    // Clear timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Check budget
    const stats = await this.getTodayStats();
    if (stats.tx_count >= MAX_TXS_PER_DAY) {
      console.warn(`⚠️  Skipping batch flush: daily tx budget exhausted (${stats.tx_count}/${MAX_TXS_PER_DAY})`);

      // Resolve all promises without blockchain recording
      this.currentBatch.forEach(item => {
        item.resolve({ status: 'budget_exhausted', queued: true });
      });
      this.currentBatch = [];
      return;
    }

    // Take current batch and reset
    const batchToProcess = this.currentBatch;
    this.currentBatch = [];

    // Submit via transaction queue
    txQueue.add(() => this._processBatch(batchToProcess));
  }

  /**
   * Process a batch and submit to blockchain
   */
  async _processBatch(batch) {
    if (!contract || !account) {
      throw new Error('Blockchain not initialized');
    }

    try {
      // 1. Extract log data and create hashes
      const logHashes = batch.map(item => hashLogEntry(item.logData));
      const logIds = batch.map(item => item.logData.logId);

      // 2. Build Merkle tree (hashes are pre-computed, don't rehash)
      const { root: merkleRoot, tree } = buildMerkleTree(logHashes, true);

      // 3. Get nonce
      const nonce = await this.getNextNonce();
      const prevNonce = nonce > 0 ? nonce - 1 : 0;

      // 4. Create chain hash: SHA256(merkleRoot || prevNonce)
      const chainHash = crypto
        .createHash('sha256')
        .update(merkleRoot + prevNonce.toString())
        .digest('hex');

      // 5. Submit to blockchain
      const tx = contract.methods.recordBatch(
        '0x' + merkleRoot,
        '0x' + chainHash,
        batch.length
      );

      const gas = await tx.estimateGas({ from: account.address });
      const receipt = await tx.send({
        from: account.address,
        gas: gas.toString(),
        nonce: nonce
      });

      console.log(`✅ Merkle batch: ${batch.length} logs (nonce: ${nonce}, tx: ${receipt.transactionHash.substring(0, 10)}...)`);

      // 6. Increment transaction count
      await this.incrementTxCount();

      // 7. Update database with batch info and Merkle proofs
      const batchId = await this._saveBatchRecord(
        merkleRoot,
        chainHash,
        nonce,
        prevNonce,
        receipt.transactionHash,
        Number(receipt.blockNumber),
        batch.length
      );

      // 8. Update individual logs with batch reference and proofs
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const proof = generateMerkleProof(tree, i);

        await pool.query(`
          UPDATE usage_logs
          SET
            batch_id = $1,
            merkle_proof = $2,
            leaf_hash = $3,
            blockchain_tx_hash = $4
          WHERE id = $5
        `, [
          batchId,
          JSON.stringify(proof),
          '0x' + logHashes[i],
          receipt.transactionHash,
          item.logData.logId
        ]);

        // Resolve promise
        item.resolve({
          success: true,
          batchId,
          nonce,
          txHash: receipt.transactionHash
        });
      }

      return {
        success: true,
        batchId,
        logCount: batch.length,
        txHash: receipt.transactionHash,
        nonce,
        gasUsed: receipt.gasUsed
      };

    } catch (error) {
      console.error(`❌ Failed to process Merkle batch:`, error.message);

      // Reject all promises
      batch.forEach(item => item.reject(error));

      throw error;
    }
  }

  /**
   * Save batch record to database
   */
  async _saveBatchRecord(merkleRoot, chainHash, nonce, prevNonce, txHash, blockNumber, logCount) {
    const result = await pool.query(`
      INSERT INTO blockchain_batches (
        merkle_root, chain_hash, tx_nonce, prev_tx_nonce,
        blockchain_tx_hash, block_number, log_count
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [
      '0x' + merkleRoot,
      '0x' + chainHash,
      nonce,
      prevNonce,
      txHash,
      blockNumber,
      logCount
    ]);

    return result.rows[0].id;
  }

  /**
   * Resume chain state after restart
   */
  async resumeChain() {
    console.log('🔄 Resuming Merkle audit chain...');

    // Get blockchain state
    const blockchainNonce = await this.getNextNonce();
    console.log(`   Blockchain nonce: ${blockchainNonce}`);

    // Get database state
    const dbState = await pool.query(`
      SELECT
        COUNT(*) as total_batches,
        MAX(tx_nonce) as last_nonce,
        SUM(log_count) as total_logs
      FROM blockchain_batches
      WHERE tx_nonce IS NOT NULL
    `);

    const totalBatches = parseInt(dbState.rows[0].total_batches);
    const lastNonce = dbState.rows[0].last_nonce;
    const totalLogs = parseInt(dbState.rows[0].total_logs || 0);

    console.log(`   Database: ${totalBatches} batches, ${totalLogs} logs (last nonce: ${lastNonce})`);

    // Get today's stats
    const todayStats = await this.getTodayStats();
    console.log(`   Today: ${todayStats.tx_count}/${MAX_TXS_PER_DAY} txs, ${todayStats.request_count} requests`);

    this.initialized = true;

    return {
      blockchainNonce,
      totalBatches,
      totalLogs,
      lastNonce,
      todayStats,
      ready: true
    };
  }

  /**
   * Verify a log entry using its Merkle proof
   */
  async verifyLog(logId) {
    const result = await pool.query(`
      SELECT
        ul.*,
        bb.merkle_root,
        bb.chain_hash,
        bb.tx_nonce,
        bb.prev_tx_nonce,
        bb.blockchain_tx_hash as batch_tx_hash,
        bb.block_number
      FROM usage_logs ul
      JOIN blockchain_batches bb ON ul.batch_id = bb.id
      WHERE ul.id = $1
    `, [logId]);

    if (result.rows.length === 0) {
      return { valid: false, reason: 'Log not found' };
    }

    const log = result.rows[0];

    if (!log.batch_id || !log.merkle_proof) {
      return { valid: false, reason: 'Log not yet recorded to blockchain' };
    }

    // 1. Verify transaction exists
    const tx = await web3.eth.getTransaction(log.batch_tx_hash);
    if (!tx) {
      return { valid: false, reason: 'Transaction not found on blockchain' };
    }

    // 2. Verify Merkle proof
    const { verifyMerkleProof } = await import('./merkle.js');
    const proof = log.merkle_proof; // Already parsed from JSONB column
    const merkleRoot = log.merkle_root.substring(2); // Remove 0x prefix
    const leafHash = log.leaf_hash.substring(2);

    const merkleValid = verifyMerkleProof(leafHash, proof, merkleRoot);
    if (!merkleValid) {
      return { valid: false, reason: 'Merkle proof verification failed' };
    }

    // 3. Verify chain hash
    const expectedChainHash = crypto
      .createHash('sha256')
      .update(merkleRoot + log.prev_tx_nonce.toString())
      .digest('hex');

    if ('0x' + expectedChainHash !== log.chain_hash) {
      return { valid: false, reason: 'Chain hash verification failed' };
    }

    return {
      valid: true,
      batchId: log.batch_id,
      txHash: log.batch_tx_hash,
      nonce: log.tx_nonce,
      blockNumber: log.block_number,
      merkleRoot: log.merkle_root,
      leafHash: log.leaf_hash
    };
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queueLength: this.currentBatch.length,
      currentBatchSize: this.currentBatchSize,
      configuredBatchSize: BATCH_SIZE,
      batchInterval: BATCH_INTERVAL_MS,
      maxTxsPerDay: MAX_TXS_PER_DAY,
      adaptiveBatching: ENABLE_ADAPTIVE_BATCHING
    };
  }
}

const merkleAuditChain = new MerkleAuditChain();

// Initialize blockchain connection
export async function initBlockchain() {
  if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
    console.warn('⚠️  Blockchain not configured. Set BLOCKCHAIN_PRIVATE_KEY and BLOCKCHAIN_CONTRACT_ADDRESS in .env');
    return null;
  }

  try {
    // Load contract ABI
    const deploymentPath = path.join(__dirname, '..', 'contracts', 'deployed-merkle.json');
    const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

    // Connect to network
    web3 = new Web3(RPC_URL);
    account = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY);
    web3.eth.accounts.wallet.add(account);

    // Create contract instance
    contract = new web3.eth.Contract(deployment.abi, CONTRACT_ADDRESS);

    // Detect network name from chain ID
    const chainId = await web3.eth.getChainId();
    const networkName = chainId === 190415n ? 'HPP Mainnet' :
                        chainId === 181228n ? 'HPP Sepolia' :
                        `Chain ${chainId}`;

    console.log('✅ Blockchain initialized (Merkle Batch Mode)');
    console.log('   Contract:', CONTRACT_ADDRESS);
    console.log('   Account:', account.address);
    console.log('   Batch size:', BATCH_SIZE);
    console.log('   Batch interval:', BATCH_INTERVAL_MS, 'ms');
    console.log('   Max txs/day:', MAX_TXS_PER_DAY);
    console.log('   Adaptive batching:', ENABLE_ADAPTIVE_BATCHING ? 'enabled' : 'disabled');

    // Resume chain state
    merkleAuditChain.resumeChain().catch(err => {
      console.error('Failed to resume chain:', err.message);
    });

    return { network: networkName };
  } catch (error) {
    console.error('❌ Failed to initialize blockchain:', error.message);
    return null;
  }
}

/**
 * Log a request to the blockchain (batched with Merkle trees)
 */
export async function logToBlockchain(logData) {
  return await merkleAuditChain.add(logData);
}

/**
 * Verify a log entry
 */
export async function verifyLog(logId) {
  return await merkleAuditChain.verifyLog(logId);
}

/**
 * Get blockchain statistics
 */
export async function getBlockchainStats() {
  if (!contract) {
    throw new Error('Blockchain not initialized');
  }

  const totalBatches = await contract.methods.totalBatches().call();
  const version = await contract.methods.version().call();

  // Get wallet balance
  const balanceWei = await web3.eth.getBalance(account.address);
  const balanceEth = web3.utils.fromWei(balanceWei, 'ether');

  // Get database stats
  const dbStats = await pool.query(`
    SELECT
      COUNT(*) as total_batches,
      SUM(log_count) as total_logs,
      MAX(tx_nonce) as last_nonce
    FROM blockchain_batches
    WHERE tx_nonce IS NOT NULL
  `);

  // Get today's stats
  const todayStats = await merkleAuditChain.getTodayStats();

  // Estimate remaining transactions based on gas costs
  const regularBatchGas = 250000;  // Average gas for batch tx (needs to be measured)
  const gasPrice = await web3.eth.getGasPrice();

  const avgCostPerBatch = web3.utils.fromWei((BigInt(regularBatchGas) * BigInt(gasPrice)).toString(), 'ether');
  const estimatedTxsRemaining = Math.floor(parseFloat(balanceEth) / parseFloat(avgCostPerBatch));

  // Detect network name from chain ID
  const chainId = await web3.eth.getChainId();
  const networkName = chainId === 190415n ? 'HPP Mainnet' :
                      chainId === 181228n ? 'HPP Sepolia' :
                      `Chain ${chainId}`;

  return {
    totalBatches: totalBatches.toString(),
    version,
    contractAddress: CONTRACT_ADDRESS,
    walletAddress: account.address,
    balance: balanceEth,
    estimatedTxsRemaining,
    network: networkName,
    database: {
      totalBatches: dbStats.rows[0].total_batches,
      totalLogs: dbStats.rows[0].total_logs,
      lastNonce: dbStats.rows[0].last_nonce
    },
    today: todayStats,
    queue: merkleAuditChain.getStatus()
  };
}

/**
 * Check if blockchain is enabled/configured
 */
export function isBlockchainEnabled() {
  return !!(contract && account);
}

/**
 * Force flush current batch (for testing/admin)
 */
export async function flushBatch() {
  return await merkleAuditChain.flush();
}
