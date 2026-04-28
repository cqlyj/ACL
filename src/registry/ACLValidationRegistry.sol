// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC8004Validation} from "../interfaces/IERC8004Validation.sol";

/// @title ACLValidationRegistry
/// @notice ERC-8004 v2 Validation Registry.
/// @dev Generic hooks: an agent owner/operator records a validation request,
///      then the validator address records one or more responses. We store the
///      latest response per requestHash and a list of indexes for read paths.
contract ACLValidationRegistry is IERC8004Validation {
    struct RequestRecord {
        address validatorAddress;
        uint256 agentId;
        uint8 response;
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
        bool exists;
    }

    address private _identityRegistry;
    bool private _initialized;

    mapping(bytes32 => RequestRecord) private _requests;
    mapping(uint256 => bytes32[]) private _agentRequests;
    mapping(address => bytes32[]) private _validatorRequests;

    error AlreadyInitialized();
    error NotInitialized();
    error UnknownAgent();
    error NotOwnerOrOperator();
    error UnknownRequest();
    error NotAuthorizedValidator();
    error InvalidResponse();

    /// @notice Bind this registry to an Identity Registry. Single-shot.
    function initialize(address identityRegistry_) external {
        if (_initialized) revert AlreadyInitialized();
        _identityRegistry = identityRegistry_;
        _initialized = true;
    }

    /// @inheritdoc IERC8004Validation
    function getIdentityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    /// @inheritdoc IERC8004Validation
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        if (!_initialized) revert NotInitialized();

        IERC721 identity = IERC721(_identityRegistry);
        address agentOwner = identity.ownerOf(agentId);
        if (
            msg.sender != agentOwner &&
            identity.getApproved(agentId) != msg.sender &&
            !identity.isApprovedForAll(agentOwner, msg.sender)
        ) {
            revert NotOwnerOrOperator();
        }

        RequestRecord storage rec = _requests[requestHash];
        if (!rec.exists) {
            rec.validatorAddress = validatorAddress;
            rec.agentId = agentId;
            rec.exists = true;
            _agentRequests[agentId].push(requestHash);
            _validatorRequests[validatorAddress].push(requestHash);
        }

        emit ValidationRequest(
            validatorAddress,
            agentId,
            requestURI,
            requestHash
        );
    }

    /// @inheritdoc IERC8004Validation
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        RequestRecord storage rec = _requests[requestHash];
        if (!rec.exists) revert UnknownRequest();
        if (msg.sender != rec.validatorAddress) revert NotAuthorizedValidator();
        if (response > 100) revert InvalidResponse();

        rec.response = response;
        rec.responseHash = responseHash;
        rec.tag = tag;
        rec.lastUpdate = block.timestamp;

        emit ValidationResponse(
            rec.validatorAddress,
            rec.agentId,
            requestHash,
            response,
            responseURI,
            responseHash,
            tag
        );
    }

    /// @inheritdoc IERC8004Validation
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
        )
    {
        RequestRecord storage rec = _requests[requestHash];
        if (!rec.exists) revert UnknownRequest();
        return (
            rec.validatorAddress,
            rec.agentId,
            rec.response,
            rec.responseHash,
            rec.tag,
            rec.lastUpdate
        );
    }

    /// @inheritdoc IERC8004Validation
    /// @dev Mean over responses matching the optional validator/tag filters.
    function getSummary(
        uint256 agentId,
        address[] calldata validatorAddresses,
        string calldata tag
    ) external view returns (uint64 count, uint8 averageResponse) {
        bytes32 tagHash = keccak256(bytes(tag));
        bool tagFilter = bytes(tag).length != 0;
        bool valFilter = validatorAddresses.length != 0;
        bytes32[] storage list = _agentRequests[agentId];
        uint256 sum;

        for (uint256 i = 0; i < list.length; i++) {
            RequestRecord storage rec = _requests[list[i]];
            if (rec.lastUpdate == 0) continue;
            if (tagFilter && keccak256(bytes(rec.tag)) != tagHash) continue;
            if (
                valFilter &&
                !_contains(validatorAddresses, rec.validatorAddress)
            ) continue;
            sum += rec.response;
            count++;
        }
        if (count == 0) return (0, 0);
        // Each rec.response is uint8, so sum / count fits in uint8; SafeCast keeps
        // the intent explicit and silences the truncation lint.
        averageResponse = SafeCast.toUint8(sum / count);
    }

    /// @inheritdoc IERC8004Validation
    function getAgentValidations(
        uint256 agentId
    ) external view returns (bytes32[] memory) {
        return _agentRequests[agentId];
    }

    /// @inheritdoc IERC8004Validation
    function getValidatorRequests(
        address validatorAddress
    ) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }

    function _contains(
        address[] calldata haystack,
        address needle
    ) internal pure returns (bool) {
        for (uint256 i = 0; i < haystack.length; i++) {
            if (haystack[i] == needle) return true;
        }
        return false;
    }
}
