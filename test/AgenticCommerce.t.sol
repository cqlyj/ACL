// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgenticCommerce} from "../src/core/AgenticCommerce.sol";
import {ACLTestUSDC} from "../src/token/ACLTestUSDC.sol";

contract AgenticCommerceTest is Test {
    AgenticCommerce public commerce;
    ACLTestUSDC public token;

    address owner = makeAddr("owner");
    address client = makeAddr("client");
    address provider = makeAddr("provider");
    address evaluator = makeAddr("evaluator");
    address treasury = makeAddr("treasury");

    uint256 constant BUDGET = 1000e6; // 1000 USDC
    uint256 constant EXPIRY_DELTA = 1 hours;

    function setUp() public {
        token = new ACLTestUSDC("ACL Test USDC", "tUSDC", 6);
        commerce = new AgenticCommerce(address(token), treasury, owner);

        token.mint(client, 100_000e6);
        vm.prank(client);
        token.approve(address(commerce), type(uint256).max);
    }

    // ───────── createJob ─────────

    function test_createJob() public {
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        vm.prank(client);
        uint256 jobId = commerce.createJob(provider, evaluator, expiry, "test job", address(0));

        assertEq(jobId, 1);
        AgenticCommerce.Job memory job = commerce.getJob(jobId);
        assertEq(job.client, client);
        assertEq(job.provider, provider);
        assertEq(job.evaluator, evaluator);
        assertEq(uint256(job.status), uint256(AgenticCommerce.JobStatus.Open));
    }

    function test_createJob_noProvider() public {
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        vm.prank(client);
        uint256 jobId = commerce.createJob(address(0), evaluator, expiry, "no provider yet", address(0));

        AgenticCommerce.Job memory job = commerce.getJob(jobId);
        assertEq(job.provider, address(0));
    }

    function test_createJob_revertZeroEvaluator() public {
        vm.prank(client);
        vm.expectRevert(AgenticCommerce.ZeroAddress.selector);
        commerce.createJob(provider, address(0), block.timestamp + EXPIRY_DELTA, "fail", address(0));
    }

    function test_createJob_revertExpiryTooShort() public {
        vm.prank(client);
        vm.expectRevert(AgenticCommerce.ExpiryTooShort.selector);
        commerce.createJob(provider, evaluator, block.timestamp + 1, "fail", address(0));
    }

    // ───────── setProvider ─────────

    function test_setProvider() public {
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        vm.prank(client);
        uint256 jobId = commerce.createJob(address(0), evaluator, expiry, "test", address(0));

        vm.prank(client);
        commerce.setProvider(jobId, provider, "");

        assertEq(commerce.getJob(jobId).provider, provider);
    }

    function test_setProvider_revertAlreadySet() public {
        uint256 jobId = _createFundableJob();
        vm.prank(client);
        vm.expectRevert(AgenticCommerce.ProviderAlreadySet.selector);
        commerce.setProvider(jobId, makeAddr("other"), "");
    }

    function test_setProvider_revertNotClient() public {
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        vm.prank(client);
        uint256 jobId = commerce.createJob(address(0), evaluator, expiry, "test", address(0));

        vm.prank(provider);
        vm.expectRevert(AgenticCommerce.Unauthorized.selector);
        commerce.setProvider(jobId, provider, "");
    }

    // ───────── setBudget ─────────

    function test_setBudget_byProvider() public {
        uint256 jobId = _createFundableJob();
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");

        assertEq(commerce.getJob(jobId).budget, BUDGET);
        assertTrue(commerce.jobHasBudget(jobId));
    }

    function test_setBudget_byClient() public {
        uint256 jobId = _createFundableJob();
        vm.prank(client);
        commerce.setBudget(jobId, BUDGET, "");

        assertEq(commerce.getJob(jobId).budget, BUDGET);
    }

    function test_setBudget_revertWrongStatus() public {
        uint256 jobId = _createAndFundJob();
        vm.prank(provider);
        vm.expectRevert(AgenticCommerce.WrongStatus.selector);
        commerce.setBudget(jobId, 2000e6, "");
    }

    // ───────── fund ─────────

    function test_fund() public {
        uint256 jobId = _createFundableJob();
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");

        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        AgenticCommerce.Job memory job = commerce.getJob(jobId);
        assertEq(uint256(job.status), uint256(AgenticCommerce.JobStatus.Funded));
        assertEq(token.balanceOf(address(commerce)), BUDGET);
    }

    function test_fund_revertBudgetMismatch() public {
        uint256 jobId = _createFundableJob();
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");

        vm.prank(client);
        vm.expectRevert(AgenticCommerce.BudgetMismatch.selector);
        commerce.fund(jobId, BUDGET + 1, "");
    }

    function test_fund_revertProviderNotSet() public {
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        vm.prank(client);
        uint256 jobId = commerce.createJob(address(0), evaluator, expiry, "test", address(0));

        vm.prank(client);
        commerce.setBudget(jobId, BUDGET, "");

        vm.prank(client);
        vm.expectRevert(AgenticCommerce.ProviderNotSet.selector);
        commerce.fund(jobId, BUDGET, "");
    }

    // ───────── submit ─────────

    function test_submit() public {
        uint256 jobId = _createAndFundJob();
        bytes32 deliverable = keccak256("deliverable-root");

        vm.prank(provider);
        commerce.submit(jobId, deliverable, "");

        assertEq(uint256(commerce.getJob(jobId).status), uint256(AgenticCommerce.JobStatus.Submitted));
    }

    function test_submit_revertNotProvider() public {
        uint256 jobId = _createAndFundJob();
        vm.prank(client);
        vm.expectRevert(AgenticCommerce.Unauthorized.selector);
        commerce.submit(jobId, bytes32(0), "");
    }

    // ───────── complete ─────────

    function test_complete() public {
        uint256 jobId = _createAndSubmitJob();
        bytes32 reason = keccak256("attestation-root");

        uint256 providerBefore = token.balanceOf(provider);
        vm.prank(evaluator);
        commerce.complete(jobId, reason, "");

        assertEq(uint256(commerce.getJob(jobId).status), uint256(AgenticCommerce.JobStatus.Completed));
        assertEq(token.balanceOf(provider), providerBefore + BUDGET);
    }

    function test_complete_withFees() public {
        vm.prank(owner);
        commerce.setPlatformFee(200, treasury); // 2%
        vm.prank(owner);
        commerce.setEvaluatorFee(100); // 1%

        uint256 jobId = _createAndSubmitJob();

        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");

        uint256 platformFee = (BUDGET * 200) / 10_000;
        uint256 evalFee = (BUDGET * 100) / 10_000;
        uint256 net = BUDGET - platformFee - evalFee;

        assertEq(token.balanceOf(treasury), platformFee);
        assertEq(token.balanceOf(evaluator), evalFee);
        assertEq(token.balanceOf(provider), net);
    }

    function test_complete_revertNotEvaluator() public {
        uint256 jobId = _createAndSubmitJob();
        vm.prank(client);
        vm.expectRevert(AgenticCommerce.Unauthorized.selector);
        commerce.complete(jobId, bytes32(0), "");
    }

    // ───────── reject ─────────

    function test_reject_byClientWhenOpen() public {
        uint256 jobId = _createFundableJob();

        vm.prank(client);
        commerce.reject(jobId, bytes32(0), "");

        assertEq(uint256(commerce.getJob(jobId).status), uint256(AgenticCommerce.JobStatus.Rejected));
    }

    function test_reject_byEvaluatorWhenFunded() public {
        uint256 jobId = _createAndFundJob();

        uint256 clientBefore = token.balanceOf(client);
        vm.prank(evaluator);
        commerce.reject(jobId, keccak256("reason"), "");

        assertEq(uint256(commerce.getJob(jobId).status), uint256(AgenticCommerce.JobStatus.Rejected));
        assertEq(token.balanceOf(client), clientBefore + BUDGET);
    }

    function test_reject_byEvaluatorWhenSubmitted() public {
        uint256 jobId = _createAndSubmitJob();

        uint256 clientBefore = token.balanceOf(client);
        vm.prank(evaluator);
        commerce.reject(jobId, bytes32(0), "");

        assertEq(uint256(commerce.getJob(jobId).status), uint256(AgenticCommerce.JobStatus.Rejected));
        assertEq(token.balanceOf(client), clientBefore + BUDGET);
    }

    function test_reject_revertProviderCannotReject() public {
        uint256 jobId = _createAndFundJob();
        vm.prank(provider);
        vm.expectRevert(AgenticCommerce.Unauthorized.selector);
        commerce.reject(jobId, bytes32(0), "");
    }

    // ───────── claimRefund (expiry) ─────────

    function test_claimRefund_funded() public {
        uint256 jobId = _createAndFundJob();

        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        uint256 clientBefore = token.balanceOf(client);
        commerce.claimRefund(jobId);

        assertEq(uint256(commerce.getJob(jobId).status), uint256(AgenticCommerce.JobStatus.Expired));
        assertEq(token.balanceOf(client), clientBefore + BUDGET);
    }

    function test_claimRefund_submitted() public {
        uint256 jobId = _createAndSubmitJob();

        vm.warp(block.timestamp + EXPIRY_DELTA + 1);

        uint256 clientBefore = token.balanceOf(client);
        commerce.claimRefund(jobId);

        assertEq(uint256(commerce.getJob(jobId).status), uint256(AgenticCommerce.JobStatus.Expired));
        assertEq(token.balanceOf(client), clientBefore + BUDGET);
    }

    function test_claimRefund_revertNotExpired() public {
        uint256 jobId = _createAndFundJob();
        vm.expectRevert(AgenticCommerce.NotExpired.selector);
        commerce.claimRefund(jobId);
    }

    // ───────── Admin ─────────

    function test_setPlatformFee() public {
        vm.prank(owner);
        commerce.setPlatformFee(500, treasury);
        assertEq(commerce.platformFeeBps(), 500);
    }

    function test_setPlatformFee_revertTooHigh() public {
        vm.prank(owner);
        commerce.setEvaluatorFee(500);
        vm.prank(owner);
        vm.expectRevert(AgenticCommerce.FeesTooHigh.selector);
        commerce.setPlatformFee(600, treasury);
    }

    // ───────── Full lifecycle ─────────

    function test_fullLifecycle_happy() public {
        // Create
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        vm.prank(client);
        uint256 jobId = commerce.createJob(provider, evaluator, expiry, "research paper summary", address(0));

        // Set budget (provider proposes)
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");

        // Fund (client locks)
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        // Submit (provider delivers)
        bytes32 deliverable = keccak256("0g-storage-root-hash");
        vm.prank(provider);
        commerce.submit(jobId, deliverable, "");

        // Complete (evaluator attests)
        bytes32 attestation = keccak256("attestation-bundle-root");
        vm.prank(evaluator);
        commerce.complete(jobId, attestation, "");

        AgenticCommerce.Job memory job = commerce.getJob(jobId);
        assertEq(uint256(job.status), uint256(AgenticCommerce.JobStatus.Completed));
        assertEq(token.balanceOf(provider), BUDGET);
        assertEq(token.balanceOf(address(commerce)), 0);
    }

    // ───────── Helpers ─────────

    function _createFundableJob() internal returns (uint256) {
        uint256 expiry = block.timestamp + EXPIRY_DELTA;
        vm.prank(client);
        return commerce.createJob(provider, evaluator, expiry, "test", address(0));
    }

    function _createAndFundJob() internal returns (uint256) {
        uint256 jobId = _createFundableJob();
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        return jobId;
    }

    function _createAndSubmitJob() internal returns (uint256) {
        uint256 jobId = _createAndFundJob();
        vm.prank(provider);
        commerce.submit(jobId, keccak256("deliverable"), "");
        return jobId;
    }
}
