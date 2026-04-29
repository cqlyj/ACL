// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {AgentMetadataBuilder} from "../script/lib/AgentMetadataBuilder.sol";

/// @notice Pins the on-chain agent NFT URI to ERC-8004 v2's normative
///         "agent registration file" shape. If the encoded JSON drifts (extra
///         field, reordered keys, missing top-level entry) this test fails.
contract AgentMetadataBuilderTest is Test {
    function test_buildAgentURI_matchesErc8004v2RegistrationFile() public pure {
        AgentMetadataBuilder.AgentURIInput memory input = AgentMetadataBuilder
            .AgentURIInput({
                ensName: "researcher.acl.eth",
                description: "ACL Agent #1 (ERC-8004 v2 + ENSIP-25) on chain 16602",
                image: "",
                agentId: 1,
                agentRegistry: "eip155:16602:0xad0fa772406913f5d337c817ea2badb452c0dc2a"
            });

        // Hand-built expected payload mirrors EIP-8004 "Agent URI and Agent
        // Registration File" exactly. Keep this literal in sync with
        // AgentMetadataBuilder.buildAgentURI.
        string memory expectedJson = string.concat(
            '{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1",',
            '"name":"researcher.acl.eth",',
            '"description":"ACL Agent #1 (ERC-8004 v2 + ENSIP-25) on chain 16602",',
            '"image":"",',
            '"services":[{"name":"ENS","endpoint":"researcher.acl.eth","version":"v1"}],',
            '"x402Support":false,"active":true,',
            '"registrations":[{"agentId":1,"agentRegistry":"eip155:16602:0xad0fa772406913f5d337c817ea2badb452c0dc2a"}],',
            '"supportedTrust":["reputation"]}'
        );
        string memory expected = string.concat(
            "data:application/json;base64,",
            Base64.encode(bytes(expectedJson))
        );

        assertEq(AgentMetadataBuilder.buildAgentURI(input), expected);
    }
}
