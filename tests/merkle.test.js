import { describe, test, expect } from '@jest/globals';
import { buildMerkleTree, generateMerkleProof, verifyMerkleProof, hashLogEntry } from '../src/merkle.js';

describe('Merkle Tree', () => {
  test('should build tree from single item', () => {
    const items = ['item1'];
    const { root, tree, leaves } = buildMerkleTree(items);

    expect(root).toBeDefined();
    expect(leaves).toHaveLength(1);
    expect(tree).toHaveLength(1); // Only one level (leaf = root)
  });

  test('should build tree from multiple items', () => {
    const items = ['item1', 'item2', 'item3', 'item4'];
    const { root, tree, leaves } = buildMerkleTree(items);

    expect(root).toBeDefined();
    expect(leaves).toHaveLength(4);
    expect(tree.length).toBeGreaterThan(1); // Multiple levels
  });

  test('should generate and verify proof for leaf', () => {
    const items = ['item1', 'item2', 'item3', 'item4'];
    const { root, tree, leaves } = buildMerkleTree(items);

    // Generate proof for item at index 2
    const proof = generateMerkleProof(tree, 2);
    const leafHash = leaves[2];

    // Verify proof
    const isValid = verifyMerkleProof(leafHash, proof, root);

    expect(isValid).toBe(true);
  });

  test('should fail verification with wrong leaf', () => {
    const items = ['item1', 'item2', 'item3', 'item4'];
    const { root, tree } = buildMerkleTree(items);

    // Generate proof for item at index 2
    const proof = generateMerkleProof(tree, 2);

    // Try to verify with wrong leaf hash
    const wrongLeafHash = 'wrong_hash';
    const isValid = verifyMerkleProof(wrongLeafHash, proof, root);

    expect(isValid).toBe(false);
  });

  test('should fail verification with wrong root', () => {
    const items = ['item1', 'item2', 'item3', 'item4'];
    const { tree, leaves } = buildMerkleTree(items);

    // Generate proof for item at index 2
    const proof = generateMerkleProof(tree, 2);
    const leafHash = leaves[2];

    // Try to verify with wrong root
    const wrongRoot = 'wrong_root';
    const isValid = verifyMerkleProof(leafHash, proof, wrongRoot);

    expect(isValid).toBe(false);
  });

  test('should handle odd number of items', () => {
    const items = ['item1', 'item2', 'item3'];
    const { root, tree, leaves } = buildMerkleTree(items);

    // Verify proof for each item
    for (let i = 0; i < items.length; i++) {
      const proof = generateMerkleProof(tree, i);
      const isValid = verifyMerkleProof(leaves[i], proof, root);
      expect(isValid).toBe(true);
    }
  });

  test('should hash log entry consistently', () => {
    const logData = {
      consumerId: 'test-consumer',
      provider: 'openai',
      model: 'gpt-4',
      promptTokens: 100,
      completionTokens: 50,
      requestHash: '0xabc123',
      responseHash: '0xdef456'
    };

    const hash1 = hashLogEntry(logData);
    const hash2 = hashLogEntry(logData);

    // Same input should produce same hash
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/); // Valid SHA256 hex
  });

  test('should handle large batch', () => {
    // Create 100 items
    const items = Array.from({ length: 100 }, (_, i) => `item${i}`);
    const { root, tree, leaves } = buildMerkleTree(items);

    // Verify random items
    const indicesToTest = [0, 25, 50, 75, 99];

    for (const index of indicesToTest) {
      const proof = generateMerkleProof(tree, index);
      const isValid = verifyMerkleProof(leaves[index], proof, root);
      expect(isValid).toBe(true);
    }
  });
});
