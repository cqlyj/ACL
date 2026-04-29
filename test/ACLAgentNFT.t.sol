// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ACLAgentNFT} from "../src/inft/ACLAgentNFT.sol";
import {TrustedPartyVerifier} from "../src/inft/TrustedPartyVerifier.sol";
import {IntelligentData} from "../src/interfaces/IERC7857Metadata.sol";
import {TransferValidityProof, AccessProof, OwnershipProof, OracleType} from "../src/interfaces/IERC7857DataVerifier.sol";

contract ACLAgentNFTTest is Test {
    ACLAgentNFT public nft;
    TrustedPartyVerifier public verifier;

    uint256 oracleKey = 0xA11CE;
    uint256 receiverKey = 0xBEEF;
    address oracle;
    address receiver;
    address owner = makeAddr("owner");
    address minter = makeAddr("minter");

    bytes constant ENCRYPTED_PUB_KEY = hex"04deadbeef";

    function setUp() public {
        oracle = vm.addr(oracleKey);
        receiver = vm.addr(receiverKey);

        verifier = new TrustedPartyVerifier(oracle, 1 hours, owner);
        nft = new ACLAgentNFT(
            "ACL Agent iNFT",
            "ACL-iNFT",
            address(verifier),
            owner
        );
    }

    function test_mint() public {
        IntelligentData[] memory data = _makeIntelligentData();

        vm.prank(minter);
        uint256 tokenId = nft.mint(minter, data, "0g://encrypted-config");

        assertEq(tokenId, 0);
        assertEq(nft.ownerOf(tokenId), minter);
        assertEq(nft.nextTokenId(), 1);

        IntelligentData[] memory stored = nft.intelligentDataOf(tokenId);
        assertEq(stored.length, 1);
        assertEq(stored[0].dataHash, keccak256("encrypted-agent-config"));

        assertEq(
            keccak256(bytes(nft.encryptedStorageURIs(tokenId))),
            keccak256(bytes("0g://encrypted-config"))
        );
    }

    function test_mint_revertEmptyData() public {
        IntelligentData[] memory empty = new IntelligentData[](0);
        vm.prank(minter);
        vm.expectRevert(ACLAgentNFT.EmptyIntelligentData.selector);
        nft.mint(minter, empty, "uri");
    }

    function test_iTransfer() public {
        IntelligentData[] memory data = _makeIntelligentData();
        vm.prank(minter);
        uint256 tokenId = nft.mint(minter, data, "0g://config");

        bytes32 oldHash = keccak256("encrypted-agent-config");
        bytes32 newHash = keccak256("re-encrypted-agent-config");

        TransferValidityProof[] memory proofs = _makeTransferProofs(
            oldHash,
            newHash
        );

        vm.prank(minter);
        nft.iTransfer(receiver, tokenId, proofs);

        assertEq(nft.ownerOf(tokenId), receiver);

        IntelligentData[] memory updated = nft.intelligentDataOf(tokenId);
        assertEq(updated[0].dataHash, newHash);

        bytes[] memory keys = nft.sealedKeysOf(tokenId);
        assertEq(keys.length, 1);
    }

    function test_iTransfer_revertOldDataHashMismatch() public {
        IntelligentData[] memory data = _makeIntelligentData();
        vm.prank(minter);
        uint256 tokenId = nft.mint(minter, data, "0g://config");

        bytes32 wrongOldHash = keccak256("not-the-real-hash");
        bytes32 newHash = keccak256("re-encrypted");

        TransferValidityProof[] memory proofs = _makeTransferProofs(
            wrongOldHash,
            newHash
        );

        vm.prank(minter);
        vm.expectRevert(ACLAgentNFT.OldDataHashMismatch.selector);
        nft.iTransfer(receiver, tokenId, proofs);
    }

    function test_iTransfer_revertProofCountMismatch() public {
        IntelligentData[] memory data = _makeIntelligentData();
        vm.prank(minter);
        uint256 tokenId = nft.mint(minter, data, "0g://config");

        TransferValidityProof[] memory proofs = new TransferValidityProof[](0);

        vm.prank(minter);
        vm.expectRevert(ACLAgentNFT.ProofCountMismatch.selector);
        nft.iTransfer(receiver, tokenId, proofs);
    }

    function test_iTransfer_revertWrongAccessAssistant() public {
        IntelligentData[] memory data = _makeIntelligentData();
        vm.prank(minter);
        uint256 tokenId = nft.mint(minter, data, "0g://config");

        bytes32 oldHash = keccak256("encrypted-agent-config");
        bytes32 newHash = keccak256("re-encrypted-agent-config");

        // sign access proof with a key not matching the receiver and not delegated
        uint256 strangerKey = 0xFA11;
        bytes memory nonce = abi.encode(block.timestamp);
        OwnershipProof memory op = _signOwnership(
            oldHash,
            newHash,
            abi.encode("sk"),
            nonce
        );
        AccessProof memory ap = _signAccessWithKey(
            strangerKey,
            oldHash,
            newHash,
            nonce
        );
        TransferValidityProof[] memory proofs = new TransferValidityProof[](1);
        proofs[0] = TransferValidityProof({
            accessProof: ap,
            ownershipProof: op
        });

        vm.prank(minter);
        vm.expectRevert(ACLAgentNFT.InvalidAccessAssistant.selector);
        nft.iTransfer(receiver, tokenId, proofs);
    }

    function test_iClone() public {
        IntelligentData[] memory data = _makeIntelligentData();
        vm.prank(minter);
        uint256 tokenId = nft.mint(minter, data, "0g://config");

        bytes32 oldHash = keccak256("encrypted-agent-config");
        bytes32 newHash = keccak256("cloned-agent-config");

        TransferValidityProof[] memory proofs = _makeTransferProofs(
            oldHash,
            newHash
        );

        vm.prank(minter);
        uint256 newTokenId = nft.iClone(receiver, tokenId, proofs);

        assertEq(nft.ownerOf(tokenId), minter);
        assertEq(nft.ownerOf(newTokenId), receiver);

        IntelligentData[] memory clonedData = nft.intelligentDataOf(newTokenId);
        assertEq(clonedData[0].dataHash, newHash);
    }

    function test_authorizeUsage() public {
        IntelligentData[] memory data = _makeIntelligentData();
        vm.prank(minter);
        uint256 tokenId = nft.mint(minter, data, "uri");

        address user = makeAddr("user");
        vm.prank(minter);
        nft.authorizeUsage(tokenId, user);

        address[] memory users = nft.authorizedUsersOf(tokenId);
        assertEq(users.length, 1);
        assertEq(users[0], user);
    }

    function test_revokeAuthorization() public {
        IntelligentData[] memory data = _makeIntelligentData();
        vm.prank(minter);
        uint256 tokenId = nft.mint(minter, data, "uri");

        address user = makeAddr("user");
        vm.prank(minter);
        nft.authorizeUsage(tokenId, user);

        vm.prank(minter);
        nft.revokeAuthorization(tokenId, user);

        assertEq(nft.authorizedUsersOf(tokenId).length, 0);
    }

    function test_delegateAccess() public {
        address assistant = makeAddr("assistant");
        vm.prank(minter);
        nft.delegateAccess(assistant);

        assertEq(nft.getDelegateAccess(minter), assistant);
    }

    function test_supportsInterface() public view {
        assertTrue(nft.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(nft.supportsInterface(0x01ffc9a7)); // ERC-165
    }

    // ---------- Helpers ----------

    function _makeIntelligentData()
        internal
        pure
        returns (IntelligentData[] memory)
    {
        IntelligentData[] memory data = new IntelligentData[](1);
        data[0] = IntelligentData({
            dataDescription: "ACL Agent Configuration Bundle",
            dataHash: keccak256("encrypted-agent-config")
        });
        return data;
    }

    function _makeTransferProofs(
        bytes32 oldHash,
        bytes32 newHash
    ) internal view returns (TransferValidityProof[] memory) {
        bytes memory nonce = abi.encode(block.timestamp);
        bytes memory sealedKey = abi.encode("sealed-key-for-receiver");

        OwnershipProof memory op = _signOwnership(
            oldHash,
            newHash,
            sealedKey,
            nonce
        );
        AccessProof memory ap = _signAccessWithKey(
            receiverKey,
            oldHash,
            newHash,
            nonce
        );

        TransferValidityProof[] memory proofs = new TransferValidityProof[](1);
        proofs[0] = TransferValidityProof({
            accessProof: ap,
            ownershipProof: op
        });
        return proofs;
    }

    function _signOwnership(
        bytes32 oldHash,
        bytes32 newHash,
        bytes memory sealedKey,
        bytes memory nonce
    ) internal view returns (OwnershipProof memory) {
        bytes32 msg_ = keccak256(
            abi.encode(
                address(verifier),
                block.chainid,
                OracleType.TEE,
                oldHash,
                newHash,
                sealedKey,
                ENCRYPTED_PUB_KEY,
                nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, _ethHash(msg_));
        return
            OwnershipProof({
                oracleType: OracleType.TEE,
                oldDataHash: oldHash,
                newDataHash: newHash,
                sealedKey: sealedKey,
                encryptedPubKey: ENCRYPTED_PUB_KEY,
                nonce: nonce,
                proof: abi.encodePacked(r, s, v)
            });
    }

    function _signAccessWithKey(
        uint256 signerKey,
        bytes32 oldHash,
        bytes32 newHash,
        bytes memory nonce
    ) internal view returns (AccessProof memory) {
        bytes32 msg_ = keccak256(
            abi.encode(
                address(verifier),
                block.chainid,
                oldHash,
                newHash,
                ENCRYPTED_PUB_KEY,
                nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, _ethHash(msg_));
        return
            AccessProof({
                oldDataHash: oldHash,
                newDataHash: newHash,
                nonce: nonce,
                encryptedPubKey: ENCRYPTED_PUB_KEY,
                proof: abi.encodePacked(r, s, v)
            });
    }

    function _ethHash(bytes32 hash) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)
            );
    }
}
