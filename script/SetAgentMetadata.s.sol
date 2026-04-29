// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentMetadataScript} from "./lib/AgentMetadataScript.sol";
import {ACLIdentityRegistry} from "../src/registry/ACLIdentityRegistry.sol";

/// @title SetAgentMetadata
/// @notice Idempotent script that rewrites the canonical ACL metadata
///         key set for an already-registered agent. Run after the AXL node
///         finishes generating its long-term peer key, or any time the
///         agent profile (evaluator, payment token, budget, …) changes.
/// @dev    Migration aid: also clears the deprecated `acl.evaluator` key so
///         only `acl.evaluator-address` survives in the registry.
contract SetAgentMetadata is AgentMetadataScript {
    string private constant LEGACY_EVALUATOR_KEY = "acl.evaluator";

    function run() external {
        address registryAddr = vm.envAddress("ACL_IDENTITY_REGISTRY");
        uint256 agentId = vm.envUint("PROVIDER_AGENT_ID");
        ACLIdentityRegistry registry = ACLIdentityRegistry(registryAddr);

        AgentMetadataInput memory input = _readEnvInput();

        vm.startBroadcast();

        registry.setMetadata(agentId, LEGACY_EVALUATOR_KEY, bytes(""));
        _writeMetadataAndURI(registry, agentId, input);

        vm.stopBroadcast();
    }
}
