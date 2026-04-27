// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC8004Identity} from "../interfaces/IERC8004Identity.sol";

/// @title ACLIdentityRegistry
/// @notice ERC-8004 v2 Identity Registry. ERC-721 + URIStorage + on-chain metadata.
/// @dev tokenId in ERC-721 == agentId in ERC-8004. tokenURI == agentURI.
///      Reserved metadata key "agentWallet" can only be set by the owner via an
///      EIP-712 signed authorization from the new wallet (EOA or ERC-1271 contract
///      wallet) and is auto-cleared on transfer.
contract ACLIdentityRegistry is ERC721URIStorage, EIP712, IERC8004Identity {
    string private constant _NAME = "ACL Identity";
    string private constant _SYMBOL = "ACL-ID";
    string private constant _SIGNING_DOMAIN = "ACLIdentityRegistry";
    string private constant _SIGNATURE_VERSION = "1";

    string private constant _AGENT_WALLET_KEY = "agentWallet";

    bytes32 private constant _AGENT_WALLET_TYPEHASH =
        keccak256(
            "AgentWallet(uint256 agentId,address newWallet,uint256 deadline)"
        );

    uint256 private _nextAgentId = 1;

    mapping(uint256 agentId => mapping(string key => bytes value))
        private _metadata;

    error NotOwnerOrOperator();
    error ReservedKey();
    error UnknownAgent();
    error DeadlineExpired();
    error InvalidWalletSignature();

    constructor()
        ERC721(_NAME, _SYMBOL)
        EIP712(_SIGNING_DOMAIN, _SIGNATURE_VERSION)
    {}

    // ---------- Registration ----------

    /// @inheritdoc IERC8004Identity
    function register(
        string calldata agentURI,
        MetadataEntry[] calldata metadata
    ) external returns (uint256 agentId) {
        agentId = _mintAgent(msg.sender, agentURI);
        for (uint256 i = 0; i < metadata.length; i++) {
            _setMetadata(
                agentId,
                metadata[i].metadataKey,
                metadata[i].metadataValue,
                true
            );
        }
    }

    /// @inheritdoc IERC8004Identity
    function register(
        string calldata agentURI
    ) external returns (uint256 agentId) {
        agentId = _mintAgent(msg.sender, agentURI);
    }

    /// @inheritdoc IERC8004Identity
    function register() external returns (uint256 agentId) {
        agentId = _mintAgent(msg.sender, "");
    }

    function _mintAgent(
        address to,
        string memory agentURI
    ) internal returns (uint256 agentId) {
        agentId = _nextAgentId++;
        _safeMint(to, agentId);
        if (bytes(agentURI).length > 0) {
            _setTokenURI(agentId, agentURI);
        }
        _metadata[agentId][_AGENT_WALLET_KEY] = abi.encode(to);
        emit MetadataSet(
            agentId,
            _AGENT_WALLET_KEY,
            _AGENT_WALLET_KEY,
            abi.encode(to)
        );
        emit Registered(agentId, agentURI, to);
    }

    // ---------- agentURI ----------

    /// @inheritdoc IERC8004Identity
    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _requireOwnerOrOperator(agentId);
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    // ---------- Metadata ----------

    /// @inheritdoc IERC8004Identity
    function getMetadata(
        uint256 agentId,
        string calldata metadataKey
    ) external view returns (bytes memory) {
        return _metadata[agentId][metadataKey];
    }

    /// @inheritdoc IERC8004Identity
    function setMetadata(
        uint256 agentId,
        string calldata metadataKey,
        bytes calldata metadataValue
    ) external {
        _requireOwnerOrOperator(agentId);
        if (_isReservedKey(metadataKey)) revert ReservedKey();
        _setMetadata(agentId, metadataKey, metadataValue, false);
    }

    function _setMetadata(
        uint256 agentId,
        string memory key,
        bytes memory value,
        bool allowReserved
    ) internal {
        if (!allowReserved && _isReservedKey(key)) revert ReservedKey();
        _metadata[agentId][key] = value;
        emit MetadataSet(agentId, key, key, value);
    }

    // ---------- agentWallet (reserved) ----------

    /// @inheritdoc IERC8004Identity
    /// @dev Per ERC-8004 the new wallet MUST authorize the change via an EIP-712
    ///      signature (or ERC-1271 for smart-contract wallets), proving control of
    ///      the wallet being set.
    function setAgentWallet(
        uint256 agentId,
        address newWallet,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _requireOwnerOrOperator(agentId);
        if (block.timestamp > deadline) revert DeadlineExpired();

        bytes32 structHash = keccak256(
            abi.encode(_AGENT_WALLET_TYPEHASH, agentId, newWallet, deadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        if (!SignatureChecker.isValidSignatureNow(newWallet, digest, signature))
            revert InvalidWalletSignature();

        bytes memory value = abi.encode(newWallet);
        _metadata[agentId][_AGENT_WALLET_KEY] = value;
        emit MetadataSet(agentId, _AGENT_WALLET_KEY, _AGENT_WALLET_KEY, value);
    }

    /// @inheritdoc IERC8004Identity
    function getAgentWallet(uint256 agentId) external view returns (address) {
        bytes memory raw = _metadata[agentId][_AGENT_WALLET_KEY];
        if (raw.length == 0) return address(0);
        return abi.decode(raw, (address));
    }

    /// @inheritdoc IERC8004Identity
    function unsetAgentWallet(uint256 agentId) external {
        _requireOwnerOrOperator(agentId);
        delete _metadata[agentId][_AGENT_WALLET_KEY];
        bytes memory empty;
        emit MetadataSet(agentId, _AGENT_WALLET_KEY, _AGENT_WALLET_KEY, empty);
    }

    // ---------- ENSIP-25 helper ----------

    /// @notice ENSIP-25 expects the agent registry to expose the {agentId, registry, chainId}
    ///         tuple as numeric values. CCIP-Read gateways encode the response as text records.
    function agentRegistryURI(
        uint256 agentId
    ) external view returns (string memory) {
        if (_ownerOf(agentId) == address(0)) revert UnknownAgent();
        return
            string.concat(
                "eip155:",
                Strings.toString(block.chainid),
                ":",
                Strings.toHexString(address(this))
            );
    }

    // ---------- Internal ----------

    function _isReservedKey(string memory key) internal pure returns (bool) {
        return keccak256(bytes(key)) == keccak256(bytes(_AGENT_WALLET_KEY));
    }

    function _requireOwnerOrOperator(uint256 agentId) internal view {
        address tokenOwner = _ownerOf(agentId);
        if (tokenOwner == address(0)) revert UnknownAgent();
        if (
            msg.sender != tokenOwner &&
            getApproved(agentId) != msg.sender &&
            !isApprovedForAll(tokenOwner, msg.sender)
        ) {
            revert NotOwnerOrOperator();
        }
    }

    /// @dev Auto-clear agentWallet on transfer (ERC-8004 normative requirement).
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal virtual override returns (address) {
        address from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0) && from != to) {
            delete _metadata[tokenId][_AGENT_WALLET_KEY];
            bytes memory empty;
            emit MetadataSet(
                tokenId,
                _AGENT_WALLET_KEY,
                _AGENT_WALLET_KEY,
                empty
            );
        }
        return from;
    }
}
