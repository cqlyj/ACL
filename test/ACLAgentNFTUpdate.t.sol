// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ACLAgentNFT} from "../src/inft/ACLAgentNFT.sol";
import {TrustedPartyVerifier} from "../src/inft/TrustedPartyVerifier.sol";
import {IntelligentData} from "../src/interfaces/IERC7857Metadata.sol";

contract ACLAgentNFTUpdateTest is Test {
    ACLAgentNFT public nft;
    TrustedPartyVerifier public verifier;

    uint256 oracleKey = 0xA11CE;
    address oracle;
    address owner = makeAddr("owner");
    address minter = makeAddr("minter");
    address stranger = makeAddr("stranger");

    string constant INITIAL_URI = "0g://initial";
    string constant REFRESH_URI = "0g://refreshed";

    event IntelligentDataUpdated(uint256 indexed tokenId);

    function setUp() public {
        oracle = vm.addr(oracleKey);
        verifier = new TrustedPartyVerifier(oracle, 1 hours, owner);
        nft = new ACLAgentNFT(
            "ACL Agent iNFT",
            "ACL-iNFT",
            address(verifier),
            owner
        );
    }

    /// @dev Owner can refresh both the IntelligentData[] payload and the
    ///      encryptedStorageURI atomically. Event fires once. The token's
    ///      first IntelligentData entry now carries the new dataHash.
    function test_update_owner_refreshesDataAndURI() public {
        uint256 tokenId = _mint();

        IntelligentData[] memory next = new IntelligentData[](2);
        next[0] = IntelligentData({
            dataDescription: "Refreshed Bundle (persona)",
            dataHash: keccak256("re-encrypted-persona-v2")
        });
        next[1] = IntelligentData({
            dataDescription: "Refreshed Bundle (corpus)",
            dataHash: keccak256("re-encrypted-corpus-v2")
        });

        vm.expectEmit(true, false, false, false, address(nft));
        emit IntelligentDataUpdated(tokenId);

        vm.prank(minter);
        nft.update(tokenId, next, REFRESH_URI);

        IntelligentData[] memory stored = nft.intelligentDataOf(tokenId);
        assertEq(stored.length, 2);
        assertEq(stored[0].dataHash, keccak256("re-encrypted-persona-v2"));
        assertEq(stored[1].dataHash, keccak256("re-encrypted-corpus-v2"));
        assertEq(
            keccak256(bytes(nft.encryptedStorageURIs(tokenId))),
            keccak256(bytes(REFRESH_URI))
        );
    }

    /// @dev A non-owner / non-approved address cannot call update, even
    ///      though the contract is otherwise public.
    function test_update_revertsWhenNotOwnerOrApproved() public {
        uint256 tokenId = _mint();
        IntelligentData[] memory next = _makeOne("payload-v2");

        vm.prank(stranger);
        vm.expectRevert(ACLAgentNFT.NotTokenOwnerOrApproved.selector);
        nft.update(tokenId, next, "");
    }

    /// @dev Empty IntelligentData[] is rejected — same invariant as mint.
    ///      Empty newEncryptedStorageURI ("") is the documented sentinel
    ///      that leaves the on-chain URI untouched.
    function test_update_revertsOnEmptyDataAndPreservesUriOnEmptyString()
        public
    {
        uint256 tokenId = _mint();

        IntelligentData[] memory empty = new IntelligentData[](0);
        vm.prank(minter);
        vm.expectRevert(ACLAgentNFT.EmptyIntelligentData.selector);
        nft.update(tokenId, empty, "");

        IntelligentData[] memory next = _makeOne("payload-v2");
        vm.prank(minter);
        nft.update(tokenId, next, "");

        // URI-only sentinel: data refreshed, URI left at the initial value.
        IntelligentData[] memory stored = nft.intelligentDataOf(tokenId);
        assertEq(stored.length, 1);
        assertEq(stored[0].dataHash, keccak256("payload-v2"));
        assertEq(
            keccak256(bytes(nft.encryptedStorageURIs(tokenId))),
            keccak256(bytes(INITIAL_URI))
        );
    }

    /// @dev An approved (ERC-721 setApprovalForAll) operator can refresh
    ///      the on-chain corpus the same as the owner.
    function test_update_approvedForAll_canRefresh() public {
        uint256 tokenId = _mint();
        address operator = makeAddr("operator");
        vm.prank(minter);
        nft.setApprovalForAll(operator, true);

        IntelligentData[] memory next = _makeOne("payload-v2");
        vm.prank(operator);
        nft.update(tokenId, next, REFRESH_URI);

        assertEq(
            keccak256(bytes(nft.encryptedStorageURIs(tokenId))),
            keccak256(bytes(REFRESH_URI))
        );
    }

    // ---------- Helpers ----------

    function _mint() internal returns (uint256) {
        IntelligentData[] memory data = _makeOne("payload-v1");
        vm.prank(minter);
        return nft.mint(minter, data, INITIAL_URI);
    }

    function _makeOne(
        string memory tag
    ) internal pure returns (IntelligentData[] memory) {
        IntelligentData[] memory data = new IntelligentData[](1);
        data[0] = IntelligentData({
            dataDescription: "ACL Agent Bundle",
            dataHash: keccak256(bytes(tag))
        });
        return data;
    }
}
