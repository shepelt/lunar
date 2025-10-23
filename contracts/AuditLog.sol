// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title AuditLog
 * @dev Immutable audit logging for LLM gateway requests
 * Uses events for gas-efficient, immutable, and queryable logs
 */
contract AuditLog {
    // Event emitted when a request is logged
    event RequestLogged(
        string indexed logId,           // Unique log identifier (indexed for searching)
        string indexed consumerId,      // Consumer who made the request (indexed)
        string indexed provider,        // LLM provider (indexed)
        string model,                   // Model used
        uint256 timestamp,              // Request timestamp
        uint256 promptTokens,           // Input tokens
        uint256 completionTokens,       // Output tokens
        bytes32 requestHash,            // Hash of request data
        bytes32 responseHash            // Hash of response data
    );

    // Contract owner (for potential upgrades/admin functions)
    address public owner;

    // Total number of logs (for statistics)
    uint256 public totalLogs;

    constructor() {
        owner = msg.sender;
    }

    /**
     * @dev Log an LLM request to the blockchain
     * @param logId Unique identifier for this log entry
     * @param consumerId Consumer who made the request
     * @param provider LLM provider (e.g., "openai")
     * @param model Model used (e.g., "gpt-5")
     * @param promptTokens Number of input tokens
     * @param completionTokens Number of output tokens
     * @param requestHash SHA256 hash of request data
     * @param responseHash SHA256 hash of response data
     */
    function logRequest(
        string memory logId,
        string memory consumerId,
        string memory provider,
        string memory model,
        uint256 promptTokens,
        uint256 completionTokens,
        bytes32 requestHash,
        bytes32 responseHash
    ) public {
        // Emit event (permanently stored in blockchain logs)
        emit RequestLogged(
            logId,
            consumerId,
            provider,
            model,
            block.timestamp,
            promptTokens,
            completionTokens,
            requestHash,
            responseHash
        );

        // Increment counter
        totalLogs++;
    }

    /**
     * @dev Batch log multiple requests (more gas efficient)
     */
    function logRequestBatch(
        string[] memory logIds,
        string[] memory consumerIds,
        string[] memory providers,
        string[] memory models,
        uint256[] memory promptTokens,
        uint256[] memory completionTokens,
        bytes32[] memory requestHashes,
        bytes32[] memory responseHashes
    ) public {
        require(
            logIds.length == consumerIds.length &&
            logIds.length == providers.length &&
            logIds.length == models.length &&
            logIds.length == promptTokens.length &&
            logIds.length == completionTokens.length &&
            logIds.length == requestHashes.length &&
            logIds.length == responseHashes.length,
            "Array lengths must match"
        );

        for (uint256 i = 0; i < logIds.length; i++) {
            emit RequestLogged(
                logIds[i],
                consumerIds[i],
                providers[i],
                models[i],
                block.timestamp,
                promptTokens[i],
                completionTokens[i],
                requestHashes[i],
                responseHashes[i]
            );
        }

        totalLogs += logIds.length;
    }

    /**
     * @dev Get contract version
     */
    function version() public pure returns (string memory) {
        return "1.0.0";
    }
}
