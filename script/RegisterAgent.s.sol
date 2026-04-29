// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentMetadataScript} from "./lib/AgentMetadataScript.sol";
import {ACLIdentityRegistry} from "../src/registry/ACLIdentityRegistry.sol";
import {ACLTestUSDC} from "../src/token/ACLTestUSDC.sol";
import {console} from "forge-std/Script.sol";

/// @title RegisterAgent
/// @notice Mints the demo provider agent NFT in the ACL IdentityRegistry,
///         writes the canonical ACL metadata key set, and seeds tUSDC
///         balances for the demo client + provider.
/// @dev Two-step flow: register with empty URI to discover the assigned
///      agentId, then write metadata + the canonical `data:` agentURI via
///      the shared AgentMetadataScript helpers. This keeps the script
///      identical in shape to SetAgentMetadata so updates are predictable.
contract RegisterAgent is AgentMetadataScript {
    function run() external {
        address registryAddr = vm.envAddress("ACL_IDENTITY_REGISTRY");
        ACLIdentityRegistry registry = ACLIdentityRegistry(registryAddr);

        AgentMetadataInput memory input = _readEnvInput();

        vm.startBroadcast();

        uint256 agentId = registry.register();
        console.log("Provider agentId:", agentId);

        _writeMetadataAndURI(registry, agentId, input);

        // Demo seeding: only the first listed token is treated as the
        // primary stablecoin and minted for the client/provider. Multi-token
        // agents will need richer seeding off-script.
        ACLTestUSDC token = ACLTestUSDC(input.paymentTokens[0]);
        address clientAddr = vm.envAddress("CLIENT_ADDRESS");
        token.mint(clientAddr, 10_000e6);
        token.mint(input.agentAddress, 10_000e6);
        console.log("Minted 10,000 tUSDC to client and provider");

        vm.stopBroadcast();
    }
}
