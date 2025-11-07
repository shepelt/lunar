import { Web3 } from 'web3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const PRIVATE_KEY = process.env.BLOCKCHAIN_PRIVATE_KEY;
const RPC_URL = process.env.BLOCKCHAIN_RPC_URL || 'https://sepolia.hpp.io';

if (!PRIVATE_KEY) {
  console.error('❌ BLOCKCHAIN_PRIVATE_KEY not set in .env');
  process.exit(1);
}

async function deploy() {
  try {
    // Load compiled contract
    const deploymentPath = path.join(__dirname, 'deployed-merkle.json');
    const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

    // Connect to network
    const web3 = new Web3(RPC_URL);
    const account = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY);
    web3.eth.accounts.wallet.add(account);

    console.log('🚀 Deploying AuditMerkle contract...');
    console.log('   Network:', RPC_URL);
    console.log('   Deployer:', account.address);

    // Get balance
    const balanceWei = await web3.eth.getBalance(account.address);
    const balanceEth = web3.utils.fromWei(balanceWei, 'ether');
    console.log('   Balance:', balanceEth, 'ETH');

    // Deploy contract
    const contract = new web3.eth.Contract(deployment.abi);
    const deployTx = contract.deploy({
      data: '0x' + deployment.bytecode
    });

    // Estimate gas
    const gas = await deployTx.estimateGas({ from: account.address });
    console.log('   Estimated gas:', gas.toString());

    // Send deployment transaction
    const receipt = await deployTx.send({
      from: account.address,
      gas: gas.toString()
    });

    console.log('\n✅ Contract deployed successfully!');
    console.log('   Contract address:', receipt.options.address);
    console.log('   Transaction hash:', receipt.transactionHash);
    console.log('   Block number:', receipt.blockNumber);
    console.log('   Gas used:', receipt.gasUsed.toString());

    console.log('\n📝 Add this to your .env file:');
    console.log(`BLOCKCHAIN_CONTRACT_ADDRESS=${receipt.options.address}`);

    // Verify deployment
    const deployedContract = new web3.eth.Contract(deployment.abi, receipt.options.address);
    const version = await deployedContract.methods.version().call();
    const totalBatches = await deployedContract.methods.totalBatches().call();

    console.log('\n✓ Contract verification:');
    console.log('  Version:', version);
    console.log('  Total batches:', totalBatches.toString());

  } catch (error) {
    console.error('❌ Deployment failed:', error.message);
    process.exit(1);
  }
}

deploy();
