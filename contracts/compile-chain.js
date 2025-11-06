#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import solc from 'solc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the contract source
const contractPath = path.join(__dirname, 'AuditChain.sol');
const source = fs.readFileSync(contractPath, 'utf8');

// Compile
const input = {
  language: 'Solidity',
  sources: {
    'AuditChain.sol': {
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

console.log('Compiling AuditChain.sol...');
const output = JSON.parse(solc.compile(JSON.stringify(input)));

// Check for errors
if (output.errors) {
  const errors = output.errors.filter(e => e.severity === 'error');
  if (errors.length > 0) {
    console.error('Compilation errors:');
    errors.forEach(err => console.error(err.formattedMessage));
    process.exit(1);
  }

  // Show warnings
  const warnings = output.errors.filter(e => e.severity === 'warning');
  if (warnings.length > 0) {
    console.warn('Compilation warnings:');
    warnings.forEach(warn => console.warn(warn.formattedMessage));
  }
}

// Extract compiled contract
const contract = output.contracts['AuditChain.sol']['AuditChain'];
const abi = contract.abi;
const bytecode = contract.evm.bytecode.object;

// Save to deployed.json (will be updated with address after deployment)
const deployment = {
  contractName: 'AuditChain',
  abi: abi,
  bytecode: '0x' + bytecode,
  version: '2.0.0-nonce-chain',
  compiler: {
    name: 'solc',
    version: solc.version()
  },
  compiledAt: new Date().toISOString()
};

const outputPath = path.join(__dirname, 'deployed-chain.json');
fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2));

console.log('✅ Compilation successful!');
console.log('   ABI saved to:', outputPath);
console.log('   Bytecode size:', bytecode.length / 2, 'bytes');
console.log('\nNext step: Deploy contract with:');
console.log('   node contracts/deploy-chain.js');
