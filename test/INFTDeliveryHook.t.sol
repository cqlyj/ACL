// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgenticCommerce} from "../src/core/AgenticCommerce.sol";
import {INFTDeliveryHook} from "../src/hooks/INFTDeliveryHook.sol";
import {ACLIdentityRegistry} from "../src/registry/ACLIdentityRegistry.sol";
import {ACLReputationRegistry} from "../src/registry/ACLReputationRegistry.sol";
import {ACLAgentNFT} from "../src/inft/ACLAgentNFT.sol";
import {TrustedPartyVerifier} from "../src/inft/TrustedPartyVerifier.sol";
import {ACLTestUSDC} from "../src/token/ACLTestUSDC.sol";
import {IntelligentData} from "../src/interfaces/IERC7857Metadata.sol";
import {TransferValidityProof, AccessProof, OwnershipProof, OracleType} from "../src/interfaces/IERC7857DataVerifier.sol";

contract INFTDeliveryHookTest is Test {
    AgenticCommerce public commerce;
    INFTDeliveryHook public hook;
    ACLIdentityRegistry public identity;
    ACLReputationRegistry public reputation;
    ACLAgentNFT public nft;
    TrustedPartyVerifier public verifier;
    ACLTestUSDC public token;

    address owner = makeAddr("owner");
    address client; // buyer (derived from key)
    address provider = makeAddr("provider");
    address evaluator = makeAddr("evaluator");
    address treasury = makeAddr("treasury");

    uint256 constant SERVICE_FEE = 500e6;
    uint256 oracleKey = 0xA11CE;
    uint256 clientKey = 0xBEEF;
    address oracle;
    bytes constant ENCRYPTED_PUB_KEY = hex"04deadbeef";

    uint256 providerAgentId;

    function setUp() public {
        oracle = vm.addr(oracleKey);
        client = vm.addr(clientKey);

        token = new ACLTestUSDC("tUSDC", "tUSDC", 6);
        commerce = new AgenticCommerce(address(token), treasury, owner);
        identity = new ACLIdentityRegistry();
        reputation = new ACLReputationRegistry();
        reputation.initialize(address(identity));
        verifier = new TrustedPartyVerifier(oracle, 1 hours, owner);
        nft = new ACLAgentNFT("ACL iNFT", "ACL-iNFT", address(verifier), owner);
        hook = new INFTDeliveryHook(address(commerce), address(reputation));

        vm.prank(owner);
        commerce.setHookWhitelist(address(hook), true);

        vm.prank(provider);
        providerAgentId = identity.register("0g://provider/agent.json");

        token.mint(client, 100_000e6);
        vm.prank(client);
        token.approve(address(commerce), type(uint256).max);
    }

    function test_fullFlow_iNFTDelivery() public {
        uint256 tokenId = _mintTestNFT();
        assertEq(nft.ownerOf(tokenId), provider);

        uint256 expiry = block.timestamp + 1 hours;
        vm.prank(client);
        uint256 jobId = commerce.createJob(
            provider,
            evaluator,
            expiry,
            "buy iNFT",
            address(hook)
        );

        bytes memory budgetParams = abi.encode(
            address(nft),
            tokenId,
            providerAgentId
        );
        vm.prank(provider);
        commerce.setBudget(jobId, SERVICE_FEE, budgetParams);

        INFTDeliveryHook.EscrowInfo memory info = hook.escrowOf(jobId);
        assertEq(info.nftContract, address(nft));
        assertEq(info.tokenId, tokenId);
        assertEq(info.providerAgentId, providerAgentId);

        bytes32 oldHash = keccak256("encrypted-config");
        bytes32 newHash = keccak256("re-encrypted-for-buyer");
        TransferValidityProof[] memory proofs = _makeBuyerProofs(
            oldHash,
            newHash
        );

        vm.prank(client);
        commerce.fund(jobId, SERVICE_FEE, abi.encode(proofs));

        vm.prank(provider);
        nft.approve(address(hook), tokenId);
        vm.prank(provider);
        commerce.submit(jobId, keccak256("inft-delivery"), "");

        assertEq(nft.ownerOf(tokenId), address(hook));

        vm.prank(evaluator);
        commerce.complete(jobId, keccak256("attestation"), "");

        assertEq(nft.ownerOf(tokenId), client);
        assertEq(token.balanceOf(provider), SERVICE_FEE);

        address[] memory clients = new address[](1);
        clients[0] = address(hook);
        (uint64 count, int128 mean, ) = reputation.getSummary(
            providerAgentId,
            clients,
            "inft-sale-complete",
            ""
        );
        assertEq(count, 1);
        assertEq(mean, 100);
    }

    function test_reject_returnsNFT() public {
        uint256 tokenId = _mintTestNFT();

        uint256 expiry = block.timestamp + 1 hours;
        vm.prank(client);
        uint256 jobId = commerce.createJob(
            provider,
            evaluator,
            expiry,
            "buy iNFT",
            address(hook)
        );

        vm.prank(provider);
        commerce.setBudget(
            jobId,
            SERVICE_FEE,
            abi.encode(address(nft), tokenId, providerAgentId)
        );

        bytes32 oldHash = keccak256("encrypted-config");
        bytes32 newHash = keccak256("re-encrypted-for-buyer");
        TransferValidityProof[] memory proofs = _makeBuyerProofs(
            oldHash,
            newHash
        );
        vm.prank(client);
        commerce.fund(jobId, SERVICE_FEE, abi.encode(proofs));

        vm.prank(provider);
        nft.approve(address(hook), tokenId);
        vm.prank(provider);
        commerce.submit(jobId, keccak256("inft"), "");

        assertEq(nft.ownerOf(tokenId), address(hook));

        vm.prank(evaluator);
        commerce.reject(jobId, keccak256("bad"), "");

        assertEq(nft.ownerOf(tokenId), provider);
    }

    function test_recoverNFT_afterExpiry() public {
        uint256 tokenId = _mintTestNFT();

        uint256 expiry = block.timestamp + 1 hours;
        vm.prank(client);
        uint256 jobId = commerce.createJob(
            provider,
            evaluator,
            expiry,
            "buy iNFT",
            address(hook)
        );

        vm.prank(provider);
        commerce.setBudget(
            jobId,
            SERVICE_FEE,
            abi.encode(address(nft), tokenId, providerAgentId)
        );

        bytes32 oldHash = keccak256("encrypted-config");
        bytes32 newHash = keccak256("re-encrypted-for-buyer");
        TransferValidityProof[] memory proofs = _makeBuyerProofs(
            oldHash,
            newHash
        );
        vm.prank(client);
        commerce.fund(jobId, SERVICE_FEE, abi.encode(proofs));

        vm.prank(provider);
        nft.approve(address(hook), tokenId);
        vm.prank(provider);
        commerce.submit(jobId, keccak256("inft"), "");

        vm.warp(block.timestamp + 1 hours + 1);
        commerce.claimRefund(jobId);

        vm.prank(provider);
        hook.recoverNFT(jobId);

        assertEq(nft.ownerOf(tokenId), provider);
    }

    function test_recoverNFT_revertNotRecoverable() public {
        uint256 tokenId = _mintTestNFT();

        uint256 expiry = block.timestamp + 1 hours;
        vm.prank(client);
        uint256 jobId = commerce.createJob(
            provider,
            evaluator,
            expiry,
            "buy iNFT",
            address(hook)
        );

        vm.prank(provider);
        commerce.setBudget(
            jobId,
            SERVICE_FEE,
            abi.encode(address(nft), tokenId, providerAgentId)
        );

        bytes32 oldHash = keccak256("encrypted-config");
        bytes32 newHash = keccak256("re-encrypted-for-buyer");
        TransferValidityProof[] memory proofs = _makeBuyerProofs(
            oldHash,
            newHash
        );
        vm.prank(client);
        commerce.fund(jobId, SERVICE_FEE, abi.encode(proofs));

        vm.prank(provider);
        nft.approve(address(hook), tokenId);
        vm.prank(provider);
        commerce.submit(jobId, keccak256("inft"), "");

        vm.prank(provider);
        vm.expectRevert(INFTDeliveryHook.JobNotRecoverable.selector);
        hook.recoverNFT(jobId);
    }

    function _mintTestNFT() internal returns (uint256) {
        IntelligentData[] memory data = new IntelligentData[](1);
        data[0] = IntelligentData({
            dataDescription: "ACL Agent Config",
            dataHash: keccak256("encrypted-config")
        });

        vm.prank(provider);
        return nft.mint(provider, data, "0g://encrypted");
    }

    function _makeBuyerProofs(
        bytes32 oldHash,
        bytes32 newHash
    ) internal view returns (TransferValidityProof[] memory) {
        bytes memory nonce = abi.encode(block.timestamp);
        bytes memory sealedKey = abi.encode("sealed-key-for-buyer");

        OwnershipProof memory op = _signOwnership(
            oldHash,
            newHash,
            sealedKey,
            nonce
        );
        AccessProof memory ap = _signAccess(clientKey, oldHash, newHash, nonce);

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
        bytes32 hash = keccak256(
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, _ethHash(hash));
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

    function _signAccess(
        uint256 signerKey,
        bytes32 oldHash,
        bytes32 newHash,
        bytes memory nonce
    ) internal view returns (AccessProof memory) {
        bytes32 hash = keccak256(
            abi.encode(
                address(verifier),
                block.chainid,
                oldHash,
                newHash,
                ENCRYPTED_PUB_KEY,
                nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, _ethHash(hash));
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
