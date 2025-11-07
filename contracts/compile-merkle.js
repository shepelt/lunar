import solc from 'solc';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the contract
const contractPath = path.join(__dirname, 'AuditMerkle.sol');
const source = fs.readFileSync(contractPath, 'utf8');

// Compile
const input = {
  language: 'Solidity',
  sources: {
    'AuditMerkle.sol': {
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

console.log('Compiling AuditMerkle.sol...');
const output = JSON.parse(solc.compile(JSON.stringify(input)));

// Check for errors
if (output.errors) {
  output.errors.forEach(error => {
    console.error(error.formattedMessage);
  });

  const hasError = output.errors.some(error => error.severity === 'error');
  if (hasError) {
    process.exit(1);
  }
}

// Extract contract
const contract = output.contracts['AuditMerkle.sol']['AuditMerkle'];

// Save ABI and bytecode
const deployment = {
  abi: contract.abi,
  bytecode: contract.evm.bytecode.object
};

const outputPath = path.join(__dirname, 'deployed-merkle.json');
fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2));

console.log('✅ Contract compiled successfully');
console.log('📄 ABI and bytecode saved to:', outputPath);
console.log('📊 Bytecode size:', contract.evm.bytecode.object.length / 2, 'bytes');
