// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgenticCommerce} from "../src/core/AgenticCommerce.sol";
import {ACLEvaluator} from "../src/core/ACLEvaluator.sol";
import {ACLTestUSDC} from "../src/token/ACLTestUSDC.sol";
import {IInferenceServing} from "../src/interfaces/IInferenceServing.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @dev In-memory mock of 0G Compute's InferenceServing contract that just
///      returns a Service struct with a fixed teeSignerAddress. Lets us
///      test the on-chain TEE verification without forking Galileo.
contract MockInferenceServing is IInferenceServing {
    Service private _svc;

    function set(
        address provider,
        address teeSigner,
        bool acknowledged
    ) external {
        _svc = Service({
            provider: provider,
            serviceType: "inference",
            url: "https://example.org",
            inputPrice: 0,
            outputPrice: 0,
            updatedAt: block.timestamp,
            model: "qwen-2.5-7b-instruct",
            verifiability: "TEE",
            additionalInfo: "{}",
            teeSignerAddress: teeSigner,
            teeSignerAcknowledged: acknowledged
        });
    }

    function getService(address) external view returns (Service memory) {
        return _svc;
    }
}

contract ACLEvaluatorTest is Test {
    AgenticCommerce public commerce;
    ACLEvaluator public aclevaluator;
    ACLTestUSDC public token;
    MockInferenceServing public inferenceServing;

    address owner = makeAddr("owner");
    address client = makeAddr("client");
    address provider = makeAddr("provider");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address computeProvider = makeAddr("computeProvider");

    uint256 constant BUDGET = 500e6;

    /// @dev Deterministic TEE signer key. The corresponding address is
    ///      derived in setUp() and registered on the mock InferenceServing
    ///      so settle() can verify against it.
    uint256 constant TEE_PK = uint256(keccak256("acl.tests.tee.signer"));
    address teeSigner;

    function setUp() public {
        teeSigner = vm.addr(TEE_PK);

        token = new ACLTestUSDC("tUSDC", "tUSDC", 6);
        commerce = new AgenticCommerce(address(token), treasury, owner);
        inferenceServing = new MockInferenceServing();
        inferenceServing.set(computeProvider, teeSigner, true);
        aclevaluator = new ACLEvaluator(owner, inferenceServing);

        vm.prank(owner);
        aclevaluator.setOperator(operator, true);

        token.mint(client, 100_000e6);
        vm.prank(client);
        token.approve(address(commerce), type(uint256).max);
    }

    function test_settle_complete() public {
        uint256 jobId = _createSubmittedJob();
        bytes32 attestation = keccak256("attestation");

        bytes memory signedText = bytes("evidence-bundle/1");
        bytes memory sig = _sign(signedText, TEE_PK);

        vm.prank(operator);
        aclevaluator.settle(
            commerce,
            jobId,
            true,
            attestation,
            computeProvider,
            signedText,
            sig,
            ""
        );

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

        bytes memory signedText = bytes("evidence-bundle/2");
        bytes memory sig = _sign(signedText, TEE_PK);

        uint256 clientBefore = token.balanceOf(client);
        vm.prank(operator);
        aclevaluator.settle(
            commerce,
            jobId,
            false,
            attestation,
            computeProvider,
            signedText,
            sig,
            ""
        );

        assertEq(
            uint256(commerce.getJob(jobId).status),
            uint256(AgenticCommerce.JobStatus.Rejected)
        );
        assertEq(token.balanceOf(client), clientBefore + BUDGET);
    }

    function test_settle_revertNotAuthorized() public {
        uint256 jobId = _createSubmittedJob();
        bytes memory signedText = bytes("x");
        bytes memory sig = _sign(signedText, TEE_PK);
        vm.prank(makeAddr("random"));
        vm.expectRevert(ACLEvaluator.NotAuthorized.selector);
        aclevaluator.settle(
            commerce,
            jobId,
            true,
            bytes32(0),
            computeProvider,
            signedText,
            sig,
            ""
        );
    }

    function test_settle_revertOnTamperedSignature() public {
        uint256 jobId = _createSubmittedJob();
        bytes memory signedText = bytes("evidence-bundle/3");
        bytes memory sig = _sign(signedText, TEE_PK);
        // Mutate signedText so the recovered signer no longer matches.
        bytes memory tampered = bytes("evidence-bundle/3-tampered");
        vm.prank(operator);
        vm.expectRevert(ACLEvaluator.TeeSignatureMismatch.selector);
        aclevaluator.settle(
            commerce,
            jobId,
            true,
            bytes32(0),
            computeProvider,
            tampered,
            sig,
            ""
        );
    }

    function test_settle_revertOnUnacknowledgedSigner() public {
        // Re-set the mock so teeSignerAcknowledged = false.
        inferenceServing.set(computeProvider, teeSigner, false);
        uint256 jobId = _createSubmittedJob();
        bytes memory signedText = bytes("evidence-bundle/4");
        bytes memory sig = _sign(signedText, TEE_PK);
        vm.prank(operator);
        vm.expectRevert(ACLEvaluator.TeeSignerNotAcknowledged.selector);
        aclevaluator.settle(
            commerce,
            jobId,
            true,
            bytes32(0),
            computeProvider,
            signedText,
            sig,
            ""
        );
    }

    function test_settle_revertOnSignatureReplay() public {
        uint256 jobId1 = _createSubmittedJob();
        bytes memory signedText = bytes("evidence-bundle/5");
        bytes memory sig = _sign(signedText, TEE_PK);

        vm.prank(operator);
        aclevaluator.settle(
            commerce,
            jobId1,
            true,
            keccak256("a"),
            computeProvider,
            signedText,
            sig,
            ""
        );

        // Same signedText, different job → must revert.
        uint256 jobId2 = _createSubmittedJob();
        vm.prank(operator);
        vm.expectRevert(ACLEvaluator.TeeSignatureReplayed.selector);
        aclevaluator.settle(
            commerce,
            jobId2,
            true,
            keccak256("b"),
            computeProvider,
            signedText,
            sig,
            ""
        );
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

    /// @dev Sign `message` as the TEE: EIP-191 personal_sign with key `pk`.
    function _sign(
        bytes memory message,
        uint256 pk
    ) internal pure returns (bytes memory) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(message);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
