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
     * @dev Record a regular log entry (no anchor hash)
     * Optimized for minimal calldata - only 4 bytes (function selector)
     *
     * Used for 90% of logs where we only need the nonce for ordering
     * Full data is stored in database with hash = SHA256(data || previous_nonce)
     */
    function recordLog() external {
        emit LogRecorded(totalLogs);
        totalLogs++;
    }

    /**
     * @dev Record an anchor log entry with hash checkpoint
     * @param anchorHash First 12 bytes of the log hash for verification
     *
     * Used for every 10th log to provide periodic verification checkpoints
     * Calldata: 4 bytes (selector) + 32 bytes (padded hash) = 36 bytes
     */
    function recordAnchor(bytes12 anchorHash) external {
        emit LogRecorded(totalLogs);
        emit ChainAnchor(totalLogs, anchorHash);
        totalLogs++;
    }

    /**
     * @dev Get contract version
     */
    function version() public pure returns (string memory) {
        return "2.1.0-optimized";
    }

    /**
     * @dev Get anchor interval
     */
    function getAnchorInterval() public pure returns (uint256) {
        return ANCHOR_INTERVAL;
    }
}
