// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IERC8004Validation
/// @notice ERC-8004 v2 Validation Registry interface.
/// @dev See https://eips.ethereum.org/EIPS/eip-8004 — Validation Registry section.
interface IERC8004Validation {
    event ValidationRequest(
        address indexed validatorAddress,
        uint256 indexed agentId,
        string requestURI,
        bytes32 indexed requestHash
    );

    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    function getIdentityRegistry() external view returns (address);

    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external;

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;

    function getValidationStatus(
        bytes32 requestHash
    )
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        );

    function getSummary(
        uint256 agentId,
        address[] calldata validatorAddresses,
        string calldata tag
    ) external view returns (uint64 count, uint8 averageResponse);

    function getAgentValidations(
        uint256 agentId
    ) external view returns (bytes32[] memory);

    function getValidatorRequests(
        address validatorAddress
    ) external view returns (bytes32[] memory);
}
