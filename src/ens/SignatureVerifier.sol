// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title SignatureVerifier
/// @notice Mirrors ensdomains/offchain-resolver/SignatureVerifier (canonical
///         CCIP-Read gateway response verifier).
/// @dev Uses EIP-191 v0 hashing: keccak256(0x19 || 0x00 || target || expires
///      || keccak256(request) || keccak256(result)). target is the resolver
///      contract that called this library; expires/sig come from the gateway
///      response. Inlined as a library so address(this) resolves to the
///      caller, exactly as in the canonical implementation.
library SignatureVerifier {
    function makeSignatureHash(
        address target,
        uint64 expires,
        bytes memory request,
        bytes memory result
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    hex"1900",
                    target,
                    expires,
                    keccak256(request),
                    keccak256(result)
                )
            );
    }

    function verify(
        bytes calldata request,
        bytes calldata response
    ) internal view returns (address, bytes memory) {
        (bytes memory result, uint64 expires, bytes memory sig) = abi.decode(
            response,
            (bytes, uint64, bytes)
        );
        address signer = ECDSA.recover(
            makeSignatureHash(address(this), expires, request, result),
            sig
        );
        require(
            expires >= block.timestamp,
            "SignatureVerifier: Signature expired"
        );
        return (signer, result);
    }
}
