// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title AgentMetadataBuilder
/// @dev    Centralised so RegisterAgent and SetAgentMetadata stay byte-for-byte in sync.
library AgentMetadataBuilder {
    /// @dev Canonical metadata keys consumed by ACLOffchainResolver and the
    ///      ACL discovery SDK.
    string internal constant KEY_AGENT_ADDRESS = "acl.agent-address";
    string internal constant KEY_EVALUATOR_ADDRESS = "acl.evaluator-address";
    string internal constant KEY_AXL_PEER_ID = "acl.axl-peer-id";
    string internal constant KEY_TASK_DOMAINS = "acl.task-domains";
    string internal constant KEY_DELIVERY_TYPES = "acl.delivery-types";
    string internal constant KEY_PAYMENT_TOKENS = "acl.payment-tokens";
    string internal constant KEY_MIN_BUDGET = "acl.min-budget";
    string internal constant KEY_CHAIN_ID = "acl.chain-id";
    string internal constant KEY_ENS_LABEL = "acl.ens-label";

    /// @dev Constants pulled into named constants so the produced JSON is easy
    ///      to audit against the ERC-8004 v2 spec.
    string internal constant REGISTRATION_TYPE =
        "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
    string internal constant DEFAULT_TRUST_MODEL = "reputation";

    /// @notice Inputs for `buildAgentURI`. Grouped into a struct because the
    ///         positional argument list is otherwise long enough to be
    ///         error-prone, and keeping the call site readable matters more
    ///         than packing.
    /// @param ensName        Fully-qualified ENS name (e.g. "researcher.acl.eth").
    /// @param description    Free-form description (RFC compliant single line).
    /// @param image          Optional HTTPS/IPFS image URL; empty string allowed.
    /// @param agentId        Numeric token id assigned by the registry.
    /// @param agentRegistry  CAIP-10 registry identifier returned by
    ///                       `ACLIdentityRegistry.agentRegistryURI(agentId)`.
    ///                       Sourced from the contract directly so the JSON
    ///                       and on-chain helper never drift.
    struct AgentURIInput {
        string ensName;
        string description;
        string image;
        uint256 agentId;
        string agentRegistry;
    }

    /// @notice Build a self-contained `data:application/json;base64,...` token
    ///         URI for an ACL agent NFT. The encoded JSON is an ERC-8004 v2
    ///         registration file, which is also ERC-721-app friendly (the
    ///         top-level `name` / `description` / `image` fields render in
    ///         standard wallet apps).
    function buildAgentURI(
        AgentURIInput memory input
    ) internal pure returns (string memory) {
        string memory json = string.concat(
            '{"type":"',
            REGISTRATION_TYPE,
            '","name":"',
            input.ensName,
            '","description":"',
            input.description,
            '","image":"',
            input.image,
            '",',
            _servicesJson(input.ensName),
            ',"x402Support":false,"active":true,',
            _registrationsJson(input.agentId, input.agentRegistry),
            ',"supportedTrust":["',
            DEFAULT_TRUST_MODEL,
            '"]}'
        );
        return
            string.concat(
                "data:application/json;base64,",
                Base64.encode(bytes(json))
            );
    }

    /// @dev Minimum compliant `services[]` set: a single ENS endpoint pointing
    ///      back at the agent's ENS name. Operators can override the URI later
    ///      via `setAgentURI` if they need richer endpoints (A2A, MCP, …).
    function _servicesJson(
        string memory ensName
    ) private pure returns (string memory) {
        return
            string.concat(
                '"services":[{"name":"ENS","endpoint":"',
                ensName,
                '","version":"v1"}]'
            );
    }

    /// @dev Single-entry `registrations[]` for the agent on its home chain.
    ///      Multi-chain agents would extend this list off-chain.
    function _registrationsJson(
        uint256 agentId,
        string memory agentRegistry
    ) private pure returns (string memory) {
        return
            string.concat(
                '"registrations":[{"agentId":',
                Strings.toString(agentId),
                ',"agentRegistry":"',
                agentRegistry,
                '"}]'
            );
    }
}
