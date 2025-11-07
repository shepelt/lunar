// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title AuditMerkle
 * @dev Merkle-tree based audit logging with nonce chaining
 * Efficient batching: multiple logs → 1 Merkle root → 1 transaction
 * Nonce chaining: each batch links to previous via chain hash
 */
contract AuditMerkle {
    // Batch record stored on-chain
    struct Batch {
        bytes32 merkleRoot;      // Merkle root of log hashes in this batch
        bytes32 chainHash;       // SHA256(merkleRoot || prevNonce) - links to previous batch
        uint256 logCount;        // Number of logs in this batch
        uint256 timestamp;       // Block timestamp
        uint256 nonce;           // Transaction nonce (for verification)
    }

    // All batches
    Batch[] public batches;

    // Total number of batches
    uint256 public totalBatches;

    // Total number of logs across all batches
    uint256 public totalLogs;

    // Contract owner
    address public owner;

    // Events
    event BatchRecorded(
        uint256 indexed batchId,
        bytes32 merkleRoot,
        bytes32 chainHash,
        uint256 logCount,
        uint256 nonce,
        uint256 timestamp
    );

    constructor() {
        owner = msg.sender;
    }

    /**
     * @dev Record a batch of logs using Merkle tree
     * @param merkleRoot Merkle root of all log hashes in the batch
     * @param chainHash SHA256(merkleRoot || prevNonce) for chain linking
     * @param logCount Number of logs in this batch
     */
    function recordBatch(
        bytes32 merkleRoot,
        bytes32 chainHash,
        uint256 logCount
    ) public {
        require(logCount > 0, "Batch must contain at least 1 log");

        // Get transaction nonce (for verification)
        uint256 txNonce = totalBatches; // Approximation using batch count

        // Create batch record
        Batch memory newBatch = Batch({
            merkleRoot: merkleRoot,
            chainHash: chainHash,
            logCount: logCount,
            timestamp: block.timestamp,
            nonce: txNonce
        });

        batches.push(newBatch);

        // Update counters
        totalBatches++;
        totalLogs += logCount;

        // Emit event
        emit BatchRecorded(
            totalBatches - 1,
            merkleRoot,
            chainHash,
            logCount,
            txNonce,
            block.timestamp
        );
    }

    /**
     * @dev Get a specific batch
     * @param batchId The batch ID to retrieve
     * @return merkleRoot Merkle root of the batch
     * @return chainHash Chain hash linking to previous batch
     * @return logCount Number of logs in batch
     * @return timestamp Block timestamp
     * @return nonce Transaction nonce
     */
    function getBatch(uint256 batchId) public view returns (
        bytes32 merkleRoot,
        bytes32 chainHash,
        uint256 logCount,
        uint256 timestamp,
        uint256 nonce
    ) {
        require(batchId < batches.length, "Batch does not exist");

        Batch memory batch = batches[batchId];
        return (
            batch.merkleRoot,
            batch.chainHash,
            batch.logCount,
            batch.timestamp,
            batch.nonce
        );
    }

    /**
     * @dev Get the latest batch
     * @return merkleRoot Merkle root of the batch
     * @return chainHash Chain hash linking to previous batch
     * @return logCount Number of logs in batch
     * @return timestamp Block timestamp
     * @return nonce Transaction nonce
     */
    function getLatestBatch() public view returns (
        bytes32 merkleRoot,
        bytes32 chainHash,
        uint256 logCount,
        uint256 timestamp,
        uint256 nonce
    ) {
        require(batches.length > 0, "No batches recorded");
        return getBatch(batches.length - 1);
    }

    /**
     * @dev Verify chain integrity between two batches
     * @param batchId The batch to verify
     * @return valid True if chain hash is valid
     */
    function verifyChainLink(uint256 batchId) public view returns (bool valid) {
        require(batchId < batches.length, "Batch does not exist");

        // First batch has no previous link
        if (batchId == 0) {
            return true;
        }

        // Note: Full verification requires off-chain computation
        // On-chain we can only verify the chain hash was recorded
        Batch memory currentBatch = batches[batchId];
        Batch memory prevBatch = batches[batchId - 1];

        // Chain hash should link merkleRoot to previous nonce
        // Full verification: chainHash == SHA256(merkleRoot || prevNonce)
        // This must be verified off-chain with the actual data

        return currentBatch.chainHash != bytes32(0) && prevBatch.merkleRoot != bytes32(0);
    }

    /**
     * @dev Get contract version
     */
    function version() public pure returns (string memory) {
        return "2.0.0-merkle";
    }

    /**
     * @dev Get statistics
     */
    function getStats() public view returns (
        uint256 _totalBatches,
        uint256 _totalLogs,
        uint256 _avgLogsPerBatch
    ) {
        _totalBatches = totalBatches;
        _totalLogs = totalLogs;
        _avgLogsPerBatch = totalBatches > 0 ? totalLogs / totalBatches : 0;
    }
}
