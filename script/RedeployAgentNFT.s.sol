// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ACLAgentNFT} from "../src/inft/ACLAgentNFT.sol";

contract RedeployAgentNFT is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address verifier = vm.envAddress("TRUSTED_PARTY_VERIFIER");

        vm.startBroadcast();
        ACLAgentNFT nft = new ACLAgentNFT(
            "ACL Agent iNFT",
            "ACL-iNFT",
            verifier,
            deployer
        );
        console.log("ACLAgentNFT (redeployed):", address(nft));
        console.log("Bound to TrustedPartyVerifier:", verifier);
        vm.stopBroadcast();

        string memory envContent = string.concat(
            "\n# --- Redeployed ACLAgentNFT on Galileo ---\n",
            "ACL_AGENT_NFT=",
            vm.toString(address(nft)),
            "\n"
        );
        vm.writeFile(".env.deployed.0g", envContent);
        console.log("Address written to .env.deployed.0g");
    }
}
