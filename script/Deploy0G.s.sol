// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ACLTestUSDC} from "../src/token/ACLTestUSDC.sol";
import {AgenticCommerce} from "../src/core/AgenticCommerce.sol";
import {ACLEvaluator} from "../src/core/ACLEvaluator.sol";
import {ACLIdentityRegistry} from "../src/registry/ACLIdentityRegistry.sol";
import {ACLReputationRegistry} from "../src/registry/ACLReputationRegistry.sol";
import {ACLValidationRegistry} from "../src/registry/ACLValidationRegistry.sol";
import {ReputationHook} from "../src/hooks/ReputationHook.sol";
import {INFTDeliveryHook} from "../src/hooks/INFTDeliveryHook.sol";
import {ACLAgentNFT} from "../src/inft/ACLAgentNFT.sol";
import {TrustedPartyVerifier} from "../src/inft/TrustedPartyVerifier.sol";

/// @title Deploy0G — deploys ACL contracts on 0G Galileo (chain id 16602).
/// @dev Run: forge script script/Deploy0G.s.sol --rpc-url $ZG_RPC --broadcast
///      Writes deployed addresses to .env.deployed.0g for the merge-env target.
contract Deploy0G is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address treasury = vm.envAddress("PLATFORM_TREASURY");
        address evaluatorOwner = vm.envAddress("EVALUATOR_OWNER");
        address oracleAddress = vm.envAddress("ORACLE_ADDRESS");

        vm.startBroadcast();

        ACLTestUSDC token = new ACLTestUSDC("ACL Test USDC", "tUSDC", 6);
        console.log("ACLTestUSDC:", address(token));

        AgenticCommerce commerce = new AgenticCommerce(
            address(token),
            treasury,
            deployer
        );
        console.log("AgenticCommerce:", address(commerce));

        ACLEvaluator evaluator = new ACLEvaluator(evaluatorOwner);
        console.log("ACLEvaluator:", address(evaluator));

        ACLIdentityRegistry identity = new ACLIdentityRegistry();
        console.log("ACLIdentityRegistry:", address(identity));

        ACLReputationRegistry reputation = new ACLReputationRegistry();
        reputation.initialize(address(identity));
        console.log("ACLReputationRegistry:", address(reputation));

        ACLValidationRegistry validation = new ACLValidationRegistry();
        validation.initialize(address(identity));
        console.log("ACLValidationRegistry:", address(validation));

        TrustedPartyVerifier verifierContract = new TrustedPartyVerifier(
            oracleAddress,
            1 hours,
            deployer
        );
        console.log("TrustedPartyVerifier:", address(verifierContract));

        ACLAgentNFT nft = new ACLAgentNFT(
            "ACL Agent iNFT",
            "ACL-iNFT",
            address(verifierContract),
            deployer
        );
        console.log("ACLAgentNFT:", address(nft));

        ReputationHook repHook = new ReputationHook(
            address(commerce),
            address(reputation)
        );
        console.log("ReputationHook:", address(repHook));

        INFTDeliveryHook inftHook = new INFTDeliveryHook(
            address(commerce),
            address(reputation)
        );
        console.log("INFTDeliveryHook:", address(inftHook));

        commerce.setHookWhitelist(address(repHook), true);
        commerce.setHookWhitelist(address(inftHook), true);
        console.log("Hooks whitelisted on AgenticCommerce");

        vm.stopBroadcast();

        string memory envContent = string.concat(
            "\n# --- Deployed 0G Galileo Addresses (auto-generated) ---\n",
            "ACL_TEST_USDC=",
            vm.toString(address(token)),
            "\n",
            "AGENTIC_COMMERCE=",
            vm.toString(address(commerce)),
            "\n",
            "ACL_EVALUATOR=",
            vm.toString(address(evaluator)),
            "\n",
            "ACL_IDENTITY_REGISTRY=",
            vm.toString(address(identity)),
            "\n",
            "ACL_REPUTATION_REGISTRY=",
            vm.toString(address(reputation)),
            "\n",
            "ACL_VALIDATION_REGISTRY=",
            vm.toString(address(validation)),
            "\n",
            "TRUSTED_PARTY_VERIFIER=",
            vm.toString(address(verifierContract)),
            "\n",
            "ACL_AGENT_NFT=",
            vm.toString(address(nft)),
            "\n",
            "REPUTATION_HOOK=",
            vm.toString(address(repHook)),
            "\n",
            "INFT_DELIVERY_HOOK=",
            vm.toString(address(inftHook)),
            "\n"
        );
        vm.writeFile(".env.deployed.0g", envContent);
        console.log("Addresses written to .env.deployed.0g");
        console.log("--- 0G Galileo deployment complete ---");
    }
}
