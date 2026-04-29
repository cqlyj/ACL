SHELL := /bin/bash
include .env
export

.PHONY: build test fmt lint clean deploy-0g deploy-sepolia register-agent \
        set-agent-metadata axl-setup axl-start-a axl-start-b axl-stop \
        axl-smoke axl-clean verify-0g verify-sepolia merge-env help \
        setup-ens set-resolver-url snapshot test-gas

# ----- Build & Test -----

build:
	forge build

test:
	forge test -v

test-gas:
	forge test --gas-report

fmt:
	forge fmt

lint:
	forge lint

snapshot:
	forge snapshot

clean:
	forge clean
	rm -f .env.deployed.0g .env.deployed.sepolia

# ----- Deploy: 0G Galileo -----

# 0G Galileo currently rejects tx with priority fee < 2 gwei. Force legacy
# pricing + a fixed gas price so the deployer doesn't need to remember either.
ZG_GAS_PRICE := 5gwei
ZG_FLAGS := --legacy --with-gas-price $(ZG_GAS_PRICE)

deploy-0g:
	forge script script/Deploy0G.s.sol \
		--rpc-url $(ZG_RPC) \
		--private-key $(DEPLOYER_PRIVATE_KEY) \
		$(ZG_FLAGS) \
		--broadcast
	@echo ""
	@echo "Deployed addresses written to .env.deployed.0g"
	@echo "Run 'make merge-env' to merge them into .env."

ZG_VERIFIER_URL := https://chainscan-galileo.0g.ai/open/api
ZG_VERIFY := forge verify-contract --chain-id 16602 --num-of-optimizations 200 \
	--verifier custom --verifier-api-key "placeholder" --verifier-url $(ZG_VERIFIER_URL) \
	--compiler-version 0.8.28

verify-0g:
	@echo "Verifying contracts on 0G Galileo..."
	@source .env.deployed.0g && $(ZG_VERIFY) \
		$$ACL_TEST_USDC src/token/ACLTestUSDC.sol:ACLTestUSDC \
		--constructor-args $$(cast abi-encode "constructor(string,string,uint8)" "ACL Test USDC" "tUSDC" 6)
	@source .env.deployed.0g && $(ZG_VERIFY) \
		$$AGENTIC_COMMERCE src/core/AgenticCommerce.sol:AgenticCommerce \
		--constructor-args $$(cast abi-encode "constructor(address,address,address)" $$ACL_TEST_USDC $(PLATFORM_TREASURY) $(DEPLOYER_ADDRESS))
	@source .env.deployed.0g && $(ZG_VERIFY) \
		$$ACL_EVALUATOR src/core/ACLEvaluator.sol:ACLEvaluator \
		--constructor-args $$(cast abi-encode "constructor(address)" $(EVALUATOR_OWNER))
	@source .env.deployed.0g && $(ZG_VERIFY) \
		$$ACL_IDENTITY_REGISTRY src/registry/ACLIdentityRegistry.sol:ACLIdentityRegistry
	@source .env.deployed.0g && $(ZG_VERIFY) \
		$$ACL_REPUTATION_REGISTRY src/registry/ACLReputationRegistry.sol:ACLReputationRegistry
	@source .env.deployed.0g && $(ZG_VERIFY) \
		$$ACL_VALIDATION_REGISTRY src/registry/ACLValidationRegistry.sol:ACLValidationRegistry
	@source .env.deployed.0g && $(ZG_VERIFY) \
		$$TRUSTED_PARTY_VERIFIER src/inft/TrustedPartyVerifier.sol:TrustedPartyVerifier \
		--constructor-args $$(cast abi-encode "constructor(address,uint256,address)" $(ORACLE_ADDRESS) 3600 $(DEPLOYER_ADDRESS))
	@source .env.deployed.0g && $(ZG_VERIFY) \
		$$ACL_AGENT_NFT src/inft/ACLAgentNFT.sol:ACLAgentNFT \
		--constructor-args $$(cast abi-encode "constructor(string,string,address,address)" "ACL Agent iNFT" "ACL-iNFT" $$TRUSTED_PARTY_VERIFIER $(DEPLOYER_ADDRESS))
	@source .env.deployed.0g && $(ZG_VERIFY) \
		$$REPUTATION_HOOK src/hooks/ReputationHook.sol:ReputationHook \
		--constructor-args $$(cast abi-encode "constructor(address,address)" $$AGENTIC_COMMERCE $$ACL_REPUTATION_REGISTRY)
	@source .env.deployed.0g && $(ZG_VERIFY) \
		$$INFT_DELIVERY_HOOK src/hooks/INFTDeliveryHook.sol:INFTDeliveryHook \
		--constructor-args $$(cast abi-encode "constructor(address,address)" $$AGENTIC_COMMERCE $$ACL_REPUTATION_REGISTRY)

# ----- Deploy: Sepolia -----

deploy-sepolia:
	forge script script/DeploySepolia.s.sol \
		--rpc-url $(SEPOLIA_RPC) \
		--private-key $(DEPLOYER_PRIVATE_KEY) \
		--broadcast
	@echo ""
	@echo "Deployed addresses written to .env.deployed.sepolia"
	@echo "Run 'make merge-env' to merge them into .env."

verify-sepolia:
	@echo "Verifying contracts on Sepolia..."
	@source .env.deployed.sepolia && \
	forge verify-contract $$ACL_OFFCHAIN_RESOLVER src/ens/ACLOffchainResolver.sol:ACLOffchainResolver \
		--rpc-url $(SEPOLIA_RPC) --watch \
		--etherscan-api-key $(ETHERSCAN_API_KEY) \
		--constructor-args $$(cast abi-encode "constructor(string,address[],address)" "$(GATEWAY_URL)" "[$(GATEWAY_SIGNER_ADDRESS)]" $(DEPLOYER_ADDRESS))

# ----- Post-deploy -----

register-agent:
	forge script script/RegisterAgent.s.sol \
		--rpc-url $(ZG_RPC) \
		--private-key $(DEPLOYER_PRIVATE_KEY) \
		$(ZG_FLAGS) \
		--broadcast

# Idempotent: rewrites ACL metadata + tokenURI for an existing agent.
# Useful after the AXL peer key changes or when migrating metadata key names.
set-agent-metadata:
	forge script script/SetAgentMetadata.s.sol \
		--rpc-url $(ZG_RPC) \
		--private-key $(DEPLOYER_PRIVATE_KEY) \
		$(ZG_FLAGS) \
		--broadcast

setup-ens:
	forge script script/SetupENS.s.sol \
		--rpc-url $(SEPOLIA_RPC) \
		--private-key $(ENS_OWNER_PRIVATE_KEY) \
		--broadcast

# Re-point the on-chain ACLOffchainResolver at a new gateway URL (e.g. ngrok).
# Usage: make set-resolver-url URL='https://<host>/{sender}/{data}.json'
set-resolver-url:
	@if [ -z "$(URL)" ]; then \
		echo "Usage: make set-resolver-url URL='https://<host>/{sender}/{data}.json'"; \
		exit 1; \
	fi
	cast send $(ACL_OFFCHAIN_RESOLVER) "setUrl(string)" "$(URL)" \
		--rpc-url $(SEPOLIA_RPC) \
		--private-key $(DEPLOYER_PRIVATE_KEY)
	@echo "ACLOffchainResolver.url -> $(URL)"

# ----- AXL (Agent eXchange Layer) -----

axl-setup:
	$(MAKE) -C axl setup

axl-start-a:
	$(MAKE) -C axl start-a

axl-start-b:
	$(MAKE) -C axl start-b

axl-stop:
	$(MAKE) -C axl stop

axl-smoke:
	$(MAKE) -C axl smoke-test

axl-clean:
	$(MAKE) -C axl clean

# ----- Merge deployed addresses into .env -----

merge-env:
	@echo "Merging deployed addresses into .env..."
	@if [ -f .env.deployed.0g ]; then \
		while IFS='=' read -r key value; do \
			key=$$(echo "$$key" | xargs); \
			[ -z "$$key" ] && continue; \
			[[ "$$key" == \#* ]] && continue; \
			[ -z "$$value" ] && continue; \
			if grep -q "^$$key=" .env 2>/dev/null; then \
				sed -i "s|^$$key=.*|$$key=$$value|" .env; \
				echo "  Updated $$key"; \
			else \
				echo "$$key=$$value" >> .env; \
				echo "  Added $$key"; \
			fi; \
		done < .env.deployed.0g; \
		echo "0G addresses merged."; \
	else \
		echo "No .env.deployed.0g found. Run 'make deploy-0g' first."; \
	fi
	@if [ -f .env.deployed.sepolia ]; then \
		while IFS='=' read -r key value; do \
			key=$$(echo "$$key" | xargs); \
			[ -z "$$key" ] && continue; \
			[[ "$$key" == \#* ]] && continue; \
			[ -z "$$value" ] && continue; \
			if grep -q "^$$key=" .env 2>/dev/null; then \
				sed -i "s|^$$key=.*|$$key=$$value|" .env; \
				echo "  Updated $$key"; \
			else \
				echo "$$key=$$value" >> .env; \
				echo "  Added $$key"; \
			fi; \
		done < .env.deployed.sepolia; \
		echo "Sepolia addresses merged."; \
	else \
		echo "No .env.deployed.sepolia found. Run 'make deploy-sepolia' first."; \
	fi
	@echo "Done. Check .env for updated values."

# ----- Help -----

help:
	@echo ""
	@echo "ACL — Agentic Commerce Verification Layer"
	@echo "=========================================="
	@echo ""
	@echo "  Build & Test"
	@echo "    make build              Build all contracts"
	@echo "    make test               Run all Forge tests"
	@echo "    make test-gas           Run tests with gas report"
	@echo "    make fmt                Format Solidity code"
	@echo "    make lint               Lint Solidity code"
	@echo "    make snapshot           Update gas snapshot"
	@echo ""
	@echo "  Deploy"
	@echo "    make deploy-0g          Deploy to 0G Galileo (writes .env.deployed.0g)"
	@echo "    make deploy-sepolia     Deploy resolver to Sepolia (writes .env.deployed.sepolia)"
	@echo "    make register-agent     Register demo agent + mint test tokens"
	@echo "    make set-agent-metadata Rewrite ACL metadata + agentURI for existing agent"
	@echo "    make setup-ens          Point acl.eth to ACLOffchainResolver on Sepolia"
	@echo "    make set-resolver-url URL=...  Re-point ACLOffchainResolver at a new gateway URL"
	@echo ""
	@echo "  Verify & Merge"
	@echo "    make verify-0g          Verify 0G contracts on the explorer"
	@echo "    make verify-sepolia     Verify Sepolia contracts on Etherscan"
	@echo "    make merge-env          Merge deployed addresses into .env"
	@echo ""
	@echo "  AXL"
	@echo "    make axl-setup          Clone, build binary, generate keys"
	@echo "    make axl-start-a        Start AXL node A (client)"
	@echo "    make axl-start-b        Start AXL node B (provider)"
	@echo "    make axl-stop           Stop all AXL nodes"
	@echo "    make axl-smoke          Run AXL smoke test"
	@echo ""
	@echo "  Other"
	@echo "    make clean              Remove build artifacts"
	@echo "    make help               Show this message"
	@echo ""
