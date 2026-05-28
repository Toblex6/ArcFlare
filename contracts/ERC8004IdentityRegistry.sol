// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ERC8004IdentityRegistry is ERC721URIStorage, Ownable {
    uint256 private _nextTokenId;

    event AgentRegistered(uint256 indexed agentId, address indexed owner, string tokenURI);

    constructor() ERC721("ERC8004AgentPassport", "AGENTID") Ownable(msg.sender) {}

    /**
     * @notice Registers a new autonomous AI agent into the global registry.
     * @param agentOwner The wallet address that controls this agent.
     * @param metadataURI The IPFS/HTTPS pointer to the agent's registration JSON profile card.
     */
    function registerAgent(address agentOwner, string calldata metadataURI) external returns (uint256) {
        uint256 currentId = _nextTokenId;
        _nextTokenId++;

        _safeMint(agentOwner, currentId);
        _setTokenURI(currentId, metadataURI);

        emit AgentRegistered(currentId, agentOwner, metadataURI);
        return currentId;
    }
}