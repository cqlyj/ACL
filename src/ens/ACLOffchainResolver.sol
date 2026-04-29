// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IExtendedResolver} from "../interfaces/IExtendedResolver.sol";
import {SignatureVerifier} from "./SignatureVerifier.sol";

/// @title IResolverService
/// @notice Off-chain gateway interface invoked by EIP-3668 clients.
/// @dev Canonical layout from ensdomains/offchain-resolver. The client
///      ABI-encodes resolve(name, data) as the OffchainLookup callData; the
///      gateway runs that against the on-chain registry on 0G and returns a
///      signed (result, expires, sig) tuple to be passed into resolveWithProof.
interface IResolverService {
    function resolve(
        bytes calldata name,
        bytes calldata data
    ) external view returns (bytes memory result);
}

/// @title ACLOffchainResolver
/// @notice ENSIP-10 + EIP-3668 resolver for *.acl.eth. Defers all
///         resolution to a CCIP-Read gateway that reads on-chain agent data
///         and signs the response.
contract ACLOffchainResolver is IExtendedResolver, Ownable2Step {
    string public url;
    mapping(address => bool) public signers;

    event NewSigners(address[] signers);
    event GatewayUrlUpdated(string url);
    event SignerUpdated(address indexed signer, bool authorized);

    error OffchainLookup(
        address sender,
        string[] urls,
        bytes callData,
        bytes4 callbackFunction,
        bytes extraData
    );

    error EmptyUrl();
    error ZeroAddress();
    error InvalidSignature();

    constructor(
        string memory url_,
        address[] memory signers_,
        address owner_
    ) Ownable(owner_) {
        if (bytes(url_).length == 0) revert EmptyUrl();
        url = url_;
        address[] memory addedSigners = new address[](signers_.length);
        for (uint256 i = 0; i < signers_.length; i++) {
            if (signers_[i] == address(0)) revert ZeroAddress();
            signers[signers_[i]] = true;
            addedSigners[i] = signers_[i];
        }
        emit NewSigners(addedSigners);
    }

    function setUrl(string calldata url_) external onlyOwner {
        if (bytes(url_).length == 0) revert EmptyUrl();
        url = url_;
        emit GatewayUrlUpdated(url_);
    }

    function setSigner(address signer, bool authorized) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        signers[signer] = authorized;
        emit SignerUpdated(signer, authorized);
    }

    /// @notice Helper exposed for gateway operators to verify signing hashes off-chain.
    function makeSignatureHash(
        address target,
        uint64 expires,
        bytes memory request,
        bytes memory result
    ) external pure returns (bytes32) {
        return
            SignatureVerifier.makeSignatureHash(
                target,
                expires,
                request,
                result
            );
    }

    /// @inheritdoc IExtendedResolver
    function resolve(
        bytes calldata name,
        bytes calldata data
    ) external view override returns (bytes memory) {
        bytes memory callData = abi.encodeWithSelector(
            IResolverService.resolve.selector,
            name,
            data
        );
        string[] memory urls = new string[](1);
        urls[0] = url;
        revert OffchainLookup(
            address(this),
            urls,
            callData,
            ACLOffchainResolver.resolveWithProof.selector,
            abi.encode(callData, address(this))
        );
    }

    /// @notice EIP-3668 callback. Verifies the gateway signature against an
    ///         authorised signer and returns the resolver result blob.
    function resolveWithProof(
        bytes calldata response,
        bytes calldata extraData
    ) external view returns (bytes memory) {
        (address signer, bytes memory result) = SignatureVerifier.verify(
            extraData,
            response
        );
        if (!signers[signer]) revert InvalidSignature();
        return result;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) external pure returns (bool) {
        return
            interfaceId == type(IExtendedResolver).interfaceId ||
            interfaceId == 0x01ffc9a7;
    }
}
