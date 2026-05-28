// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ERC8004ReputationRegistry {
    
    struct Feedback {
        address submitter;
        uint8 score;       // Scale of 0-100 following ERC-8004 spec
        bytes32 categoryTag; // e.g., keccak256("latency") or keccak256("uptime")
        string contextURI;  // Off-chain proof link (e.g., settling invoice receipt)
    }

    // Maps agentId => array of historical feedback entries
    mapping(uint256 => Feedback[]) private _agentReputationLogs;

    event FeedbackSubmitted(
        uint256 indexed agentId, 
        address indexed submitter, 
        uint8 score, 
        bytes32 indexed categoryTag, 
        string contextURI
    );

    /**
     * @notice Submits a verifiable performance rating for a specific agent passport.
     */
    function giveFeedback(
        uint256 agentId,
        uint8 score,
        bytes32 categoryTag,
        string calldata contextURI
    ) external {
        require(score <= 100, "ERC8004: Score bounded between 0-100");

        Feedback memory executionFeedback = Feedback({
            submitter: msg.sender,
            score: score,
            categoryTag: categoryTag,
            contextURI: contextURI
        });

        _agentReputationLogs[agentId].push(executionFeedback);

        emit FeedbackSubmitted(agentId, msg.sender, score, categoryTag, contextURI);
    }

    /**
     * @notice Fetches the historical feedback entries for analysis.
     */
    function getReputationLogs(uint256 agentId) external view returns (Feedback[] memory) {
        return _agentReputationLogs[agentId];
    }
}