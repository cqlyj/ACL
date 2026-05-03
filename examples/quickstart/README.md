# quickstart — minimal end-to-end ACL demo (~150 lines, CLI only)

Three autonomous agents — **client**, **provider**, **evaluator** — each in
its own process, each spawning its own [Gensyn AXL] node, exercising the
full ACL stack against the live 0G Galileo testnet:

- ENS (`quickstart-greeter.acl.eth`) for human-readable identity, resolved
  via ENSIP-10 wildcards over EIP-3668 CCIP-Read,
- AXL for end-to-end-encrypted, peer-to-peer agent negotiation
  (separate AXL nodes, no central message broker),
- 0G Storage for canonical TaskSpec / deliverable / attestation bundles,
- 0G Compute (`qwen-2.5-7b-instruct`, TeeML-verified) for evaluation,
- 0G Galileo + ERC-8183 for escrow, settlement, reputation.

Total job code (excluding boilerplate): **~30 lines per agent**. The full
SDK lives behind `@acl/agent`.

```
src/
├── config.ts              ← env, persona, brief, taskDomain, budget
├── lib/
│   ├── axl.ts             ← spawnLocalAxl(role): per-role AXL bridge
│   ├── log.ts             ← agent-event pretty printer
│   └── setup-log.ts       ← step()/ok()/tx() helpers for setup.ts
├── client.ts              ← ClientAgent.runJob(...)         ~30 LOC body
├── provider.ts            ← ProviderAgent listening on AXL  ~25 LOC body
├── evaluator.ts           ← EvaluatorAgent watching chain   ~25 LOC body
└── setup.ts               ← one-off ACLIdentityRegistry register + metadata
```

```
   ┌───────────────────────────────┐
   │  ACL CCIP-Read gateway        │
   │  *.acl.eth → ACLIdentityReg   │
   └─────────────┬─────────────────┘
                 │ HTTP (/agents + ENSIP-10 CCIP-Read);
                 │ provider is read off-chain via the indexer,
                 │ not over a direct HTTP link.
                 ▼
   ┌──────────────────┐   AXL TLS   ┌──────────────────┐   chain    ┌──────────────────┐
   │  Client agent    │◀───────────▶│  Provider agent  │◀──────────▶│ Evaluator agent  │
   │  (own AXL node)  │  PROPOSE/   │  (own AXL node)  │  ERC-8183  │  (0G Compute)    │
   └────────┬─────────┘  COUNTER/   └────────┬─────────┘            └────────┬─────────┘
            │            ACCEPT              │                               │
            └─────────── 0G Galileo: AgenticCommerce + ACLEvaluator ─────────┘
                          0G Storage: TaskSpec / deliverable / attestation
```

## Prerequisites

1. The repo root has working `.env` deployment addresses (run `make deploy-0g`
   - `make merge-env` once if you forked from scratch — the ACL contracts
     already live on Galileo at the addresses pinned in
     [`sdk/packages/core/src/addresses.ts`][addresses]).
2. The Gensyn AXL Go binary is built once:

   ```bash
   make axl-setup       # clones gensyn-ai/axl and runs `go build -o node ./cmd/node/`
   ```

3. Funded testnet accounts:
   - **client** EOA — needs A0GI for gas + tUSDC for escrow,
   - **provider** EOA — needs A0GI for the `submit(...)` tx,
   - **evaluator operator** EOA — needs ~3 A0GI on top of gas to fund
     the 0G Compute ledger. `EvaluatorAgent.start()` calls
     `evaluator.ensureFunded()`, which on first run mints a fresh
     ledger at the 3 OG `LedgerManager.MIN_ACCOUNT_BALANCE` floor and
     reserves 1 OG for the per-provider sub-account out of those
     funds. The operator must also be authorised on `ACLEvaluator`
     (already done by `make register-agent`, or pass
     `EVALUATOR_OWNER_PRIVATE_KEY` so `evaluator.ts` calls
     `ensureEvaluatorOperator` → `setOperator(operator, true)` once
     on first boot — note this happens in the evaluator process, not
     in `setup.ts`).

## Setup

```bash
cp .env.example .env
# Fill in the four private keys + your ZG_ROUTER_* credentials.
```

## Run (4 terminals)

> Each agent runs as a separate OS process and **spawns its own AXL `node`
> binary** — that's what gives the demo "communication across separate AXL
> nodes" rather than a single in-process channel.

```bash
# T0 — CCIP-Read gateway. Backfills MetadataSet events, then serves
# *.acl.eth resolution over EIP-3668 + the @acl/discovery search API.
make quickstart-gateway

# T1 — provider AXL bridge + agent (long-running)
make quickstart-provider

# T2 — 0G Compute evaluator (long-running)
make quickstart-evaluator

# T3 — one-off: register the provider on-chain, then run one buyer job
make quickstart-setup       # only needed once per ENS label
make quickstart-client
```

The client exits as soon as `JobCompleted` fires. Provider + evaluator stay
running so you can fire repeat jobs from T3.

## What you'll see in each terminal

- **T0 (gateway).** `MetadataSet` backfill, then `/healthz` and the
  per-resolution access log. The provider you registered shows up in
  `/agents` and is now resolvable as `quickstart-greeter.acl.eth`.
- **T1 (provider).** AXL peer id, then per-job: HELLO/PROPOSE/COUNTER/ACCEPT
  trace, 0G-Storage download of the TaskSpec, LLM deliverable draft,
  0G-Storage upload, and `submit()` tx hash.
- **T2 (evaluator).** Per `JobSubmitted`: 0G-Storage download, 0G-Compute
  call (`qwen-2.5-7b-instruct`), TEE signature verification, and
  `ACLEvaluator.settle(...)` tx hash.
- **T3 (client).** `discovery.search` → `discovery.match` → AXL negotiation
  → `createJob` / `setProvider` / `fund` → wait for `JobCompleted`. The
  final block prints the deliverable text (downloaded from 0G Storage) and
  every tx's chainscan link.

The provider is registered under a deliberately unique
`acl.task-domains` value (`quickstart-greeting` — see `src/config.ts`),
so on a fresh testnet the gateway typically returns **a single
candidate** on the first try. The gateway's filter is a
case-insensitive substring match (see
`sdk/packages/discovery/src/search.ts`), so any other agent already
registered under a domain that contains `quickstart-greeting` would
also be returned — pick a different `PROVIDER_ENS_LABEL` /
`TASK_DOMAINS` if you've registered the demo more than once. In the
common case there's no negotiation fallback dance, no LLM ranking
ambiguity, and no surprise budget rejections from agents registered
for a different vertical.

## What this example deliberately does **not** cover

- ERC-7857 iNFT (intelligent NFT) acquisition — the agentic equivalent of
  buying a model + corpus + persona as a transferable, encrypted asset.
- Capability-aware discovery (`acl.cap.inft-sale.*` / agent-context).
- Long-running provider operations (Op A: re-encrypt + upload + on-chain
  `update()` on every Flow-1 delivery).
- Auto-acquisition (Phase 2): the client agent autonomously deciding to
  _buy the seller_ after a satisfying Flow-1 transaction.

These all live in the comprehensive demo
[`examples/kelp-postmortem`](../kelp-postmortem/README.md), which exercises
both Flow-1 (commission) and Flow-2 (iNFT acquisition) end-to-end.

## SDK surface used

```ts
import {
  ClientAgent,
  ProviderAgent,
  EvaluatorAgent, // role agents
  createAgentRuntime, // viem + ethers kernel (used by setup.ts)
  createZGRouterBackend, // 0G Compute LLM backend
  spawnAxlBridge, // separate AXL node per process
  registerAclAgent, // ENS + ACL metadata write
  ensureEvaluatorOperator, // idempotent setOperator
  ACL_TESTNET, // pinned testnet addresses
} from "@acl/agent";
```

Full reference: [`sdk/README.md`](../../sdk/README.md).

[Gensyn AXL]: https://github.com/gensyn-ai/axl
[addresses]: ../../sdk/packages/core/src/addresses.ts
