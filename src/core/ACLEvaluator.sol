// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {AgenticCommerce} from "./AgenticCommerce.sol";
import {IInferenceServing} from "../interfaces/IInferenceServing.sol";

/// @title ACLEvaluator — Delegated evaluator proxy for ERC-8183 jobs
///         with on-chain proof that the evaluator ran on 0G Compute.
/// @notice Set as the evaluator address on jobs. Authorized operators (SDK
///         bots) call `settle()`, which:
///           1. recovers the EIP-191 personal_sign signature in `teeSignature`
///              against the provider's registered `teeSignerAddress` on the
///              0G Compute `InferenceServing` marketplace, and
///           2. records `keccak256(signedText)` as used so the same TEE
///              response cannot be replayed across jobs.
///         The combination prevents two real attacks:
///           - "operator passes setOperator() once and silently swaps to a
///              local LLM": every settle requires a fresh, valid 0G TEE
///              signature, which only a real 0G Compute provider can produce.
///           - "operator runs one inference on 0G then reuses the signature
///              forever": each `signedText` can settle at most one job.
contract ACLEvaluator is Ownable2Step {
    using MessageHashUtils for bytes;

    /// @notice 0G Compute InferenceServing marketplace; queried per settle()
    ///         to look up the canonical TEE signing key for the provider.
    IInferenceServing public immutable inferenceServing;

    mapping(address => bool) public authorizedOperators;
    /// @dev keccak256(commerce, jobId) -> attestation root, so the same evaluator
    ///      can serve multiple AgenticCommerce instances without jobId collisions.
    mapping(bytes32 => bytes32) private _attestationRoots;
    /// @dev keccak256(signedText) -> true once a TEE signature has been
    ///      consumed by `settle()`. Reused signatures are rejected.
    mapping(bytes32 => bool) public usedTeeSignatures;

    event OperatorUpdated(address indexed operator, bool authorized);
    event JobSettled(
        uint256 indexed jobId,
        address indexed commerce,
        bool approved,
        bytes32 root,
        address indexed computeProvider,
        bytes32 signatureNonce
    );

    error NotAuthorized();
    error ZeroAddress();
    error TeeSignerNotAcknowledged();
    error TeeSignatureMismatch();
    error TeeSignatureReplayed();

    /// @param owner_              Owner allowed to manage the operator set.
    /// @param inferenceServing_   0G Compute marketplace contract on the same
    ///                            chain. On Galileo testnet (chain id 16602)
    ///                            the production marketplace is
    ///                            0xa79F4c8311FF93C06b8CfB403690cc987c93F91E. 
    ///                            The dev counterpart `0x41bD...85c5` only sees
    ///                            providers running with `ZG_DEV_MODE=true`.
    constructor(
        address owner_,
        IInferenceServing inferenceServing_
    ) Ownable(owner_) {
        if (address(inferenceServing_) == address(0)) revert ZeroAddress();
        inferenceServing = inferenceServing_;
    }

    function setOperator(address operator, bool authorized) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        authorizedOperators[operator] = authorized;
        emit OperatorUpdated(operator, authorized);
    }

    /// @notice Settle a job after verifying the evaluator ran on 0G Compute.
    /// @param commerce        AgenticCommerce contract holding the job
    /// @param jobId           Job to settle
    /// @param approved        true -> complete, false -> reject
    /// @param root            0G Storage root of the evidence bundle
    /// @param computeProvider 0G Compute provider address that ran the inference
    /// @param signedText      Exact bytes the TEE signed (the colon-separated
    ///                        payload returned by `<svc.url>/v1/proxy/signature/:chatID`)
    /// @param teeSignature    EIP-191 personal_sign signature over `signedText`
    /// @param optParams       Forwarded to the hook via the commerce contract
    function settle(
        AgenticCommerce commerce,
        uint256 jobId,
        bool approved,
        bytes32 root,
        address computeProvider,
        bytes calldata signedText,
        bytes calldata teeSignature,
        bytes calldata optParams
    ) external {
        if (!authorizedOperators[msg.sender]) revert NotAuthorized();

        bytes32 sigNonce = keccak256(signedText);
        if (usedTeeSignatures[sigNonce]) revert TeeSignatureReplayed();

        IInferenceServing.Service memory svc = inferenceServing.getService(
            computeProvider
        );
        if (!svc.teeSignerAcknowledged) revert TeeSignerNotAcknowledged();

        bytes memory message = signedText;
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(message);
        address recovered = ECDSA.recover(digest, teeSignature);
        if (recovered != svc.teeSignerAddress) revert TeeSignatureMismatch();

        usedTeeSignatures[sigNonce] = true;
        _attestationRoots[_key(address(commerce), jobId)] = root;

        if (approved) {
            commerce.complete(jobId, root, optParams);
        } else {
            commerce.reject(jobId, root, optParams);
        }

        emit JobSettled(
            jobId,
            address(commerce),
            approved,
            root,
            computeProvider,
            sigNonce
        );
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
