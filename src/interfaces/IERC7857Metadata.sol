// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev See https://eips.ethereum.org/EIPS/eip-7857 - Metadata Interface section.

struct IntelligentData {
    string dataDescription;
    bytes32 dataHash;
}

/// @title IERC7857Metadata — iNFT intelligent data access
interface IERC7857Metadata {
    function name() external view returns (string memory);

    function symbol() external view returns (string memory);

    function intelligentDataOf(
        uint256 _tokenId
    ) external view returns (IntelligentData[] memory);
}
