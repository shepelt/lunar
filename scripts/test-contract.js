import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Web3 } from 'web3';
import dotenv from 'dotenv';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

const PRIVATE_KEY = process.env.BLOCKCHAIN_PRIVATE_KEY;
const RPC_URL = process.env.BLOCKCHAIN_RPC_URL || 'https://sepolia.hpp.io';

async function testContract() {
  console.log('🧪 Testing AuditLog contract...\n');

  // Load deployment info
  const deploymentPath = path.join(__dirname, '..', 'contracts', 'deployed.json');
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

  console.log('📍 Contract:', deployment.address);
  console.log('🌐 Network:', deployment.network);

  // Connect to network
  const web3 = new Web3(RPC_URL);
  const account = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY);
  web3.eth.accounts.wallet.add(account);

  console.log('👤 Account:', account.address);

  // Create contract instance
  const contract = new web3.eth.Contract(deployment.abi, deployment.address);

  // Test 1: Check version
  console.log('\n📝 Test 1: Get contract version');
  const version = await contract.methods.version().call();
  console.log('✅ Version:', version);

  // Test 2: Check total logs
  console.log('\n📝 Test 2: Get total logs count');
  const totalLogs = await contract.methods.totalLogs().call();
  console.log('✅ Total logs:', totalLogs.toString());

  // Test 3: Log a test request
  console.log('\n📝 Test 3: Log a test request');

  const testData = {
    logId: crypto.randomUUID(),
    consumerId: 'test-consumer-123',
    provider: 'openai',
    model: 'gpt-5',
    promptTokens: 100,
    completionTokens: 50,
    requestHash: '0x' + crypto.createHash('sha256').update('test request').digest('hex'),
    responseHash: '0x' + crypto.createHash('sha256').update('test response').digest('hex')
  };

  console.log('Request data:', {
    logId: testData.logId,
    consumerId: testData.consumerId,
    provider: testData.provider,
    model: testData.model,
    tokens: `${testData.promptTokens}/${testData.completionTokens}`
  });

  // Estimate gas
  const gas = await contract.methods.logRequest(
    testData.logId,
    testData.consumerId,
    testData.provider,
    testData.model,
    testData.promptTokens,
    testData.completionTokens,
    testData.requestHash,
    testData.responseHash
  ).estimateGas({ from: account.address });

  console.log('⛽ Estimated gas:', gas.toString());

  // Send transaction
  console.log('⏳ Sending transaction...');
  const receipt = await contract.methods.logRequest(
    testData.logId,
    testData.consumerId,
    testData.provider,
    testData.model,
    testData.promptTokens,
    testData.completionTokens,
    testData.requestHash,
    testData.responseHash
  ).send({
    from: account.address,
    gas: gas.toString()
  });

  console.log('✅ Transaction confirmed!');
  console.log('📦 Block:', receipt.blockNumber);
  console.log('🔗 Tx Hash:', receipt.transactionHash);
  console.log('🔗 Explorer:', `https://sepolia-explorer.hpp.io/tx/${receipt.transactionHash}`);

  // Check events
  if (receipt.events && receipt.events.RequestLogged) {
    const event = receipt.events.RequestLogged;
    console.log('\n📢 Event emitted:');
    console.log('  Log ID:', event.returnValues.logId);
    console.log('  Consumer:', event.returnValues.consumerId);
    console.log('  Provider:', event.returnValues.provider);
    console.log('  Model:', event.returnValues.model);
    console.log('  Timestamp:', event.returnValues.timestamp);
    console.log('  Prompt Tokens:', event.returnValues.promptTokens);
    console.log('  Completion Tokens:', event.returnValues.completionTokens);
  }

  // Check updated total
  const newTotal = await contract.methods.totalLogs().call();
  console.log('\n📊 New total logs:', newTotal.toString());

  console.log('\n🎉 All tests passed!');
}

testContract()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  });
