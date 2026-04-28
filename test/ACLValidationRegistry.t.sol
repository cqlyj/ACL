// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ACLIdentityRegistry} from "../src/registry/ACLIdentityRegistry.sol";
import {ACLValidationRegistry} from "../src/registry/ACLValidationRegistry.sol";

contract ACLValidationRegistryTest is Test {
    ACLIdentityRegistry public identity;
    ACLValidationRegistry public validation;

    address agentOwner = makeAddr("agentOwner");
    address validator = makeAddr("validator");
    uint256 agentId;

    function setUp() public {
        identity = new ACLIdentityRegistry();
        validation = new ACLValidationRegistry();
        validation.initialize(address(identity));
        vm.prank(agentOwner);
        agentId = identity.register();
    }

    function test_validationRequest_byOwner() public {
        bytes32 reqHash = keccak256("req-1");
        vm.prank(agentOwner);
        validation.validationRequest(
            validator,
            agentId,
            "0g://request",
            reqHash
        );

        bytes32[] memory list = validation.getAgentValidations(agentId);
        assertEq(list.length, 1);
        assertEq(list[0], reqHash);

        bytes32[] memory listV = validation.getValidatorRequests(validator);
        assertEq(listV.length, 1);
    }

    function test_validationRequest_revertNotOwner() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ACLValidationRegistry.NotOwnerOrOperator.selector);
        validation.validationRequest(
            validator,
            agentId,
            "0g://r",
            keccak256("x")
        );
    }

    function test_validationResponse_byValidator() public {
        bytes32 reqHash = keccak256("req-1");
        vm.prank(agentOwner);
        validation.validationRequest(
            validator,
            agentId,
            "0g://request",
            reqHash
        );

        vm.prank(validator);
        validation.validationResponse(
            reqHash,
            95,
            "0g://resp",
            keccak256("resp"),
            "tag"
        );

        (
            address va,
            uint256 aid,
            uint8 resp,
            bytes32 rh,
            string memory tag,

        ) = validation.getValidationStatus(reqHash);
        assertEq(va, validator);
        assertEq(aid, agentId);
        assertEq(resp, 95);
        assertEq(rh, keccak256("resp"));
        assertEq(keccak256(bytes(tag)), keccak256(bytes("tag")));
    }

    function test_validationResponse_revertNotAuthorised() public {
        bytes32 reqHash = keccak256("req-1");
        vm.prank(agentOwner);
        validation.validationRequest(validator, agentId, "0g://r", reqHash);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ACLValidationRegistry.NotAuthorizedValidator.selector);
        validation.validationResponse(
            reqHash,
            50,
            "0g://x",
            keccak256("x"),
            ""
        );
    }

    function test_validationRequest_emptyRequestURI_allowed() public {
        bytes32 reqHash = keccak256("req-empty");
        vm.prank(agentOwner);
        validation.validationRequest(validator, agentId, "", reqHash);

        bytes32[] memory list = validation.getAgentValidations(agentId);
        assertEq(list.length, 1);
        assertEq(list[0], reqHash);
    }

    function test_summary_average() public {
        bytes32 r1 = keccak256("r1");
        bytes32 r2 = keccak256("r2");
        vm.prank(agentOwner);
        validation.validationRequest(validator, agentId, "u1", r1);
        vm.prank(agentOwner);
        validation.validationRequest(validator, agentId, "u2", r2);

        vm.prank(validator);
        validation.validationResponse(r1, 80, "u1r", bytes32(0), "");
        vm.prank(validator);
        validation.validationResponse(r2, 60, "u2r", bytes32(0), "");

        address[] memory empty = new address[](0);
        (uint64 count, uint8 avg) = validation.getSummary(agentId, empty, "");
        assertEq(count, 2);
        assertEq(avg, 70);
    }
}
