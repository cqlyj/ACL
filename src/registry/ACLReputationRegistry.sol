// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC8004Reputation} from "../interfaces/IERC8004Reputation.sol";

/// @title ACLReputationRegistry
/// @notice ERC-8004 v2 Reputation Registry.
/// @dev Permissionless feedback. The clientAddress is msg.sender. Per the spec the
///      submitter MUST NOT be the agent owner or an approved operator for agentId,
///      to prevent self-rating attacks. Aggregation is left to off-chain indexers
///      via the indexed events; we keep a minimal on-chain summary for composability.
contract ACLReputationRegistry is IERC8004Reputation {
    struct FeedbackEntry {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bool isRevoked;
    }

    address private _identityRegistry;
    bool private _initialized;

    /// @dev agentId => clientAddress => entries (1-indexed via feedbackIndex)
    mapping(uint256 agentId => mapping(address clientAddress => FeedbackEntry[] entries))
        private _feedback;
    /// @dev agentId => list of clientAddresses that ever submitted
    mapping(uint256 agentId => address[] clientAddresses) private _clients;
    mapping(uint256 => mapping(address => bool)) private _isClient;
    /// @dev agentId => clientAddress => feedbackIndex (1-indexed) => responder => count
    mapping(uint256 agentId => mapping(address clientAddress => mapping(uint64 feedbackIndex => mapping(address responder => uint64 count))))
        private _responseCount;

    error AlreadyInitialized();
    error NotInitialized();
    error UnknownAgent();
    error InvalidValueDecimals();
    error SubmitterIsOwnerOrOperator();
    error InvalidFeedbackIndex();
    error NotFeedbackOwner();
    error AlreadyRevoked();

    /// @notice Bind this registry to an Identity Registry. Single-shot.
    function initialize(address identityRegistry_) external {
        if (_initialized) revert AlreadyInitialized();
        _identityRegistry = identityRegistry_;
        _initialized = true;
    }

    /// @inheritdoc IERC8004Reputation
    function getIdentityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    // ---------- Give Feedback ----------

    /// @inheritdoc IERC8004Reputation
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        if (!_initialized) revert NotInitialized();
        if (valueDecimals > 18) revert InvalidValueDecimals();

        _checkSubmitterNotOwnerOrOperator(agentId);
        uint64 feedbackIndex = _appendFeedback(
            agentId,
            value,
            valueDecimals,
            tag1,
            tag2
        );
        _emitNewFeedback(
            agentId,
            feedbackIndex,
            value,
            valueDecimals,
            tag1,
            tag2,
            endpoint,
            feedbackURI,
            feedbackHash
        );
    }

    /// @dev Split out so the calling stack does not hold all 8 calldata pointers
    ///      plus the local feedbackIndex at once, to avoid stack too deep issues.
    function _emitNewFeedback(
        uint256 agentId,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) internal {
        emit NewFeedback(
            agentId,
            msg.sender,
            feedbackIndex,
            value,
            valueDecimals,
            tag1,
            tag1,
            tag2,
            endpoint,
            feedbackURI,
            feedbackHash
        );
    }

    function _checkSubmitterNotOwnerOrOperator(uint256 agentId) internal view {
        IERC721 identity = IERC721(_identityRegistry);
        address agentOwner = identity.ownerOf(agentId);
        if (msg.sender == agentOwner) revert SubmitterIsOwnerOrOperator();
        if (identity.isApprovedForAll(agentOwner, msg.sender))
            revert SubmitterIsOwnerOrOperator();
        if (identity.getApproved(agentId) == msg.sender)
            revert SubmitterIsOwnerOrOperator();
    }

    function _appendFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2
    ) internal returns (uint64) {
        FeedbackEntry[] storage list = _feedback[agentId][msg.sender];
        list.push(
            FeedbackEntry({
                value: value,
                valueDecimals: valueDecimals,
                tag1: tag1,
                tag2: tag2,
                isRevoked: false
            })
        );
        if (!_isClient[agentId][msg.sender]) {
            _isClient[agentId][msg.sender] = true;
            _clients[agentId].push(msg.sender);
        }
        return uint64(list.length);
    }

    /// @inheritdoc IERC8004Reputation
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        FeedbackEntry[] storage list = _feedback[agentId][msg.sender];
        if (feedbackIndex == 0 || feedbackIndex > list.length)
            revert InvalidFeedbackIndex();

        FeedbackEntry storage entry = list[feedbackIndex - 1];
        if (entry.isRevoked) revert AlreadyRevoked();
        entry.isRevoked = true;

        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    /// @inheritdoc IERC8004Reputation
    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external {
        FeedbackEntry[] storage list = _feedback[agentId][clientAddress];
        if (feedbackIndex == 0 || feedbackIndex > list.length)
            revert InvalidFeedbackIndex();

        _responseCount[agentId][clientAddress][feedbackIndex][msg.sender]++;

        emit ResponseAppended(
            agentId,
            clientAddress,
            feedbackIndex,
            msg.sender,
            responseURI,
            responseHash
        );
    }

    // ---------- Reads ----------

    /// @inheritdoc IERC8004Reputation
    /// @dev Aggregates by mean. Skips revoked entries, entries with mismatched
    ///      tags (when filters are non-empty), and entries from outside the
    ///      provided clientAddresses set. The two passes are split so the legacy
    ///      codegen does not run out of stack on the storage references.
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    )
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        require(clientAddresses.length > 0, "ERC8004:empty clientAddresses");
        bytes32 t1Hash = bytes(tag1).length == 0
            ? bytes32(0)
            : keccak256(bytes(tag1));
        bytes32 t2Hash = bytes(tag2).length == 0
            ? bytes32(0)
            : keccak256(bytes(tag2));

        uint256 maxDecimals;
        (count, maxDecimals) = _summaryPassCount(
            agentId,
            clientAddresses,
            t1Hash,
            t2Hash
        );
        if (count == 0) return (0, 0, 0);

        int256 acc = _summaryPassSum(
            agentId,
            clientAddresses,
            t1Hash,
            t2Hash,
            maxDecimals
        );
        // SafeCast reverts if the average overflows int128; this can only happen if
        // a caller pushes pathological feedback values, in which case rejecting is
        // the correct behaviour.
        summaryValue = SafeCast.toInt128(acc / int256(uint256(count)));
        summaryValueDecimals = SafeCast.toUint8(maxDecimals);
    }

    function _summaryPassCount(
        uint256 agentId,
        address[] calldata clientAddresses,
        bytes32 t1Hash,
        bytes32 t2Hash
    ) internal view returns (uint64 count, uint256 maxDecimals) {
        for (uint256 i = 0; i < clientAddresses.length; i++) {
            FeedbackEntry[] storage list = _feedback[agentId][
                clientAddresses[i]
            ];
            for (uint256 j = 0; j < list.length; j++) {
                FeedbackEntry storage e = list[j];
                if (e.isRevoked) continue;
                if (t1Hash != bytes32(0) && keccak256(bytes(e.tag1)) != t1Hash)
                    continue;
                if (t2Hash != bytes32(0) && keccak256(bytes(e.tag2)) != t2Hash)
                    continue;
                if (e.valueDecimals > maxDecimals)
                    maxDecimals = e.valueDecimals;
                count++;
            }
        }
    }

    function _summaryPassSum(
        uint256 agentId,
        address[] calldata clientAddresses,
        bytes32 t1Hash,
        bytes32 t2Hash,
        uint256 maxDecimals
    ) internal view returns (int256 acc) {
        for (uint256 i = 0; i < clientAddresses.length; i++) {
            FeedbackEntry[] storage list = _feedback[agentId][
                clientAddresses[i]
            ];
            for (uint256 j = 0; j < list.length; j++) {
                FeedbackEntry storage e = list[j];
                if (e.isRevoked) continue;
                if (t1Hash != bytes32(0) && keccak256(bytes(e.tag1)) != t1Hash)
                    continue;
                if (t2Hash != bytes32(0) && keccak256(bytes(e.tag2)) != t2Hash)
                    continue;
                acc +=
                    int256(e.value) *
                    int256(10 ** (maxDecimals - e.valueDecimals));
            }
        }
    }

    /// @inheritdoc IERC8004Reputation
    function readFeedback(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex
    )
        external
        view
        returns (
            int128 value,
            uint8 valueDecimals,
            string memory tag1,
            string memory tag2,
            bool isRevoked
        )
    {
        FeedbackEntry[] storage list = _feedback[agentId][clientAddress];
        if (feedbackIndex == 0 || feedbackIndex > list.length)
            revert InvalidFeedbackIndex();
        FeedbackEntry storage e = list[feedbackIndex - 1];
        return (e.value, e.valueDecimals, e.tag1, e.tag2, e.isRevoked);
    }

    /// @inheritdoc IERC8004Reputation
    function getClients(
        uint256 agentId
    ) external view returns (address[] memory) {
        return _clients[agentId];
    }

    /// @inheritdoc IERC8004Reputation
    function getLastIndex(
        uint256 agentId,
        address clientAddress
    ) external view returns (uint64) {
        return uint64(_feedback[agentId][clientAddress].length);
    }

    function getResponseCount(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        address[] calldata responders
    ) external view returns (uint64 count) {
        for (uint256 i = 0; i < responders.length; i++) {
            count += _responseCount[agentId][clientAddress][feedbackIndex][
                responders[i]
            ];
        }
    }
}
