// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ACLIdentityRegistry} from "../../src/registry/ACLIdentityRegistry.sol";
import {AgentMetadataBuilder} from "./AgentMetadataBuilder.sol";

/// @title AgentMetadataScript
/// @notice Shared helpers for writing the canonical ACL agent metadata
///         key-set to an ACLIdentityRegistry. Used by both the initial
///         RegisterAgent script and the idempotent SetAgentMetadata script
///         so the on-chain shape stays in lock-step.
abstract contract AgentMetadataScript is Script {
    /// @dev Default values applied to optional environment variables. Kept
    ///      together so contributors don't have to grep for "researcher".
    string private constant _DEFAULT_ENS_LABEL = "researcher";
    string private constant _DEFAULT_TASK_DOMAINS = "science,technology";
    string private constant _DEFAULT_DELIVERY_TYPES = "text";
    uint256 private constant _DEFAULT_MIN_BUDGET = 100e6;
    string private constant _PARENT_ENS_NAME = "acl.eth";

    struct AgentMetadataInput {
        string ensLabel;
        address agentAddress;
        address evaluatorAddress;
        address[] paymentTokens;
        uint256 minBudget;
        uint256 chainId;
        string axlPeerId;
        string taskDomains;
        string deliveryTypes;
    }

    /// @notice Write every canonical ACL metadata key for `agentId` and
    ///         update the agent's tokenURI to an ERC-8004 v2 `data:`
    ///         registration file.
    /// @dev    Caller MUST be inside an active broadcast (vm.startBroadcast) and
    ///         either own the agent or hold operator rights. The `agentRegistry`
    ///         CAIP-10 string embedded in the JSON comes from the contract
    ///         itself so the on-chain helper is the single source of truth.
    function _writeMetadataAndURI(
        ACLIdentityRegistry registry,
        uint256 agentId,
        AgentMetadataInput memory input
    ) internal {
        _writeOnchainMetadata(registry, agentId, input);

        string memory uri = AgentMetadataBuilder.buildAgentURI(
            AgentMetadataBuilder.AgentURIInput({
                ensName: _ensName(input.ensLabel),
                description: _description(agentId, input.chainId),
                image: "",
                agentId: agentId,
                agentRegistry: registry.agentRegistryURI(agentId)
            })
        );
        registry.setAgentURI(agentId, uri);

        console.log("Agent metadata written for agentId:", agentId);
        console.log("  ens label:", input.ensLabel);
        console.log("  axl peer id:", input.axlPeerId);
        console.log("  chain id:", input.chainId);
        console.log("  agent uri (data:application/json;base64,...):");
        console.log(uri);
    }

    /// @dev Split out so the URI generation in `_writeMetadataAndURI` reads
    ///      top-down without each setMetadata call drowning the eye.
    function _writeOnchainMetadata(
        ACLIdentityRegistry registry,
        uint256 agentId,
        AgentMetadataInput memory input
    ) private {
        registry.setMetadata(
            agentId,
            AgentMetadataBuilder.KEY_AGENT_ADDRESS,
            abi.encode(input.agentAddress)
        );
        registry.setMetadata(
            agentId,
            AgentMetadataBuilder.KEY_EVALUATOR_ADDRESS,
            abi.encode(input.evaluatorAddress)
        );
        registry.setMetadata(
            agentId,
            AgentMetadataBuilder.KEY_PAYMENT_TOKENS,
            abi.encode(input.paymentTokens)
        );
        registry.setMetadata(
            agentId,
            AgentMetadataBuilder.KEY_MIN_BUDGET,
            abi.encode(input.minBudget)
        );
        registry.setMetadata(
            agentId,
            AgentMetadataBuilder.KEY_CHAIN_ID,
            abi.encode(input.chainId)
        );
        registry.setMetadata(
            agentId,
            AgentMetadataBuilder.KEY_TASK_DOMAINS,
            bytes(input.taskDomains)
        );
        registry.setMetadata(
            agentId,
            AgentMetadataBuilder.KEY_DELIVERY_TYPES,
            bytes(input.deliveryTypes)
        );
        registry.setMetadata(
            agentId,
            AgentMetadataBuilder.KEY_AXL_PEER_ID,
            bytes(input.axlPeerId)
        );
        registry.setMetadata(
            agentId,
            AgentMetadataBuilder.KEY_ENS_LABEL,
            bytes(input.ensLabel)
        );
    }

    function _ensName(
        string memory ensLabel
    ) private pure returns (string memory) {
        return string.concat(ensLabel, ".", _PARENT_ENS_NAME);
    }

    function _description(
        uint256 agentId,
        uint256 chainId
    ) private pure returns (string memory) {
        return
            string.concat(
                "ACL Agent #",
                Strings.toString(agentId),
                " (ERC-8004 v2 + ENSIP-25) on chain ",
                Strings.toString(chainId)
            );
    }

    /// @notice Build the input struct from environment variables. Centralised
    ///         here so RegisterAgent and SetAgentMetadata read the exact same
    ///         keys.
    /// @dev Payment tokens come from `PROVIDER_PAYMENT_TOKENS` (comma-separated)
    ///      if set, else fall back to the singular `ACL_TEST_USDC` for the
    ///      demo-friendly "one stablecoin" path.
    function _readEnvInput() internal view returns (AgentMetadataInput memory) {
        return
            AgentMetadataInput({
                ensLabel: vm.envOr(
                    "PROVIDER_ENS_LABEL",
                    string(_DEFAULT_ENS_LABEL)
                ),
                agentAddress: vm.envAddress("PROVIDER_ADDRESS"),
                evaluatorAddress: vm.envAddress("ACL_EVALUATOR"),
                paymentTokens: _readPaymentTokens(),
                minBudget: vm.envOr("PROVIDER_MIN_BUDGET", _DEFAULT_MIN_BUDGET),
                chainId: block.chainid,
                axlPeerId: vm.envString("PROVIDER_AXL_PEER_ID"),
                taskDomains: vm.envOr(
                    "PROVIDER_TASK_DOMAINS",
                    string(_DEFAULT_TASK_DOMAINS)
                ),
                deliveryTypes: vm.envOr(
                    "PROVIDER_DELIVERY_TYPES",
                    string(_DEFAULT_DELIVERY_TYPES)
                )
            });
    }

    function _readPaymentTokens() private view returns (address[] memory) {
        try vm.envAddress("PROVIDER_PAYMENT_TOKENS", ",") returns (
            address[] memory list
        ) {
            if (list.length > 0) return list;
        } catch {}
        address[] memory single = new address[](1);
        single[0] = vm.envAddress("ACL_TEST_USDC");
        return single;
    }
}
