// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev See https://eips.ethereum.org/EIPS/eip-7857 - Data Verification Interface section.

enum OracleType {
    TEE,
    ZKP
}

struct AccessProof {
    bytes32 oldDataHash;
    bytes32 newDataHash;
    bytes nonce;
    bytes encryptedPubKey;
    bytes proof;
}

struct OwnershipProof {
    OracleType oracleType;
    bytes32 oldDataHash;
    bytes32 newDataHash;
    bytes sealedKey;
    bytes encryptedPubKey;
    bytes nonce;
    bytes proof;
}

struct TransferValidityProof {
    AccessProof accessProof;
    OwnershipProof ownershipProof;
}

struct TransferValidityProofOutput {
    bytes32 oldDataHash;
    bytes32 newDataHash;
    bytes sealedKey;
    bytes encryptedPubKey;
    bytes wantedKey;
    address accessAssistant;
    bytes accessProofNonce;
    bytes ownershipProofNonce;
}

/// @title IERC7857DataVerifier — Verifier for iNFT transfer proofs
interface IERC7857DataVerifier {
    function verifyTransferValidity(
        TransferValidityProof[] calldata _proofs
    ) external returns (TransferValidityProofOutput[] memory);
}
