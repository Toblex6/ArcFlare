// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ERC8004ValidationRegistry {

    struct ValidationJob {
        bytes32 taskHash;       // Commitment to the machine computation job
        string requestURI;      // Detailed execution context
        address targetValidator;// Authorized validator or TEE oracle engine address
        uint8 status;           // 0 = Pending, 1 = Passed, 2 = Failed
        string attestationURI;  // Link to the cryptographic ZK proof or TEE enclave attestation doc
    }

    // Maps global validationId => Job Configuration details
    mapping(bytes32 => ValidationJob) private _validationRegistry;

    event ValidationRequested(bytes32 indexed validationId, uint256 indexed agentId, bytes32 taskHash, address validator);
    event ValidationFinalized(bytes32 indexed validationId, uint8 finalStatus, string attestationURI);

    /**
     * @notice Requests independent verification for a highly sensitive operational output.
     */
    function requestValidation(
        uint256 agentId,
        bytes32 taskHash,
        string calldata requestURI,
        address validator
    ) external returns (bytes32) {
        bytes32 validationId = keccak256(abi.encodePacked(agentId, taskHash, msg.sender, block.timestamp));
        
        _validationRegistry[validationId] = ValidationJob({
            taskHash: taskHash,
            requestURI: requestURI,
            targetValidator: validator,
            status: 0,
            attestationURI: ""
        });

        emit ValidationRequested(validationId, agentId, taskHash, validator);
        return validationId;
    }

    /**
     * @notice Submits the definitive validation assertion along with cryptographic evidence.
     */
    function submitValidationResult(
        bytes32 validationId,
        uint8 finalStatus,
        string calldata attestationURI
    ) external {
        ValidationJob storage job = _validationRegistry[validationId];
        require(msg.sender == job.targetValidator, "ERC8004: Unauthorized validator address");
        require(job.status == 0, "ERC8004: Job already finalized");
        require(finalStatus == 1 || finalStatus == 2, "ERC8004: Invalid resolution status");

        job.status = finalStatus;
        job.attestationURI = attestationURI;

        emit ValidationFinalized(validationId, finalStatus, attestationURI);
    }

    /**
     * @notice External view to inspect validation statuses before releasing settlement escrow assets.
     */
    function getValidationDetails(bytes32 validationId) external view returns (ValidationJob memory) {
        return _validationRegistry[validationId];
    }
}