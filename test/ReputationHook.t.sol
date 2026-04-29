// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgenticCommerce} from "../src/core/AgenticCommerce.sol";
import {ReputationHook} from "../src/hooks/ReputationHook.sol";
import {ACLIdentityRegistry} from "../src/registry/ACLIdentityRegistry.sol";
import {ACLReputationRegistry} from "../src/registry/ACLReputationRegistry.sol";
import {ACLTestUSDC} from "../src/token/ACLTestUSDC.sol";
import {IACPHook} from "../src/interfaces/IACPHook.sol";

contract ReputationHookTest is Test {
    AgenticCommerce public commerce;
    ReputationHook public hook;
    ACLIdentityRegistry public identity;
    ACLReputationRegistry public reputation;
    ACLTestUSDC public token;

    address owner = makeAddr("owner");
    address client = makeAddr("client");
    address provider = makeAddr("provider");
    address evaluator = makeAddr("evaluator");
    address treasury = makeAddr("treasury");

    uint256 constant BUDGET = 1000e6;
    uint256 providerAgentId;

    function setUp() public {
        token = new ACLTestUSDC("tUSDC", "tUSDC", 6);
        commerce = new AgenticCommerce(address(token), treasury, owner);
        identity = new ACLIdentityRegistry();
        reputation = new ACLReputationRegistry();
        reputation.initialize(address(identity));
        hook = new ReputationHook(address(commerce), address(reputation));

        vm.prank(owner);
        commerce.setHookWhitelist(address(hook), true);

        vm.prank(provider);
        providerAgentId = identity.register("0g://provider/agent.json");

        token.mint(client, 100_000e6);
        vm.prank(client);
        token.approve(address(commerce), type(uint256).max);
    }

    function test_complete_writesPositiveFeedback() public {
        uint256 jobId = _createSubmittedJob();

        vm.prank(evaluator);
        commerce.complete(jobId, keccak256("attestation"), "");

        address[] memory clients = new address[](1);
        clients[0] = address(hook);
        (uint64 count, int128 mean, ) = reputation.getSummary(
            providerAgentId,
            clients,
            "job-complete",
            ""
        );
        assertEq(count, 1);
        assertEq(mean, 100);
    }

    function test_reject_writesNegativeFeedback() public {
        uint256 jobId = _createSubmittedJob();

        vm.prank(evaluator);
        commerce.reject(jobId, keccak256("reason"), "");

        address[] memory clients = new address[](1);
        clients[0] = address(hook);
        (uint64 count, int128 mean, ) = reputation.getSummary(
            providerAgentId,
            clients,
            "job-reject",
            ""
        );
        assertEq(count, 1);
        assertEq(mean, -100);
    }

    function test_supportsInterface() public view {
        assertTrue(hook.supportsInterface(type(IACPHook).interfaceId));
        assertTrue(hook.supportsInterface(0x01ffc9a7));
    }

    function _createSubmittedJob() internal returns (uint256) {
        uint256 expiry = block.timestamp + 1 hours;
        vm.prank(client);
        uint256 jobId = commerce.createJob(
            address(0),
            evaluator,
            expiry,
            "hook test",
            address(hook)
        );

        vm.prank(client);
        commerce.setProvider(jobId, provider, abi.encode(providerAgentId));

        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        vm.prank(provider);
        commerce.submit(jobId, keccak256("work"), "");

        return jobId;
    }
}
