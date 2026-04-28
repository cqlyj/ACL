// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC7857DataVerifier, TransferValidityProof, TransferValidityProofOutput} from "../interfaces/IERC7857DataVerifier.sol";

/// @title TrustedPartyVerifier
/// @notice ERC-7857 data verifier using the Trusted Party model.
/// @dev ERC-7857 permits three sealed-executor models for data-availability proofs:
///      TEE (in-enclave attestation), ZKP (zero-knowledge), or Trusted Party (oracle
///      signature). This contract implements the Trusted Party variant. In production
///      the oracle key lives inside a 0G TeeML enclave; for the demo it is a regular
///      EOA registered at deploy. The owner may rotate it.
///
///      Both proofs are bound to (verifier, chainId) so a signature minted for one
///      verifier cannot be replayed against another. Both proofs commit to the
///      buyer-supplied encryptedPubKey so a stale signature cannot be reused with a
///      different recipient. Variable-length fields (sealedKey, encryptedPubKey,
///      nonce) MUST be encoded with abi.encode (not abi.encodePacked) to avoid
///      hash-collision ambiguity.
contract TrustedPartyVerifier is IERC7857DataVerifier, Ownable2Step {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    address public authorizedOracle;
    /// @notice If non-zero, the ownership-proof nonce MUST be abi.encode(uint256 timestamp)
    ///         and (block.timestamp - timestamp) MUST be < maxProofAge.
    uint256 public maxProofAge;

    mapping(bytes32 => bool) public usedProofs;
    mapping(bytes32 => uint256) public proofTimestamps;

    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event MaxProofAgeUpdated(uint256 oldAge, uint256 newAge);

    error ZeroAddress();
    error ProofAlreadyUsed();
    error InvalidOracleSignature();
    error InvalidAccessSignature();
    error ProofExpired();
    error DataHashMismatch();
    error MalformedNonce();

    constructor(
        address oracle_,
        uint256 maxProofAge_,
        address owner_
    ) Ownable(owner_) {
        if (oracle_ == address(0)) revert ZeroAddress();
        authorizedOracle = oracle_;
        maxProofAge = maxProofAge_;
    }

    function setOracle(address oracle_) external onlyOwner {
        if (oracle_ == address(0)) revert ZeroAddress();
        emit OracleUpdated(authorizedOracle, oracle_);
        authorizedOracle = oracle_;
    }

    function setMaxProofAge(uint256 maxProofAge_) external onlyOwner {
        emit MaxProofAgeUpdated(maxProofAge, maxProofAge_);
        maxProofAge = maxProofAge_;
    }

    /// @notice Verify a batch of ownership + access proofs. ERC-7857 normative entrypoint.
    function verifyTransferValidity(
        TransferValidityProof[] calldata _proofs
    ) external override returns (TransferValidityProofOutput[] memory) {
        TransferValidityProofOutput[]
            memory outputs = new TransferValidityProofOutput[](_proofs.length);
        for (uint256 i = 0; i < _proofs.length; i++) {
            outputs[i] = _verifySingleProof(_proofs[i]);
        }
        return outputs;
    }

    function _verifySingleProof(
        TransferValidityProof calldata proof
    ) internal returns (TransferValidityProofOutput memory) {
        if (proof.accessProof.oldDataHash != proof.ownershipProof.oldDataHash)
            revert DataHashMismatch();
        if (proof.accessProof.newDataHash != proof.ownershipProof.newDataHash)
            revert DataHashMismatch();
        // Both proofs MUST commit to the same recipient key.
        if (
            keccak256(proof.accessProof.encryptedPubKey) !=
            keccak256(proof.ownershipProof.encryptedPubKey)
        ) revert DataHashMismatch();

        bytes32 proofNonce = keccak256(proof.ownershipProof.nonce);
        if (usedProofs[proofNonce]) revert ProofAlreadyUsed();

        bytes32 ownershipHash = keccak256(
            abi.encode(
                address(this),
                block.chainid,
                proof.ownershipProof.oracleType,
                proof.ownershipProof.oldDataHash,
                proof.ownershipProof.newDataHash,
                proof.ownershipProof.sealedKey,
                proof.ownershipProof.encryptedPubKey,
                proof.ownershipProof.nonce
            )
        );
        address oracleSigner = ownershipHash.toEthSignedMessageHash().recover(
            proof.ownershipProof.proof
        );
        if (oracleSigner != authorizedOracle) revert InvalidOracleSignature();

        bytes32 accessHash = keccak256(
            abi.encode(
                address(this),
                block.chainid,
                proof.accessProof.oldDataHash,
                proof.accessProof.newDataHash,
                proof.accessProof.encryptedPubKey,
                proof.accessProof.nonce
            )
        );
        address accessSigner = accessHash.toEthSignedMessageHash().recover(
            proof.accessProof.proof
        );
        if (accessSigner == address(0)) revert InvalidAccessSignature();

        if (maxProofAge > 0) {
            if (proof.ownershipProof.nonce.length != 32)
                revert MalformedNonce();
            uint256 proofTimestamp = abi.decode(
                proof.ownershipProof.nonce,
                (uint256)
            );
            if (block.timestamp > proofTimestamp + maxProofAge)
                revert ProofExpired();
        }

        usedProofs[proofNonce] = true;
        proofTimestamps[proofNonce] = block.timestamp;

        return
            TransferValidityProofOutput({
                oldDataHash: proof.ownershipProof.oldDataHash,
                newDataHash: proof.ownershipProof.newDataHash,
                sealedKey: proof.ownershipProof.sealedKey,
                encryptedPubKey: proof.ownershipProof.encryptedPubKey,
                wantedKey: proof.accessProof.encryptedPubKey,
                accessAssistant: accessSigner,
                accessProofNonce: proof.accessProof.nonce,
                ownershipProofNonce: proof.ownershipProof.nonce
            });
    }

    /// @notice Reclaim storage for proofs whose age has exceeded `maxProofAge`.
    /// @dev Disabled when `maxProofAge == 0` because in that mode the only thing
    ///      preventing replay is the `usedProofs` flag itself; clearing it would
    ///      re-open the proof for reuse. With `maxProofAge > 0`, an expired
    ///      proof would be rejected by the timestamp check anyway, so it is
    ///      safe to garbage-collect.
    function cleanExpiredProofs(bytes32[] calldata proofNonces) external {
        uint256 age = maxProofAge;
        require(
            age > 0,
            "TrustedPartyVerifier: cannot clean when maxProofAge=0"
        );
        for (uint256 i = 0; i < proofNonces.length; i++) {
            bytes32 nonce = proofNonces[i];
            if (
                usedProofs[nonce] &&
                block.timestamp > proofTimestamps[nonce] + age
            ) {
                delete usedProofs[nonce];
                delete proofTimestamps[nonce];
            }
        }
    }
}
