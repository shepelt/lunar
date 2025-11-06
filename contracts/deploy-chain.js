#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Web3 } from 'web3';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const PRIVATE_KEY = process.env.BLOCKCHAIN_PRIVATE_KEY;
const RPC_URL = process.env.BLOCKCHAIN_RPC_URL || 'https://sepolia.hpp.io';

if (!PRIVATE_KEY) {
  console.error('❌ BLOCKCHAIN_PRIVATE_KEY not set in .env');
  process.exit(1);
}

async function deploy() {
  console.log('🚀 Deploying AuditChain contract...');
  console.log('   Network:', RPC_URL);

  // Load compiled contract
  const deploymentPath = path.join(__dirname, 'deployed-chain.json');
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

  // Connect to network
  const web3 = new Web3(RPC_URL);
  const account = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY);
  web3.eth.accounts.wallet.add(account);

  console.log('   Deployer:', account.address);

  // Check balance
  const balanceWei = await web3.eth.getBalance(account.address);
  const balanceEth = web3.utils.fromWei(balanceWei, 'ether');
  console.log('   Balance:', balanceEth, 'ETH');

  if (parseFloat(balanceEth) < 0.001) {
    console.error('❌ Insufficient balance for deployment');
    process.exit(1);
  }

  // Create contract instance
  const contract = new web3.eth.Contract(deployment.abi);

  // Estimate gas
  const deployTx = contract.deploy({
    data: deployment.bytecode
  });

  const gas = await deployTx.estimateGas({ from: account.address });
  const gasPrice = await web3.eth.getGasPrice();
  const estimatedCost = web3.utils.fromWei((BigInt(gas) * BigInt(gasPrice)).toString(), 'ether');

  console.log('   Estimated gas:', gas);
  console.log('   Estimated cost:', estimatedCost, 'ETH');

  // Deploy
  console.log('\n📤 Sending deployment transaction...');
  const deployed = await deployTx.send({
    from: account.address,
    gas: gas.toString()
  });

  const contractAddress = deployed.options.address;
  console.log('✅ Contract deployed!');
  console.log('   Address:', contractAddress);
  console.log('   Tx:', deployed.transactionHash);

  // Verify contract functions
  console.log('\n🔍 Verifying contract...');
  const version = await deployed.methods.version().call();
  const totalLogs = await deployed.methods.totalLogs().call();
  const anchorInterval = await deployed.methods.getAnchorInterval().call();

  console.log('   Version:', version);
  console.log('   Total logs:', totalLogs);
  console.log('   Anchor interval:', anchorInterval);

  // Update deployment file with address
  deployment.address = contractAddress;
  deployment.transactionHash = deployed.transactionHash;
  deployment.deployedAt = new Date().toISOString();
  deployment.network = RPC_URL;
  deployment.deployer = account.address;

  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));

  console.log('\n✅ Deployment complete!');
  console.log('\nNext steps:');
  console.log('1. Update .env with: BLOCKCHAIN_CONTRACT_ADDRESS=' + contractAddress);
  console.log('2. Update backend to use new contract: cp src/blockchain-chain.js src/blockchain.js');
  console.log('3. Update deployed.json: cp contracts/deployed-chain.json contracts/deployed.json');
  console.log('4. Restart backend to use new contract');
}

deploy().catch(error => {
  console.error('❌ Deployment failed:', error);
  process.exit(1);
});
