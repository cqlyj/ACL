// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC7857DataVerifier, TransferValidityProof} from "./IERC7857DataVerifier.sol";

/// @title IERC7857 — AI Agent NFT with Private Metadata (main interface)
/// @dev See https://eips.ethereum.org/EIPS/eip-7857
///      Approval / ApprovalForAll events are inherited from ERC-721 implementations
///      and intentionally NOT redeclared here to avoid duplicate-event errors.
interface IERC7857 {
    event Authorization(
        address indexed _from,
        address indexed _to,
        uint256 indexed _tokenId
    );
    event AuthorizationRevoked(
        address indexed _from,
        address indexed _to,
        uint256 indexed _tokenId
    );
    event Transferred(
        uint256 _tokenId,
        address indexed _from,
        address indexed _to
    );
    event Cloned(
        uint256 indexed _tokenId,
        uint256 indexed _newTokenId,
        address _from,
        address _to
    );
    event PublishedSealedKey(
        address indexed _to,
        uint256 indexed _tokenId,
        bytes[] _sealedKeys
    );
    event DelegateAccess(address indexed _user, address indexed _assistant);

    function verifier() external view returns (IERC7857DataVerifier);

    function iTransfer(
        address _to,
        uint256 _tokenId,
        TransferValidityProof[] calldata _proofs
    ) external;

    function iClone(
        address _to,
        uint256 _tokenId,
        TransferValidityProof[] calldata _proofs
    ) external returns (uint256 _newTokenId);

    function authorizeUsage(uint256 _tokenId, address _user) external;

    function revokeAuthorization(uint256 _tokenId, address _user) external;

    function approve(address _to, uint256 _tokenId) external;

    function setApprovalForAll(address _operator, bool _approved) external;

    function delegateAccess(address _assistant) external;

    function ownerOf(uint256 _tokenId) external view returns (address);

    function authorizedUsersOf(
        uint256 _tokenId
    ) external view returns (address[] memory);

    function getApproved(uint256 _tokenId) external view returns (address);

    function isApprovedForAll(
        address _owner,
        address _operator
    ) external view returns (bool);

    function getDelegateAccess(address _user) external view returns (address);
}
