import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Web3 } from 'web3';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { pool } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

const PRIVATE_KEY = process.env.BLOCKCHAIN_PRIVATE_KEY;
const RPC_URL = process.env.BLOCKCHAIN_RPC_URL || 'https://sepolia.hpp.io';
const CONTRACT_ADDRESS = process.env.BLOCKCHAIN_CONTRACT_ADDRESS;

// Anchor interval - post hash every N logs (must match smart contract)
const ANCHOR_INTERVAL = 10;

let web3;
let contract;
let account;

/**
 * Nonce-based audit chain manager
 * Implements log-by-log blockchain recording with minimal on-chain data
 */
class AuditChainManager {
  constructor() {
    this.initialized = false;
  }

  /**
   * Get the next available nonce from blockchain
   */
  async getNextNonce() {
    if (!account) throw new Error('Blockchain not initialized');

    // Use 'pending' to include queued transactions
    return await web3.eth.getTransactionCount(account.address, 'pending');
  }

  /**
   * Get the next log ID from database
   */
  async getNextLogId() {
    const result = await pool.query('SELECT COALESCE(MAX(CAST(id AS BIGINT)), -1) + 1 as next_id FROM usage_logs WHERE tx_nonce IS NOT NULL');
    return result.rows[0].next_id;
  }

  /**
   * Calculate hash for log entry
   * Hash = SHA256(logData || previousNonce)
   */
  calculateHash(logData, previousNonce) {
    const dataString = JSON.stringify({
      consumer_id: logData.consumerId,
      provider: logData.provider,
      model: logData.model,
      prompt_tokens: logData.promptTokens,
      completion_tokens: logData.completionTokens,
      request_hash: logData.requestHash,
      response_hash: logData.responseHash
    });

    return crypto
      .createHash('sha256')
      .update(dataString + previousNonce.toString())
      .digest('hex');
  }

  /**
   * Record a log entry to the blockchain using nonce chain approach
   */
  async recordLog(logData) {
    if (!contract || !account) {
      throw new Error('Blockchain not initialized');
    }

    try {
      // 1. Get current nonce and log ID
      const nonce = await this.getNextNonce();
      const logId = await this.getNextLogId();

      // 2. Calculate hash using previous nonce
      const prevNonce = nonce > 0 ? nonce - 1 : 0;
      const localHash = this.calculateHash(logData, prevNonce);

      // 3. Determine if this is an anchor log
      const isAnchor = logId % ANCHOR_INTERVAL === 0;

      // 4. Prepare anchor hash (12 bytes = 24 hex chars)
      let anchorHash = '0x000000000000000000000000'; // Empty for regular logs
      if (isAnchor) {
        anchorHash = '0x' + localHash.substring(0, 24);
      }

      // 5. Send transaction to blockchain
      const tx = contract.methods.recordLog(anchorHash);

      // Estimate gas
      const gas = await tx.estimateGas({ from: account.address });

      // Send with explicit nonce
      const receipt = await tx.send({
        from: account.address,
        gas: gas.toString(),
        nonce: nonce
      });

      // 6. Update database with chain data
      await pool.query(`
        UPDATE usage_logs
        SET
          local_hash = $1,
          tx_nonce = $2,
          prev_tx_nonce = $3,
          block_number = $4,
          anchor_hash = $5,
          blockchain_tx_hash = $6
        WHERE id = $7
      `, [
        '0x' + localHash,
        nonce,
        prevNonce,
        receipt.blockNumber,
        isAnchor ? anchorHash : null,
        receipt.transactionHash,
        logData.logId
      ]);

      const logType = isAnchor ? '⚓ ANCHOR' : '📝 LOG';
      console.log(`${logType} #${logId} (nonce: ${nonce}, tx: ${receipt.transactionHash.substring(0, 10)}...)`);

      return {
        success: true,
        logId,
        nonce,
        txHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        isAnchor,
        gasUsed: receipt.gasUsed
      };

    } catch (error) {
      console.error(`❌ Failed to record log to blockchain:`, error.message);
      throw error;
    }
  }

  /**
   * Resume chain state after restart
   */
  async resumeChain() {
    console.log('🔄 Resuming audit chain...');

    // Get blockchain state
    const blockchainNonce = await this.getNextNonce();
    console.log(`   Blockchain nonce: ${blockchainNonce}`);

    // Get database state
    const dbState = await pool.query(`
      SELECT
        COUNT(*) as total_logs,
        MAX(tx_nonce) as last_nonce,
        MAX(CAST(id AS BIGINT)) as last_log_id
      FROM usage_logs
      WHERE tx_nonce IS NOT NULL
    `);

    const totalLogs = parseInt(dbState.rows[0].total_logs);
    const lastNonce = dbState.rows[0].last_nonce;
    const lastLogId = dbState.rows[0].last_log_id;

    console.log(`   Database: ${totalLogs} logs (last nonce: ${lastNonce}, last ID: ${lastLogId})`);

    // Sanity check
    if (lastNonce !== null && blockchainNonce <= lastNonce) {
      console.warn(`⚠️  Warning: Blockchain nonce (${blockchainNonce}) <= last DB nonce (${lastNonce})`);
      console.warn(`   This may indicate pending transactions or nonce mismatch`);
    }

    this.initialized = true;

    return {
      blockchainNonce,
      totalLogs,
      lastNonce,
      ready: true
    };
  }

  /**
   * Verify a log entry
   */
  async verifyLog(logId) {
    const result = await pool.query(`
      SELECT * FROM usage_logs WHERE id = $1
    `, [logId]);

    if (result.rows.length === 0) {
      return { valid: false, reason: 'Log not found' };
    }

    const log = result.rows[0];

    // 1. Verify transaction exists with correct nonce
    const tx = await web3.eth.getTransaction(log.blockchain_tx_hash);
    if (!tx) {
      return { valid: false, reason: 'Transaction not found on blockchain' };
    }

    if (parseInt(tx.nonce) !== log.tx_nonce) {
      return { valid: false, reason: `Nonce mismatch (chain: ${tx.nonce}, db: ${log.tx_nonce})` };
    }

    // 2. Recalculate hash and verify
    const logData = {
      consumerId: log.consumer_id,
      provider: log.provider,
      model: log.model,
      promptTokens: log.prompt_tokens,
      completionTokens: log.completion_tokens,
      requestHash: log.request_hash,
      responseHash: log.response_hash
    };

    const calculatedHash = this.calculateHash(logData, log.prev_tx_nonce);

    if ('0x' + calculatedHash !== log.local_hash) {
      return { valid: false, reason: 'Hash mismatch - data may have been tampered' };
    }

    // 3. If anchor log, verify anchor hash on blockchain
    if (log.anchor_hash) {
      const receipt = await web3.eth.getTransactionReceipt(log.blockchain_tx_hash);
      // TODO: Parse events to verify anchor hash
      // For now, just check that transaction succeeded
      if (!receipt.status) {
        return { valid: false, reason: 'Transaction failed on blockchain' };
      }
    }

    return {
      valid: true,
      txHash: log.blockchain_tx_hash,
      nonce: log.tx_nonce,
      blockNumber: log.block_number
    };
  }
}

const auditChainManager = new AuditChainManager();

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

    console.log('✅ Blockchain initialized (Nonce Chain Mode)');
    console.log('   Contract:', CONTRACT_ADDRESS);
    console.log('   Account:', account.address);
    console.log('   Anchor interval:', ANCHOR_INTERVAL);

    // Resume chain state
    auditChainManager.resumeChain().catch(err => {
      console.error('Failed to resume chain:', err.message);
    });

    return true;
  } catch (error) {
    console.error('❌ Failed to initialize blockchain:', error.message);
    return false;
  }
}

/**
 * Log a request to the blockchain using nonce chain
 */
export async function logToBlockchain(logData) {
  return await auditChainManager.recordLog(logData);
}

/**
 * Verify a log entry
 */
export async function verifyLog(logId) {
  return await auditChainManager.verifyLog(logId);
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
  const anchorInterval = await contract.methods.getAnchorInterval().call();

  // Get wallet balance
  const balanceWei = await web3.eth.getBalance(account.address);
  const balanceEth = web3.utils.fromWei(balanceWei, 'ether');

  // Get database stats
  const dbStats = await pool.query(`
    SELECT
      COUNT(*) as total_logs,
      COUNT(anchor_hash) as total_anchors,
      MAX(tx_nonce) as last_nonce
    FROM usage_logs
    WHERE tx_nonce IS NOT NULL
  `);

  // Estimate costs
  const regularLogGas = 63371;  // From HPP Sepolia actual data (L2 only)
  const anchorLogGas = 1570907; // From HPP Sepolia actual data (L2 + L1 data)
  const gasPrice = await web3.eth.getGasPrice();

  const regularCost = web3.utils.fromWei((BigInt(regularLogGas) * BigInt(gasPrice)).toString(), 'ether');
  const anchorCost = web3.utils.fromWei((BigInt(anchorLogGas) * BigInt(gasPrice)).toString(), 'ether');

  // Average cost (90% regular, 10% anchor)
  const avgCostPerLog = (parseFloat(regularCost) * 0.9) + (parseFloat(anchorCost) * 0.1);
  const estimatedLogsRemaining = Math.floor(parseFloat(balanceEth) / avgCostPerLog);

  return {
    totalLogs: totalLogs.toString(),
    version,
    anchorInterval: anchorInterval.toString(),
    contractAddress: CONTRACT_ADDRESS,
    walletAddress: account.address,
    balance: balanceEth,
    estimatedLogsRemaining,
    network: 'HPP Sepolia',
    database: {
      totalLogs: dbStats.rows[0].total_logs,
      totalAnchors: dbStats.rows[0].total_anchors,
      lastNonce: dbStats.rows[0].last_nonce
    },
    costs: {
      regularLog: regularCost + ' ETH',
      anchorLog: anchorCost + ' ETH',
      average: avgCostPerLog.toFixed(10) + ' ETH'
    }
  };
}

/**
 * Check if blockchain is enabled/configured
 */
export function isBlockchainEnabled() {
  return !!(contract && account);
}
