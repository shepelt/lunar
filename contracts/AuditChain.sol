// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title AuditChain
 * @dev Nonce-based audit logging for LLM gateway requests
 * Uses minimal on-chain data with cryptographic hash chain for tamper-evidence
 *
 * Cost optimization:
 * - 90% of transactions: empty calldata (L2 execution only)
 * - 10% of transactions: 12-byte anchor hash (periodic verification checkpoints)
 * - Full audit data stored off-chain in database
 * - Transaction nonces provide ordering guarantee
 * - Hash chain provides tamper-evidence
 */
contract AuditChain {
    // Minimal event - just creates a transaction with a nonce
    event LogRecorded(uint256 indexed logId);

    // Anchor event every N logs for quick verification
    // Stores first 12 bytes of hash for cost efficiency
    event ChainAnchor(uint256 indexed logId, bytes12 indexed anchorHash);

    // Total number of logs recorded
    uint256 public totalLogs;

    // Anchor interval - post hash every N logs
    uint256 public constant ANCHOR_INTERVAL = 10;

    /**
     * @dev Record a log entry to the blockchain
     * @param anchorHash First 12 bytes of the log hash (only for anchor logs, 0x000... for regular)
     *
     * How it works:
     * - Each call increments totalLogs and emits LogRecorded event
     * - Every 10th log (totalLogs % 10 == 0) also emits ChainAnchor with partial hash
     * - Transaction nonce provides strict ordering (cannot be skipped or reordered)
     * - Full data is stored in database with hash = SHA256(data || previous_nonce)
     * - Anchor hashes enable quick verification without checking entire chain
     */
    function recordLog(bytes12 anchorHash) external {
        emit LogRecorded(totalLogs);

        // Emit anchor hash every ANCHOR_INTERVAL logs
        if (totalLogs % ANCHOR_INTERVAL == 0) {
            emit ChainAnchor(totalLogs, anchorHash);
        }

        totalLogs++;
    }

    /**
     * @dev Get contract version
     */
    function version() public pure returns (string memory) {
        return "2.0.0-nonce-chain";
    }

    /**
     * @dev Get anchor interval
     */
    function getAnchorInterval() public pure returns (uint256) {
        return ANCHOR_INTERVAL;
    }
}
