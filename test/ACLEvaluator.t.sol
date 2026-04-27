// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgenticCommerce} from "../src/core/AgenticCommerce.sol";
import {ACLEvaluator} from "../src/core/ACLEvaluator.sol";
import {ACLTestUSDC} from "../src/token/ACLTestUSDC.sol";

contract ACLEvaluatorTest is Test {
    AgenticCommerce public commerce;
    ACLEvaluator public aclevaluator;
    ACLTestUSDC public token;

    address owner = makeAddr("owner");
    address client = makeAddr("client");
    address provider = makeAddr("provider");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");

    uint256 constant BUDGET = 500e6;

    function setUp() public {
        token = new ACLTestUSDC("tUSDC", "tUSDC", 6);
        commerce = new AgenticCommerce(address(token), treasury, owner);
        aclevaluator = new ACLEvaluator(owner);

        vm.prank(owner);
        aclevaluator.setOperator(operator, true);

        token.mint(client, 100_000e6);
        vm.prank(client);
        token.approve(address(commerce), type(uint256).max);
    }

    function test_settle_complete() public {
        uint256 jobId = _createSubmittedJob();
        bytes32 attestation = keccak256("attestation");

        vm.prank(operator);
        aclevaluator.settle(commerce, jobId, true, attestation, "");

        assertEq(
            uint256(commerce.getJob(jobId).status),
            uint256(AgenticCommerce.JobStatus.Completed)
        );
        assertEq(
            aclevaluator.attestationRoot(address(commerce), jobId),
            attestation
        );
        assertEq(token.balanceOf(provider), BUDGET);
    }

    function test_settle_reject() public {
        uint256 jobId = _createSubmittedJob();
        bytes32 attestation = keccak256("reject-attestation");

        uint256 clientBefore = token.balanceOf(client);
        vm.prank(operator);
        aclevaluator.settle(commerce, jobId, false, attestation, "");

        assertEq(
            uint256(commerce.getJob(jobId).status),
            uint256(AgenticCommerce.JobStatus.Rejected)
        );
        assertEq(token.balanceOf(client), clientBefore + BUDGET);
    }

    function test_settle_revertNotAuthorized() public {
        uint256 jobId = _createSubmittedJob();
        vm.prank(makeAddr("random"));
        vm.expectRevert(ACLEvaluator.NotAuthorized.selector);
        aclevaluator.settle(commerce, jobId, true, bytes32(0), "");
    }

    function test_setOperator() public {
        address newOp = makeAddr("newOp");
        vm.prank(owner);
        aclevaluator.setOperator(newOp, true);
        assertTrue(aclevaluator.authorizedOperators(newOp));

        vm.prank(owner);
        aclevaluator.setOperator(newOp, false);
        assertFalse(aclevaluator.authorizedOperators(newOp));
    }

    function _createSubmittedJob() internal returns (uint256) {
        uint256 expiry = block.timestamp + 1 hours;
        vm.prank(client);
        uint256 jobId = commerce.createJob(
            provider,
            address(aclevaluator),
            expiry,
            "evaluator test",
            address(0)
        );

        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        vm.prank(provider);
        commerce.submit(jobId, keccak256("work"), "");

        return jobId;
    }
}
