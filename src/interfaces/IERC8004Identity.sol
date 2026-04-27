// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IERC8004Identity
/// @notice ERC-8004 v2 Identity Registry interface (subset).
/// @dev See https://eips.ethereum.org/EIPS/eip-8004 — Identity Registry section.
interface IERC8004Identity {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    event Registered(
        uint256 indexed agentId,
        string agentURI,
        address indexed owner
    );
    event URIUpdated(
        uint256 indexed agentId,
        string newURI,
        address indexed updatedBy
    );
    event MetadataSet(
        uint256 indexed agentId,
        string indexed indexedMetadataKey,
        string metadataKey,
        bytes metadataValue
    );

    function register(
        string calldata agentURI,
        MetadataEntry[] calldata metadata
    ) external returns (uint256 agentId);

    function register(
        string calldata agentURI
    ) external returns (uint256 agentId);

    function register() external returns (uint256 agentId);

    function setAgentURI(uint256 agentId, string calldata newURI) external;

    function getMetadata(
        uint256 agentId,
        string calldata metadataKey
    ) external view returns (bytes memory);

    function setMetadata(
        uint256 agentId,
        string calldata metadataKey,
        bytes calldata metadataValue
    ) external;

    function setAgentWallet(
        uint256 agentId,
        address newWallet,
        uint256 deadline,
        bytes calldata signature
    ) external;

    function getAgentWallet(uint256 agentId) external view returns (address);

    function unsetAgentWallet(uint256 agentId) external;
}
