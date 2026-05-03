SHELL := /bin/bash
-include .env
export

.DEFAULT_GOAL := help

.PHONY: build test fmt lint clean deploy-0g deploy-sepolia register-agent \
        redeploy-evaluator redeploy-agent-nft set-agent-metadata axl-setup \
        axl-start-a axl-start-b axl-stop axl-smoke axl-clean verify-0g \
        verify-sepolia merge-env help setup-ens set-resolver-url snapshot \
        test-gas demo-reset-inft demo-register-providers \
        gateway sdk-test sdk-typecheck \
        quickstart-install quickstart-setup quickstart-gateway \
        quickstart-provider quickstart-evaluator quickstart-client \
        quickstart-clean

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

# 0G Galileo natively supports EIP-1559 — the prior `--legacy
# --with-gas-price 5gwei` defensive defaults turned out to be a
# Foundry-side opinion, not a chain requirement. We rely on Foundry's
# default 1559 gas estimation now. If a specific RPC ever rejects
# 1559 (none observed at time of writing) override on the command line:
#   make deploy-0g ZG_FLAGS='--legacy --with-gas-price 5gwei'
ZG_FLAGS :=

deploy-0g:
	forge script script/Deploy0G.s.sol \
		--rpc-url $(ZG_RPC) \
		--private-key $(DEPLOYER_PRIVATE_KEY) \
		$(ZG_FLAGS) \
		--broadcast
	@echo ""
	@echo "Deployed addresses written to .env.deployed.0g"
	@echo "Run 'make merge-env' to merge them into .env."

# Redeploy ONLY the ACLEvaluator (e.g. after a constructor change or a
# wrong InferenceServing wiring). Other contracts are unchanged so their
# addresses stay valid. Writes .env.deployed.0g; merge with `make merge-env`.
redeploy-evaluator:
	forge script script/RedeployEvaluator.s.sol \
		--rpc-url $(ZG_RPC) \
		--private-key $(DEPLOYER_PRIVATE_KEY) \
		$(ZG_FLAGS) \
		--broadcast
	@echo ""
	@echo "ACLEvaluator address written to .env.deployed.0g"
	@echo "Run 'make merge-env' to merge it into .env, then re-run"
	@echo "register-providers / set-operator for the new contract."

# Redeploy ONLY the ACLAgentNFT contract (after the live-corpus refresh
# `update()` addition). Reuses the existing TrustedPartyVerifier; the
# INFTDeliveryHook does NOT need redeployment because it reads the NFT
# contract address per-job from setBudget optParams. Existing iNFTs on
# the old contract are abandoned. Writes .env.deployed.0g; merge with
# `make merge-env`, then re-run register-providers to mint fresh iNFTs.
redeploy-agent-nft:
	forge script script/RedeployAgentNFT.s.sol \
		--rpc-url $(ZG_RPC) \
		--private-key $(DEPLOYER_PRIVATE_KEY) \
		$(ZG_FLAGS) \
		--broadcast
	@echo ""
	@echo "ACLAgentNFT address written to .env.deployed.0g"
	@echo "Run 'make merge-env' to merge it into .env."

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
		--constructor-args $$(cast abi-encode "constructor(address,address)" $(EVALUATOR_OWNER) $$ZG_INFERENCE_SERVING)
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

# ----- Demo: kelp-postmortem example app -----

# Re-mint a fresh pair of provider iNFTs for the kelp-postmortem demo.
# Use this when Phase-2 (iNFT acquisition) was already exercised in a
# prior run — the buyer now owns the previous tokenIds, so BuyerFlow
# would short-circuit to SKIP. Drops the cached `.axl/*.token-id`
# files and re-runs `setup:providers`, which mints + encrypts a fresh
# corpus + advertises the new tokenIds in `agent-context`.
demo-reset-inft:
	@echo "Resetting kelp-postmortem iNFT cache + re-running provider setup..."
	@rm -f examples/kelp-postmortem/.axl/kelp-security.token-id \
	       examples/kelp-postmortem/.axl/kelp-generalist.token-id
	cd examples/kelp-postmortem && bun run setup:providers
	@echo ""
	@echo "Fresh iNFTs minted. Restart the coordinator (bun run dev) to"
	@echo "exercise both Flow-1 and Flow-2 in the next run."

# Programmatically register the kelp-postmortem provider agents (ENS,
# AXL peer, mint-or-reuse iNFT, encrypt seed corpus). Idempotent:
# safely re-runs; honours `.axl/*.token-id` cache. Use this on a
# fresh checkout before `bun run dev`.
demo-register-providers:
	cd examples/kelp-postmortem && bun run setup:providers

# One-shot: bring the comprehensive web demo all the way up.
#   - boots the CCIP-Read gateway in the background if not already on :3000
#   - registers kelp-security + kelp-generalist if their iNFTs aren't minted
#   - pins the Kelp post-mortem source to 0G Storage if KELP_SOURCE_ROOT is missing
#   - boots the coordinator + waits for /api/config
# When the script returns, http://127.0.0.1:8787 is browser-ready.
demo-up:
	@bash examples/kelp-postmortem/scripts/demo-up.sh

# Tear down everything `demo-up` started: coord (cascades SIGTERM to its
# 7 child procs — 3 AXL bridges + 4 agents) + gateway. Falls back to a
# pgrep sweep so stale pid files don't leak zombies. Verifies ports
# 3000 / 8787 / 9101–9103 are free at the end.
demo-down:
	@bash examples/kelp-postmortem/scripts/demo-down.sh

# ----- SDK workspace -----

sdk-typecheck:
	cd sdk && bun run typecheck

sdk-test:
	cd sdk && bun run test

# Boot the local CCIP-Read gateway. Reads keys + addresses from .env,
# listens on :3000 by default. Used by both examples to power
# `*.acl.eth` resolution + `searchAgents()` discovery.
gateway:
	cd sdk && bun run gateway:start

# ----- Quickstart (examples/quickstart) ---------------------------------------
#
# Minimal CLI demo: one client, one provider, one evaluator — each in
# its own terminal, each spawning its own Gensyn AXL bridge (separate
# AXL nodes, peer-to-peer over TLS) — exercises ENS + 0G Storage +
# 0G Compute + ERC-8183 + ENSIP-10 CCIP-Read end-to-end in ~150 LoC.
#
# Recommended layout (4 terminals):
#   T0:  make quickstart-gateway      (CCIP-Read gateway on :3000)
#   T1:  make quickstart-provider     (provider AXL bridge + agent)
#   T2:  make quickstart-evaluator    (0G Compute evaluator)
#   T3:  make quickstart-setup        (one-time on-chain registration)
#        make quickstart-client       (one buyer job, end-to-end)

# Install (workspace-aware) — usually a no-op since `bun install` from
# the sdk workspace already linked `examples/quickstart`.
quickstart-install:
	cd sdk && bun install

# One-time. Registers the provider on ACLIdentityRegistry, publishes
# its ACL metadata, and caches the AXL peer id under `.axl/`.
quickstart-setup:
	cd examples/quickstart && bun run setup

# T0 — local CCIP-Read gateway. Prefer this over a public testnet
# gateway so the indexer is in a known state for the demo.
quickstart-gateway: gateway

# T1 — provider agent + AXL bridge.
quickstart-provider:
	cd examples/quickstart && bun run provider

# T2 — 0G Compute evaluator. No AXL bridge needed — the evaluator
# only listens to the chain.
quickstart-evaluator:
	cd examples/quickstart && bun run evaluator

# T3 — fires one end-to-end commerce job and exits when settled.
quickstart-client:
	cd examples/quickstart && bun run client

# Wipe the cached AXL peer keys + agent id. Re-run `quickstart-setup`
# afterwards to rebuild them.
quickstart-clean:
	rm -f examples/quickstart/.axl/*.pem \
	      examples/quickstart/.axl/*.config.json \
	      examples/quickstart/.axl/*.agent-id

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
	@echo "  SDK workspace"
	@echo "    make sdk-typecheck      tsc --noEmit across the workspace"
	@echo "    make sdk-test           bun test across the workspace"
	@echo "    make gateway            Run the CCIP-Read gateway on :3000"
	@echo ""
	@echo "  Quickstart (examples/quickstart) — minimal CLI demo, 4 terminals"
	@echo "    make quickstart-install   Install (one-time)"
	@echo "    make quickstart-setup     One-time on-chain provider registration"
	@echo "    make quickstart-gateway   T0: local CCIP-Read gateway"
	@echo "    make quickstart-provider  T1: provider AXL bridge + agent"
	@echo "    make quickstart-evaluator T2: 0G Compute evaluator"
	@echo "    make quickstart-client    T3: run one buyer job end-to-end"
	@echo "    make quickstart-clean     Wipe cached AXL keys + agentId"
	@echo ""
	@echo "  Comprehensive demo (examples/kelp-postmortem) — web UI + Phase 2"
	@echo "    make demo-up                  Browser-ready in one command (gateway + setup + coord)"
	@echo "    make demo-down                Tear everything down + free ports"
	@echo "    make demo-register-providers  Register kelp providers + mint iNFTs"
	@echo "    make demo-reset-inft          Re-mint a fresh pair of provider iNFTs"
	@echo ""
	@echo "  Other"
	@echo "    make clean              Remove build artifacts"
	@echo "    make help               Show this message"
	@echo ""
