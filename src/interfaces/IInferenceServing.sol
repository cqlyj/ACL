// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IInferenceServing — minimal external surface of 0G Compute's
///        InferenceServing marketplace contract that ACLEvaluator depends on.
/// @notice The 0G Compute marketplace records a `teeSignerAddress` per
///         provider when the provider onboards. Every TEE-generated response
///         is signed (EIP-191 personal_sign) by that address, so checking
///         `recover(toEthSignedMessageHash(signedText), sig) == teeSignerAddress`
///         proves the response actually came from a registered 0G Compute
///         TEE provider — without any precompile, attestation oracle, or
///         off-chain trust.
interface IInferenceServing {
    struct Service {
        address provider;
        string serviceType;
        string url;
        uint256 inputPrice;
        uint256 outputPrice;
        uint256 updatedAt;
        string model;
        string verifiability;
        string additionalInfo;
        address teeSignerAddress;
        bool teeSignerAcknowledged;
    }

    /// @notice Read the registered service profile for a 0G Compute provider.
    /// @dev    Reverts with a custom error inside the marketplace if the
    ///         provider is not registered. Callers should be prepared for that.
    function getService(
        address provider
    ) external view returns (Service memory service);
}
