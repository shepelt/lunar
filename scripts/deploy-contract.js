import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import solc from 'solc';
import { Web3 } from 'web3';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

// Configuration
const PRIVATE_KEY = process.env.BLOCKCHAIN_PRIVATE_KEY;
const RPC_URL = process.env.BLOCKCHAIN_RPC_URL || 'https://sepolia.hpp.io';

if (!PRIVATE_KEY) {
  console.error('❌ BLOCKCHAIN_PRIVATE_KEY not set in .env file');
  process.exit(1);
}

async function compileContract() {
  console.log('📝 Compiling contract...');

  // Read contract source
  const contractPath = path.join(__dirname, '..', 'contracts', 'AuditLog.sol');
  const source = fs.readFileSync(contractPath, 'utf8');

  // Compile input
  const input = {
    language: 'Solidity',
    sources: {
      'AuditLog.sol': {
        content: source
      }
    },
    settings: {
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode']
        }
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  // Check for errors
  if (output.errors) {
    const errors = output.errors.filter(e => e.severity === 'error');
    if (errors.length > 0) {
      console.error('❌ Compilation errors:');
      errors.forEach(err => console.error(err.formattedMessage));
      throw new Error('Compilation failed');
    }
  }

  const contract = output.contracts['AuditLog.sol']['AuditLog'];

  console.log('✅ Contract compiled successfully!');

  return {
    abi: contract.abi,
    bytecode: contract.evm.bytecode.object
  };
}

async function deployContract() {
  console.log('\n🚀 Deploying contract to HPP Sepolia...');

  // Compile contract
  const { abi, bytecode } = await compileContract();

  // Connect to network
  const web3 = new Web3(RPC_URL);

  // Load wallet
  const account = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY);
  web3.eth.accounts.wallet.add(account);

  console.log('📍 Deploying from:', account.address);

  // Check balance
  const balanceWei = await web3.eth.getBalance(account.address);
  const balanceEth = web3.utils.fromWei(balanceWei, 'ether');
  console.log('💰 Balance:', balanceEth, 'ETH');

  if (balanceWei === 0n) {
    throw new Error('Insufficient balance for deployment');
  }

  // Create contract instance
  const contract = new web3.eth.Contract(abi);

  // Estimate gas
  const deployTx = contract.deploy({
    data: '0x' + bytecode
  });

  const gas = await deployTx.estimateGas({ from: account.address });
  const gasPrice = await web3.eth.getGasPrice();
  const estimatedCost = web3.utils.fromWei((gas * gasPrice).toString(), 'ether');

  console.log('⛽ Estimated gas:', gas.toString());
  console.log('💸 Estimated cost:', estimatedCost, 'ETH');

  // Deploy
  console.log('⏳ Deploying contract...');

  const deployedContract = await deployTx.send({
    from: account.address,
    gas: gas.toString(),
    gasPrice: gasPrice.toString()
  });

  const contractAddress = deployedContract.options.address;

  console.log('✅ Contract deployed!');
  console.log('📍 Contract address:', contractAddress);
  console.log('🔗 Explorer:', `https://sepolia-explorer.hpp.io/address/${contractAddress}`);

  // Save deployment info
  const deploymentInfo = {
    address: contractAddress,
    abi: abi,
    network: 'HPP Sepolia',
    chainId: 181228,
    rpcUrl: RPC_URL,
    deployedAt: new Date().toISOString(),
    deployer: account.address
  };

  const outputPath = path.join(__dirname, '..', 'contracts', 'deployed.json');
  fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));

  console.log('💾 Deployment info saved to:', outputPath);

  return deploymentInfo;
}

// Run deployment
deployContract()
  .then(() => {
    console.log('\n🎉 Deployment complete!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Deployment failed:', error.message);
    process.exit(1);
  });
