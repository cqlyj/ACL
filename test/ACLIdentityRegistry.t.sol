// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ACLIdentityRegistry} from "../src/registry/ACLIdentityRegistry.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";

contract ACLIdentityRegistryTest is Test {
    ACLIdentityRegistry public registry;

    address aliceOwner = makeAddr("aliceOwner");
    uint256 newWalletKey = 0xDEADBEEF;
    address newWallet;

    function setUp() public {
        registry = new ACLIdentityRegistry();
        newWallet = vm.addr(newWalletKey);
    }

    function test_register_minimal() public {
        vm.prank(aliceOwner);
        uint256 agentId = registry.register();
        assertEq(agentId, 1);
        assertEq(registry.ownerOf(agentId), aliceOwner);
        assertEq(registry.getAgentWallet(agentId), aliceOwner);
    }

    function test_register_withURI() public {
        vm.prank(aliceOwner);
        uint256 agentId = registry.register("0g://researcher/agent.json");
        assertEq(registry.tokenURI(agentId), "0g://researcher/agent.json");
    }

    function test_register_withMetadata() public {
        IERC8004Identity.MetadataEntry[]
            memory meta = new IERC8004Identity.MetadataEntry[](1);
        meta[0] = IERC8004Identity.MetadataEntry({
            metadataKey: "acl.task-domains",
            metadataValue: bytes("science")
        });

        vm.prank(aliceOwner);
        uint256 agentId = registry.register("u", meta);

        assertEq(
            string(registry.getMetadata(agentId, "acl.task-domains")),
            "science"
        );
    }

    function test_setAgentURI_byOwner() public {
        vm.prank(aliceOwner);
        uint256 agentId = registry.register("u1");

        vm.prank(aliceOwner);
        registry.setAgentURI(agentId, "u2");
        assertEq(registry.tokenURI(agentId), "u2");
    }

    function test_setAgentURI_revertNotOwner() public {
        vm.prank(aliceOwner);
        uint256 agentId = registry.register("u1");

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ACLIdentityRegistry.NotOwnerOrOperator.selector);
        registry.setAgentURI(agentId, "u2");
    }

    function test_setMetadata_revertReservedKey() public {
        vm.prank(aliceOwner);
        uint256 agentId = registry.register();

        vm.prank(aliceOwner);
        vm.expectRevert(ACLIdentityRegistry.ReservedKey.selector);
        registry.setMetadata(agentId, "agentWallet", abi.encode(newWallet));
    }

    function test_setAgentWallet_validSig() public {
        vm.prank(aliceOwner);
        uint256 agentId = registry.register();

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _agentWalletDigest(agentId, newWallet, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newWalletKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(aliceOwner);
        registry.setAgentWallet(agentId, newWallet, deadline, sig);
        assertEq(registry.getAgentWallet(agentId), newWallet);
    }

    function test_setAgentWallet_revertBadSig() public {
        vm.prank(aliceOwner);
        uint256 agentId = registry.register();

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _agentWalletDigest(agentId, newWallet, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xCAFE, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(aliceOwner);
        vm.expectRevert(ACLIdentityRegistry.InvalidWalletSignature.selector);
        registry.setAgentWallet(agentId, newWallet, deadline, sig);
    }

    function test_setAgentWallet_revertExpired() public {
        vm.prank(aliceOwner);
        uint256 agentId = registry.register();

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _agentWalletDigest(agentId, newWallet, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newWalletKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.warp(deadline + 1);

        vm.prank(aliceOwner);
        vm.expectRevert(ACLIdentityRegistry.DeadlineExpired.selector);
        registry.setAgentWallet(agentId, newWallet, deadline, sig);
    }

    function test_agentWallet_clearedOnTransfer() public {
        vm.prank(aliceOwner);
        uint256 agentId = registry.register();

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _agentWalletDigest(agentId, newWallet, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newWalletKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(aliceOwner);
        registry.setAgentWallet(agentId, newWallet, deadline, sig);
        assertEq(registry.getAgentWallet(agentId), newWallet);

        address bob = makeAddr("bob");
        vm.prank(aliceOwner);
        registry.transferFrom(aliceOwner, bob, agentId);
        assertEq(registry.getAgentWallet(agentId), address(0));
    }

    function test_agentRegistryURI_caip10Format() public {
        vm.prank(aliceOwner);
        uint256 agentId = registry.register();

        string memory expected = string.concat(
            "eip155:",
            Strings.toString(block.chainid),
            ":",
            Strings.toHexString(address(registry))
        );
        assertEq(registry.agentRegistryURI(agentId), expected);
    }

    function test_agentRegistryURI_revertsForUnknownAgent() public {
        vm.expectRevert(ACLIdentityRegistry.UnknownAgent.selector);
        registry.agentRegistryURI(999);
    }

    // ---------- helpers ----------

    function _agentWalletDigest(
        uint256 agentId,
        address wallet,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 typeHash = keccak256(
            "AgentWallet(uint256 agentId,address newWallet,uint256 deadline)"
        );
        bytes32 structHash = keccak256(
            abi.encode(typeHash, agentId, wallet, deadline)
        );
        bytes32 domainSeparator = _domainSeparator();
        return
            keccak256(
                abi.encodePacked("\x19\x01", domainSeparator, structHash)
            );
    }

    function _domainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("ACLIdentityRegistry")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(registry)
                )
            );
    }
}
