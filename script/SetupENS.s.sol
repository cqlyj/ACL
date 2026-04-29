// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";

interface IENSRegistry {
    function setResolver(
        bytes32 node,
        address resolver
    ) external;

    function resolver(
        bytes32 node
    ) external view returns (address);

    function owner(
        bytes32 node
    ) external view returns (address);
}

/// @title SetupENS — Points acl.eth to ACLOffchainResolver on Sepolia
/// @dev Run: forge script script/SetupENS.s.sol --rpc-url $SEPOLIA_RPC --broadcast
///      Requires: ENS_OWNER_PRIVATE_KEY (owner of acl.eth on Sepolia)
contract SetupENS is Script {
    function run() external {
        address resolverAddr = vm.envAddress("ACL_OFFCHAIN_RESOLVER");
        address ensRegistryAddr = vm.envAddress("ENS_REGISTRY");

        bytes32 parentNode = _namehash("acl.eth");

        IENSRegistry ensRegistry = IENSRegistry(ensRegistryAddr);

        address currentOwner = ensRegistry.owner(parentNode);
        address currentResolver = ensRegistry.resolver(parentNode);

        console.log("ENS parent node (acl.eth):", vm.toString(parentNode));
        console.log("Current owner:", currentOwner);
        console.log("Current resolver:", currentResolver);
        console.log("Target resolver:", resolverAddr);

        if (currentResolver == resolverAddr) {
            console.log("Resolver already set. Nothing to do.");
            return;
        }

        vm.startBroadcast();
        ensRegistry.setResolver(parentNode, resolverAddr);
        vm.stopBroadcast();

        console.log("Resolver updated for acl.eth");
    }

    function _namehash(
        string memory name
    ) internal pure returns (bytes32) {
        bytes32 node = bytes32(0);
        if (bytes(name).length == 0) return node;

        bytes memory nameBytes = bytes(name);
        uint256 i = nameBytes.length;

        while (i > 0) {
            uint256 labelStart = i;
            while (labelStart > 0 && nameBytes[labelStart - 1] != ".") {
                labelStart--;
            }

            bytes memory label = new bytes(i - labelStart);
            for (uint256 j = labelStart; j < i; j++) {
                label[j - labelStart] = nameBytes[j];
            }

            node = keccak256(abi.encodePacked(node, keccak256(label)));

            if (labelStart > 0) {
                i = labelStart - 1;
            } else {
                break;
            }
        }

        return node;
    }
}
