import crypto from 'crypto';

/**
 * Merkle Tree implementation for audit log batching
 * Allows efficient verification of individual logs within a batch
 */

/**
 * Hash a value using SHA256
 */
function hash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Combine two hashes (for Merkle tree construction)
 */
function combineHashes(left, right) {
  return hash(left + right);
}

/**
 * Build a Merkle tree from an array of data items
 * @param {Array} items - Array of data items to hash (or pre-computed hashes if prehashed=true)
 * @param {boolean} prehashed - If true, items are already hex hashes and won't be rehashed
 * @returns {Object} - { root, tree, leaves }
 */
export function buildMerkleTree(items, prehashed = false) {
  if (items.length === 0) {
    throw new Error('Cannot build Merkle tree from empty array');
  }

  // Level 0: Hash all items to create leaves (unless already hashed)
  const leaves = prehashed ? items : items.map(item => {
    const itemString = typeof item === 'string' ? item : JSON.stringify(item);
    return hash(itemString);
  });

  // Build tree level by level
  const tree = [leaves];
  let currentLevel = leaves;

  while (currentLevel.length > 1) {
    const nextLevel = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1];

      if (right) {
        // Pair exists - combine both
        nextLevel.push(combineHashes(left, right));
      } else {
        // Odd number - duplicate last node
        nextLevel.push(combineHashes(left, left));
      }
    }

    tree.push(nextLevel);
    currentLevel = nextLevel;
  }

  const root = currentLevel[0];

  return {
    root,
    tree,
    leaves
  };
}

/**
 * Generate a Merkle proof for a specific leaf index
 * @param {Array} tree - Full Merkle tree from buildMerkleTree
 * @param {number} leafIndex - Index of the leaf to prove
 * @returns {Array} - Array of proof elements { hash, position: 'left'|'right' }
 */
export function generateMerkleProof(tree, leafIndex) {
  if (leafIndex < 0 || leafIndex >= tree[0].length) {
    throw new Error('Leaf index out of bounds');
  }

  const proof = [];
  let currentIndex = leafIndex;

  // Traverse up the tree
  for (let level = 0; level < tree.length - 1; level++) {
    const currentLevel = tree[level];
    const isRightNode = currentIndex % 2 === 1;

    let siblingIndex;
    let position;

    if (isRightNode) {
      // Current node is on the right, sibling is on the left
      siblingIndex = currentIndex - 1;
      position = 'left';
    } else {
      // Current node is on the left, sibling is on the right
      siblingIndex = currentIndex + 1;
      position = 'right';
    }

    // Get sibling hash (or duplicate if it doesn't exist)
    const siblingHash = siblingIndex < currentLevel.length
      ? currentLevel[siblingIndex]
      : currentLevel[currentIndex];

    proof.push({
      hash: siblingHash,
      position
    });

    // Move to parent index in next level
    currentIndex = Math.floor(currentIndex / 2);
  }

  return proof;
}

/**
 * Verify a Merkle proof for a leaf
 * @param {string} leafHash - Hash of the leaf to verify
 * @param {Array} proof - Merkle proof from generateMerkleProof
 * @param {string} expectedRoot - Expected Merkle root
 * @returns {boolean} - True if proof is valid
 */
export function verifyMerkleProof(leafHash, proof, expectedRoot) {
  let currentHash = leafHash;

  // Apply each proof element
  for (const proofElement of proof) {
    if (proofElement.position === 'left') {
      currentHash = combineHashes(proofElement.hash, currentHash);
    } else {
      currentHash = combineHashes(currentHash, proofElement.hash);
    }
  }

  return currentHash === expectedRoot;
}

/**
 * Hash a log entry for Merkle tree inclusion
 * @param {Object} logData - Log data object
 * @returns {string} - Hex hash of the log
 */
export function hashLogEntry(logData) {
  const dataString = JSON.stringify({
    consumer_id: logData.consumerId || logData.consumer_id,
    provider: logData.provider,
    model: logData.model,
    prompt_tokens: logData.promptTokens || logData.prompt_tokens,
    completion_tokens: logData.completionTokens || logData.completion_tokens,
    request_hash: logData.requestHash || logData.request_hash,
    response_hash: logData.responseHash || logData.response_hash
  });

  return hash(dataString);
}
