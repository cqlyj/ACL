// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC7857} from "../interfaces/IERC7857.sol";
import {IERC7857Metadata, IntelligentData} from "../interfaces/IERC7857Metadata.sol";
import {IERC7857DataVerifier, TransferValidityProof, TransferValidityProofOutput} from "../interfaces/IERC7857DataVerifier.sol";

/// @title ACLAgentNFT
/// @notice ERC-7857 iNFT on top of ERC-721.
/// @dev "Intelligent data" is encrypted off-chain and stored on 0G Storage. On-chain
///      we keep IntelligentData[] (description + dataHash) per token plus a pointer
///      to the storage URI. Transfers go through iTransfer / iClone with verified
///      re-encryption proofs from the bound IERC7857DataVerifier (see ERC-7857
///      Data Verification System). On a successful transfer we publish sealed keys
///      for the new owner and clear authorisations of the previous owner.
contract ACLAgentNFT is ERC721, Ownable2Step, IERC7857, IERC7857Metadata {
    IERC7857DataVerifier private immutable _verifier;

    uint256 public nextTokenId;

    mapping(uint256 => IntelligentData[]) internal _intelligentData;
    mapping(uint256 => string) public encryptedStorageURIs;
    mapping(uint256 => bytes[]) internal _sealedKeys;
    mapping(uint256 => address[]) internal _authorizedUsers;
    mapping(uint256 => mapping(address => bool)) internal _hasUsageAuth;
    mapping(address => address) public delegateAssistants;

    event AgentMinted(
        uint256 indexed tokenId,
        address indexed to,
        string encryptedStorageURI
    );
    event IntelligentDataUpdated(uint256 indexed tokenId);

    error NotTokenOwnerOrApproved();
    error EmptyIntelligentData();
    error AlreadyAuthorized();
    error NotAuthorized();
    error TokenDoesNotExist();
    error ProofCountMismatch();
    error OldDataHashMismatch();
    error InvalidAccessAssistant();
    error TargetPubkeyMismatch();

    constructor(
        string memory name_,
        string memory symbol_,
        address verifier_,
        address owner_
    ) ERC721(name_, symbol_) Ownable(owner_) {
        _verifier = IERC7857DataVerifier(verifier_);
    }

    // ---------- ERC-7857 introspection ----------

    /// @inheritdoc IERC7857
    function verifier() external view returns (IERC7857DataVerifier) {
        return _verifier;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual override(ERC721) returns (bool) {
        return
            interfaceId == type(IERC7857).interfaceId ||
            interfaceId == type(IERC7857Metadata).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    // ---------- ERC-721 reroutes (resolve multiple inheritance) ----------

    function name()
        public
        view
        virtual
        override(ERC721, IERC7857Metadata)
        returns (string memory)
    {
        return ERC721.name();
    }

    function symbol()
        public
        view
        virtual
        override(ERC721, IERC7857Metadata)
        returns (string memory)
    {
        return ERC721.symbol();
    }

    function ownerOf(
        uint256 tokenId_
    ) public view virtual override(ERC721, IERC7857) returns (address) {
        return ERC721.ownerOf(tokenId_);
    }

    function approve(
        address to,
        uint256 tokenId_
    ) public virtual override(ERC721, IERC7857) {
        ERC721.approve(to, tokenId_);
    }

    function getApproved(
        uint256 tokenId_
    ) public view virtual override(ERC721, IERC7857) returns (address) {
        return ERC721.getApproved(tokenId_);
    }

    function setApprovalForAll(
        address operator,
        bool approved_
    ) public virtual override(ERC721, IERC7857) {
        ERC721.setApprovalForAll(operator, approved_);
    }

    function isApprovedForAll(
        address owner_,
        address operator
    ) public view virtual override(ERC721, IERC7857) returns (bool) {
        return ERC721.isApprovedForAll(owner_, operator);
    }

    // ---------- Mint ----------

    /// @notice Mint a new iNFT with initial intelligent data.
    function mint(
        address to,
        IntelligentData[] calldata data_,
        string calldata encryptedStorageURI_
    ) external returns (uint256) {
        if (data_.length == 0) revert EmptyIntelligentData();

        uint256 tokenId = nextTokenId++;
        _safeMint(to, tokenId);

        for (uint256 i = 0; i < data_.length; i++) {
            _intelligentData[tokenId].push(data_[i]);
        }
        encryptedStorageURIs[tokenId] = encryptedStorageURI_;

        emit AgentMinted(tokenId, to, encryptedStorageURI_);
        return tokenId;
    }

    // ---------- ERC-7857: iTransfer ----------

    /// @inheritdoc IERC7857
    /// @dev Validates each proof against the verifier and the on-chain dataHash record.
    ///      Per ERC-7857 the access proof's signer (accessAssistant) MUST be the
    ///      receiver itself or a delegated assistant authorised via delegateAccess.
    function iTransfer(
        address _to,
        uint256 _tokenId,
        TransferValidityProof[] calldata _proofs
    ) external {
        if (!_isApprovedOrOwner(msg.sender, _tokenId))
            revert NotTokenOwnerOrApproved();

        IntelligentData[] storage data_ = _intelligentData[_tokenId];
        if (_proofs.length != data_.length) revert ProofCountMismatch();

        for (uint256 i = 0; i < _proofs.length; i++) {
            if (_proofs[i].ownershipProof.oldDataHash != data_[i].dataHash) {
                revert OldDataHashMismatch();
            }
        }

        TransferValidityProofOutput[] memory outputs = _verifier
            .verifyTransferValidity(_proofs);
        address delegate = delegateAssistants[_to];
        bytes[] memory keys = new bytes[](outputs.length);

        for (uint256 i = 0; i < outputs.length; i++) {
            if (
                outputs[i].accessAssistant != _to &&
                outputs[i].accessAssistant != delegate
            ) {
                revert InvalidAccessAssistant();
            }
            if (
                keccak256(outputs[i].encryptedPubKey) !=
                keccak256(outputs[i].wantedKey)
            ) revert TargetPubkeyMismatch();
            data_[i].dataHash = outputs[i].newDataHash;
            keys[i] = outputs[i].sealedKey;
        }

        delete _sealedKeys[_tokenId];
        for (uint256 i = 0; i < keys.length; i++) {
            _sealedKeys[_tokenId].push(keys[i]);
        }

        _clearAuthorizations(_tokenId);

        address from = ERC721.ownerOf(_tokenId);
        _safeTransfer(from, _to, _tokenId, "");

        emit Transferred(_tokenId, from, _to);
        emit PublishedSealedKey(_to, _tokenId, keys);
    }

    // ---------- ERC-7857: iClone ----------

    /// @inheritdoc IERC7857
    function iClone(
        address _to,
        uint256 _tokenId,
        TransferValidityProof[] calldata _proofs
    ) external returns (uint256 _newTokenId) {
        if (!_isApprovedOrOwner(msg.sender, _tokenId))
            revert NotTokenOwnerOrApproved();

        IntelligentData[] storage originalData = _intelligentData[_tokenId];
        if (_proofs.length != originalData.length) revert ProofCountMismatch();

        for (uint256 i = 0; i < _proofs.length; i++) {
            if (
                _proofs[i].ownershipProof.oldDataHash !=
                originalData[i].dataHash
            ) {
                revert OldDataHashMismatch();
            }
        }

        TransferValidityProofOutput[] memory outputs = _verifier
            .verifyTransferValidity(_proofs);
        address delegate = delegateAssistants[_to];

        _newTokenId = nextTokenId++;
        _safeMint(_to, _newTokenId);

        bytes[] memory keys = new bytes[](outputs.length);
        for (uint256 i = 0; i < outputs.length; i++) {
            if (
                outputs[i].accessAssistant != _to &&
                outputs[i].accessAssistant != delegate
            ) {
                revert InvalidAccessAssistant();
            }
            if (
                keccak256(outputs[i].encryptedPubKey) !=
                keccak256(outputs[i].wantedKey)
            ) revert TargetPubkeyMismatch();
            _intelligentData[_newTokenId].push(
                IntelligentData({
                    dataDescription: originalData[i].dataDescription,
                    dataHash: outputs[i].newDataHash
                })
            );
            _sealedKeys[_newTokenId].push(outputs[i].sealedKey);
            keys[i] = outputs[i].sealedKey;
        }

        emit Cloned(_tokenId, _newTokenId, msg.sender, _to);
        emit PublishedSealedKey(_to, _newTokenId, keys);
    }

    // ---------- Authorisation (usage without ownership) ----------

    /// @inheritdoc IERC7857
    function authorizeUsage(uint256 _tokenId, address _user) external {
        if (!_isApprovedOrOwner(msg.sender, _tokenId))
            revert NotTokenOwnerOrApproved();
        if (_hasUsageAuth[_tokenId][_user]) revert AlreadyAuthorized();

        _authorizedUsers[_tokenId].push(_user);
        _hasUsageAuth[_tokenId][_user] = true;
        emit Authorization(msg.sender, _user, _tokenId);
    }

    /// @inheritdoc IERC7857
    function revokeAuthorization(uint256 _tokenId, address _user) external {
        if (!_isApprovedOrOwner(msg.sender, _tokenId))
            revert NotTokenOwnerOrApproved();
        if (!_hasUsageAuth[_tokenId][_user]) revert NotAuthorized();

        _hasUsageAuth[_tokenId][_user] = false;

        address[] storage users = _authorizedUsers[_tokenId];
        for (uint256 i = 0; i < users.length; i++) {
            if (users[i] == _user) {
                users[i] = users[users.length - 1];
                users.pop();
                break;
            }
        }
        emit AuthorizationRevoked(msg.sender, _user, _tokenId);
    }

    /// @inheritdoc IERC7857
    function delegateAccess(address _assistant) external {
        delegateAssistants[msg.sender] = _assistant;
        emit DelegateAccess(msg.sender, _assistant);
    }

    // ---------- Views ----------

    /// @inheritdoc IERC7857Metadata
    function intelligentDataOf(
        uint256 _tokenId
    ) external view returns (IntelligentData[] memory) {
        if (_tokenId >= nextTokenId) revert TokenDoesNotExist();
        return _intelligentData[_tokenId];
    }

    /// @inheritdoc IERC7857
    function authorizedUsersOf(
        uint256 _tokenId
    ) external view returns (address[] memory) {
        return _authorizedUsers[_tokenId];
    }

    function sealedKeysOf(
        uint256 _tokenId
    ) external view returns (bytes[] memory) {
        return _sealedKeys[_tokenId];
    }

    /// @inheritdoc IERC7857
    function getDelegateAccess(address _user) external view returns (address) {
        return delegateAssistants[_user];
    }

    // ---------- Internal ----------

    function _clearAuthorizations(uint256 _tokenId) internal {
        address[] storage users = _authorizedUsers[_tokenId];
        for (uint256 i = 0; i < users.length; i++) {
            _hasUsageAuth[_tokenId][users[i]] = false;
        }
        delete _authorizedUsers[_tokenId];
    }

    function _isApprovedOrOwner(
        address spender,
        uint256 tokenId_
    ) internal view returns (bool) {
        address tokenOwner = ERC721.ownerOf(tokenId_);
        return
            spender == tokenOwner ||
            ERC721.getApproved(tokenId_) == spender ||
            ERC721.isApprovedForAll(tokenOwner, spender);
    }
}
