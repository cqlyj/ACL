// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ACLEvaluator} from "../src/core/ACLEvaluator.sol";
import {IInferenceServing} from "../src/interfaces/IInferenceServing.sol";

/// @title RedeployEvaluator — redeploys ONLY the ACLEvaluator contract on
///        0G Galileo, after a constructor / settle()-signature change.
/// @dev   The other contracts (AgenticCommerce, registries, hooks, NFT,
///        token) do not depend on ACLEvaluator's storage or constructor,
///        so they keep their current addresses. New jobs that pass the
///        new evaluator address as their `evaluator` route through the
///        upgraded contract; jobs already settled stay where they are.
contract RedeployEvaluator is Script {
    function run() external {
        address evaluatorOwner = vm.envAddress("EVALUATOR_OWNER");
        address inferenceServing = vm.envOr(
            "ZG_INFERENCE_SERVING",
            address(0xa79F4c8311FF93C06b8CfB403690cc987c93F91E)
        );

        vm.startBroadcast();
        ACLEvaluator evaluator = new ACLEvaluator(
            evaluatorOwner,
            IInferenceServing(inferenceServing)
        );
        console.log("ACLEvaluator (redeployed):", address(evaluator));
        console.log("InferenceServing wired:    ", inferenceServing);
        vm.stopBroadcast();

        string memory envContent = string.concat(
            "\n# --- Redeployed ACLEvaluator on Galileo ---\n",
            "ACL_EVALUATOR=",
            vm.toString(address(evaluator)),
            "\n",
            "ZG_INFERENCE_SERVING=",
            vm.toString(inferenceServing),
            "\n"
        );
        vm.writeFile(".env.deployed.0g", envContent);
        console.log("Address written to .env.deployed.0g");
    }
}
