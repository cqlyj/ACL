// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ACLIdentityRegistry} from "../src/registry/ACLIdentityRegistry.sol";
import {ACLReputationRegistry} from "../src/registry/ACLReputationRegistry.sol";

contract ACLReputationRegistryTest is Test {
    ACLIdentityRegistry public identity;
    ACLReputationRegistry public reputation;

    address agentOwner = makeAddr("agentOwner");
    address client = makeAddr("client");
    address client2 = makeAddr("client2");
    uint256 agentId;

    function setUp() public {
        identity = new ACLIdentityRegistry();
        reputation = new ACLReputationRegistry();
        reputation.initialize(address(identity));
        vm.prank(agentOwner);
        agentId = identity.register();
    }

    function test_giveFeedback() public {
        vm.prank(client);
        reputation.giveFeedback(
            agentId,
            100,
            2,
            "job-complete",
            "",
            "acl/erc-8183",
            "0g://ev1",
            bytes32(uint256(1))
        );

        assertEq(reputation.getLastIndex(agentId, client), 1);
        (int128 v, uint8 d, , , bool revoked) = reputation.readFeedback(
            agentId,
            client,
            1
        );
        assertEq(v, 100);
        assertEq(d, 2);
        assertFalse(revoked);
    }

    function test_giveFeedback_revertSubmitterIsOwner() public {
        vm.prank(agentOwner);
        vm.expectRevert(
            ACLReputationRegistry.SubmitterIsOwnerOrOperator.selector
        );
        reputation.giveFeedback(agentId, 100, 2, "ok", "", "", "", bytes32(0));
    }

    function test_giveFeedback_revertSubmitterIsOperator() public {
        address operator = makeAddr("operator");
        vm.prank(agentOwner);
        identity.setApprovalForAll(operator, true);

        vm.prank(operator);
        vm.expectRevert(
            ACLReputationRegistry.SubmitterIsOwnerOrOperator.selector
        );
        reputation.giveFeedback(agentId, 100, 2, "ok", "", "", "", bytes32(0));
    }

    function test_revokeFeedback() public {
        vm.prank(client);
        reputation.giveFeedback(agentId, 100, 2, "tag", "", "", "", bytes32(0));

        vm.prank(client);
        reputation.revokeFeedback(agentId, 1);

        (, , , , bool revoked) = reputation.readFeedback(agentId, client, 1);
        assertTrue(revoked);
    }

    function test_revokeFeedback_revertNotOwnerOfFeedback() public {
        vm.prank(client);
        reputation.giveFeedback(agentId, 100, 2, "tag", "", "", "", bytes32(0));

        vm.prank(client2);
        vm.expectRevert(ACLReputationRegistry.InvalidFeedbackIndex.selector);
        reputation.revokeFeedback(agentId, 1);
    }

    function test_summary_byTag() public {
        vm.prank(client);
        reputation.giveFeedback(agentId, 100, 2, "ok", "", "", "", bytes32(0));
        vm.prank(client);
        reputation.giveFeedback(agentId, 50, 2, "ok", "", "", "", bytes32(0));
        vm.prank(client2);
        reputation.giveFeedback(agentId, 200, 2, "ok", "", "", "", bytes32(0));

        address[] memory clients = new address[](2);
        clients[0] = client;
        clients[1] = client2;

        (uint64 count, int128 mean, uint8 dec) = reputation.getSummary(
            agentId,
            clients,
            "ok",
            ""
        );
        assertEq(count, 3);
        assertEq(dec, 2);
        assertEq(mean, int128((int256(100) + int256(50) + int256(200)) / 3));
    }

    function test_summary_excludesRevoked() public {
        vm.prank(client);
        reputation.giveFeedback(agentId, 100, 2, "ok", "", "", "", bytes32(0));
        vm.prank(client);
        reputation.giveFeedback(agentId, 50, 2, "ok", "", "", "", bytes32(0));
        vm.prank(client);
        reputation.revokeFeedback(agentId, 2);

        address[] memory clients = new address[](1);
        clients[0] = client;
        (uint64 count, int128 mean, ) = reputation.getSummary(
            agentId,
            clients,
            "",
            ""
        );
        assertEq(count, 1);
        assertEq(mean, 100);
    }

    function test_summary_decimalsNormalisation() public {
        vm.prank(client);
        reputation.giveFeedback(agentId, 5, 0, "ok", "", "", "", bytes32(0));
        vm.prank(client2);
        reputation.giveFeedback(agentId, 500, 2, "ok", "", "", "", bytes32(0));

        address[] memory clients = new address[](2);
        clients[0] = client;
        clients[1] = client2;
        (uint64 count, int128 mean, uint8 dec) = reputation.getSummary(
            agentId,
            clients,
            "",
            ""
        );
        assertEq(count, 2);
        assertEq(dec, 2);
        assertEq(mean, 500);
    }

    function test_clientList() public {
        vm.prank(client);
        reputation.giveFeedback(agentId, 1, 0, "", "", "", "", bytes32(0));
        vm.prank(client2);
        reputation.giveFeedback(agentId, 2, 0, "", "", "", "", bytes32(0));

        address[] memory clients = reputation.getClients(agentId);
        assertEq(clients.length, 2);
    }

    function test_appendResponse() public {
        vm.prank(client);
        reputation.giveFeedback(agentId, 1, 0, "", "", "", "", bytes32(0));

        address responder = makeAddr("responder");
        vm.prank(responder);
        reputation.appendResponse(
            agentId,
            client,
            1,
            "0g://reply",
            bytes32(uint256(2))
        );

        address[] memory responders = new address[](1);
        responders[0] = responder;
        assertEq(
            reputation.getResponseCount(agentId, client, 1, responders),
            1
        );
    }
}
