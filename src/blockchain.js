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

let web3;
let contract;
let account;

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
 * Log a request to the blockchain
 * @param {Object} logData - The log data
 * @returns {Promise<Object>} Transaction receipt
 */
export async function logToBlockchain(logData) {
  if (!contract || !account) {
    throw new Error('Blockchain not initialized');
  }

  const {
    logId,
    consumerId,
    provider,
    model,
    promptTokens,
    completionTokens,
    requestHash,
    responseHash
  } = logData;

  try {
    // Send transaction in background (don't wait for confirmation)
    const tx = contract.methods.logRequest(
      logId,
      consumerId,
      provider,
      model,
      promptTokens,
      completionTokens,
      requestHash,
      responseHash
    );

    // Estimate gas
    const gas = await tx.estimateGas({ from: account.address });

    // Send transaction (returns promise, but we don't wait)
    tx.send({
      from: account.address,
      gas: gas.toString()
    }).then(async receipt => {
      console.log(`✅ Blockchain log: ${logId} (tx: ${receipt.transactionHash})`);

      // Update database with transaction hash
      try {
        await pool.query(
          'UPDATE usage_logs SET blockchain_tx_hash = $1 WHERE id = $2',
          [receipt.transactionHash, logId]
        );
      } catch (dbError) {
        console.error(`Failed to save tx hash for ${logId}:`, dbError.message);
      }
    }).catch(error => {
      console.error(`❌ Blockchain log failed for ${logId}:`, error.message);
    });

    // Return immediately (async logging)
    return { status: 'pending', logId };
  } catch (error) {
    console.error('Failed to log to blockchain:', error.message);
    throw error;
  }
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
    network: 'HPP Sepolia'
  };
}
