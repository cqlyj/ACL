// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AgenticCommerce} from "./AgenticCommerce.sol";

/// @title ACLEvaluator — Delegated evaluator proxy for ERC-8183 jobs
/// @dev Set as the evaluator address on jobs. Authorized operators (SDK bots)
///      can call settle(), which forwards to complete() or reject() on the
///      AgenticCommerce contract. Stores attestation roots for on-chain lookups.
contract ACLEvaluator is Ownable2Step {
    mapping(address => bool) public authorizedOperators;
    /// @dev keccak256(commerce, jobId) -> attestation root, so the same evaluator
    ///      can serve multiple AgenticCommerce instances without jobId collisions.
    mapping(bytes32 => bytes32) private _attestationRoots;

    event OperatorUpdated(address indexed operator, bool authorized);
    event JobSettled(
        uint256 indexed jobId,
        address indexed commerce,
        bool approved,
        bytes32 root
    );

    error NotAuthorized();
    error ZeroAddress();

    constructor(address owner_) Ownable(owner_) {}

    function setOperator(address operator, bool authorized) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        authorizedOperators[operator] = authorized;
        emit OperatorUpdated(operator, authorized);
    }

    /// @notice Settle a job. The operator calls this after building the attestation bundle.
    /// @param commerce  AgenticCommerce contract holding the job
    /// @param jobId     Job to settle
    /// @param approved  true -> complete, false -> reject
    /// @param root      0G Storage root of the evidence bundle (the "attestation root")
    /// @param optParams Forwarded to the hook via the commerce contract
    function settle(
        AgenticCommerce commerce,
        uint256 jobId,
        bool approved,
        bytes32 root,
        bytes calldata optParams
    ) external {
        if (!authorizedOperators[msg.sender]) revert NotAuthorized();

        _attestationRoots[_key(address(commerce), jobId)] = root;

        if (approved) {
            commerce.complete(jobId, root, optParams);
        } else {
            commerce.reject(jobId, root, optParams);
        }

        emit JobSettled(jobId, address(commerce), approved, root);
    }

    /// @notice Returns the attestation root recorded by `settle()` for the given (commerce, jobId).
    function attestationRoot(
        address commerce,
        uint256 jobId
    ) external view returns (bytes32) {
        return _attestationRoots[_key(commerce, jobId)];
    }

    function _key(
        address commerce,
        uint256 jobId
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(commerce, jobId));
    }
}
