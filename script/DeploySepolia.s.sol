// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ACLOffchainResolver} from "../src/ens/ACLOffchainResolver.sol";

/// @title DeploySepolia
/// @notice Deploys the canonical CCIP-Read resolver on Sepolia.
/// @dev Run: forge script script/DeploySepolia.s.sol --rpc-url $SEPOLIA_RPC --broadcast
contract DeploySepolia is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        string memory gatewayUrl = vm.envString("GATEWAY_URL");
        address gatewaySigner = vm.envAddress("GATEWAY_SIGNER_ADDRESS");

        address[] memory signers = new address[](1);
        signers[0] = gatewaySigner;

        vm.startBroadcast();

        ACLOffchainResolver resolver = new ACLOffchainResolver(
            gatewayUrl,
            signers,
            deployer
        );
        console.log("ACLOffchainResolver:", address(resolver));

        vm.stopBroadcast();

        string memory envContent = string.concat(
            "\n# --- Deployed Sepolia Addresses (auto-generated) ---\n",
            "ACL_OFFCHAIN_RESOLVER=",
            vm.toString(address(resolver)),
            "\n"
        );
        vm.writeFile(".env.deployed.sepolia", envContent);
        console.log("Address written to .env.deployed.sepolia");
        console.log("--- Sepolia deployment complete ---");
    }
}
