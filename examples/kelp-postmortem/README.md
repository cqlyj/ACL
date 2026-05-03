# `@acl/example-kelp-postmortem`

End-to-end demo of the agent-shaped ACL SDK. A client agent commissions
a post-mortem of the April 2026 Kelp DAO bridge exploit. Two provider
agents (a security specialist and a generalist) compete on AXL, and an
in-process 0G Compute evaluator settles the job on chain with a
TEE-attested verdict.

> Looking for the **smallest** possible end-to-end demo? See
> [`examples/quickstart`](../quickstart) — three CLI processes,
> separate AXL nodes, ~150 lines, Phase-1 commission only.
> This example adds capability-aware discovery, COUNTER-offer
> negotiation, ERC-7857 iNFT acquisition (Phase 2), and a live
> coordinator web UI.

```
+----------------+        +----------------------+        +-------------------+
| ClientAgent    |  AXL   | ProviderAgent (sec)  |        | EvaluatorAgent    |
|  qwen-2.5-7b   |<------>|  qwen-2.5-7b         |        |  0G Compute       |
|  (router)      |        +----------------------+        |  Direct (TEE)     |
|                |  AXL   | ProviderAgent (gen)  |        |                   |
|                |<------>|  qwen-2.5-7b         |        |                   |
+----------------+        +----------------------+        +-------------------+
        \                                                            /
         \________________ 0G Galileo (ACL contracts) _______________/
```

Everything runs locally on Galileo testnet. The coordinator HTTP server
spawns:

- 3 AXL `node` bridges (one per agent that talks AXL)
- 1 `ClientAgent` process
- 2 `ProviderAgent` processes (security + generalist)
- 1 `EvaluatorAgent` process

…and exposes a simple web page that streams agent events with clickable
explorer links so you can verify each on-chain step.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2
- The AXL `node` binary built from
  [gensyn-ai/axl](https://github.com/gensyn-ai/axl). The simplest path
  is `make axl-setup` from the repo root — that runs `go build -o node
./cmd/node/` and drops the binary at `axl/node`, which the bundled
  `.env.example` points `AXL_BIN` at via `../../axl/node`. Override
  with an absolute path (recommended on CI) or symlink the binary
  next to this README and set `AXL_BIN=./node`.
- `openssl` on `$PATH` (used to mint per-agent ed25519 keys for AXL).
- 0G Compute Router API key (`ZG_ROUTER_API_KEY`) — sign up at
  https://build.0g.ai/.
- Galileo testnet ETH + tUSDC funded into each agent EOA. The contract
  deployment ships a `tUSDC` mint helper; the easiest path is to mint a
  large ledger to the client and the two provider EOAs at the same time
  the contracts are deployed.

## One-time setup

```bash
# Workspace-aware install: run from the SDK root so Bun resolves
# @acl/* via the workspace before resolving any registry copies.
cd sdk
bun install

cd ../examples/kelp-postmortem
cp .env.example .env   # fill in private keys + ZG_ROUTER_API_KEY

# Drop the AXL `node` binary alongside this README (or set AXL_BIN to
# the absolute path). The SDK default is `./node` to dodge the
# collision with the Node.js executable on operator $PATH layouts —
# the AXL Go binary built from `go build -o node ./cmd/node/` is
# literally named `node`.

# Mint each provider in ACLIdentityRegistry and write the canonical
# acl.* metadata. Boots an AXL bridge per provider just long enough to
# read the public peer id, then tears it down. The peer key is kept on
# disk so subsequent demo runs reuse the same peer id.
bun run setup:providers

# Upload the Kelp DAO post-mortem article to 0G Storage. Writes the
# resulting root hash atomically into .env (replaces an existing
# `KELP_SOURCE_ROOT=` line in place, otherwise appends one) so the next
# `bun run dev` picks it up without any further shell glue.
bun run setup:source
```

## Run

```bash
bun run dev
```

Open <http://127.0.0.1:8787>:

1. Click **Start agents**. The coordinator spawns the three AXL bridges,
   waits for `/topology` to come back on each, then boots the four
   agent processes.
2. Click **Run job**. The client agent picks a `taskDomain` via the
   LLM, queries the gateway for matching providers, ranks them with the
   LLM, ENS-resolves the winner, negotiates over AXL (one-counter
   policy), uploads the agreed `TaskSpec` to 0G Storage, and fires
   `createJob → setProvider → setBudget → fund`. The chosen provider
   produces the deliverable via the LLM, uploads it, and submits. The
   evaluator picks up `JobSubmitted`, runs 0G Compute Direct,
   builds the attestation bundle, and settles via
   `ACLEvaluator.settle()` with the TEE signature for on-chain replay-
   protected verification.

Every step surfaces on the timeline with a clickable Galileo /
0G Storage / ENS link.

## Phase 2 (iNFT Commerce)

Phase 2 fires automatically after Phase 1 settles. There is **no**
buy / acquire / confirm UI button — the only human-clickable button
in the app is **Run Job**.

The chained narrative the timeline tells:

1. **Phase 1**: client picks a brief, picks a provider, gets a
   deliverable, evaluator settles it on chain.
2. **Phase 2 (autonomous)**: a `BuyerFlow` watches the client's event
   bus for `job.settled.client-side` with `approved=true`. It resolves
   the winning provider's `agent-context` (ENSIP-26), confirms the
   provider's `inft-sale` capability, then asks the LLM whether to
   ACQUIRE or SKIP given (score, capabilities, min-price, original
   brief). If ACQUIRE: it builds ERC-7857 transfer-validity proofs
   (read-then-sign with retry on `OldDataHashMismatch`), runs a
   second `client.runJob({ ..., selfComplete: true, hook:
inftDeliveryHook(...) })`, and the iNFT lands atomically with the
   buyer. Post-transfer the flow calls `INftClient.update(...)` to
   repoint `encryptedStorageURI` at the buyer-sealed ciphertext, and
   surfaces the recovered persona / model id / `axlPeer` on
   `phase2.completed` so the UI can render the acquired bundle inline.

### Demo oracle setup

Phase 2 needs a single EOA that can sign `OwnershipProof`s on behalf
of `TrustedPartyVerifier` — the "demo oracle". Two env vars:

```bash
DEMO_ORACLE_PRIVATE_KEY=0x...      # the EOA the BuyerFlow signs with
```

The same address MUST be authorised on the deployed
`TrustedPartyVerifier` (`authorizedOracle`). To rotate without a
redeploy:

```bash
cast send "$TRUSTED_PARTY_VERIFIER" 'setOracle(address)' "$DEMO_ORACLE_ADDRESS"
```

`script/RedeployEvaluator.s.sol` only redeploys `ACLEvaluator` and
is **not** the right tool for swapping the oracle. A full re-deploy
of `TrustedPartyVerifier` itself is only needed when the verifier
contract changes.

When `DEMO_ORACLE_PRIVATE_KEY` is missing the client process emits
`{ "type": "phase2-disabled", "reason": "DEMO_ORACLE_PRIVATE_KEY missing" }`
and continues running Phase 1 normally.

### iNFT lifecycle

Each provider gets an `ACLAgentNFT` minted under its own EOA in
`scripts/register-providers.ts` (`bun run setup:providers`). The
seed `IntelligentData` carries a small JSON envelope with persona +
model id + AXL peer address. After every Phase-1 delivery, the provider runs **Op A** on
its own event bus: `INftClient.update(...)` refreshes the on-chain
`dataHash` + `encryptedStorageURI` so the iNFT is always current
with the latest deliverable. The buyer flow tolerates an Op A landing
mid-flight via the `OldDataHashMismatch` retry.

## Demo brief

The web UI ships a fixed brief that's tuned to the testnet
`qwen-2.5-7b-instruct` model:

> Write a 600-word post-mortem of the April 2026 Kelp DAO bridge exploit.
> The deliverable must mention: 116,500 rsETH drained, $292 million stolen,
> more than 20 chains affected, the LayerZero cross-chain message bypass,
> and the protocols (Aave, SparkLend, Fluid, Lido, Ethena) that paused or
> froze in response.

The acceptance criteria the LLM authors are checked verbatim by the
evaluator's strict-substring rubric, so a deliverable that drops one of
the named numbers will be rejected.

## Layout

```
examples/kelp-postmortem
├── package.json
├── tsconfig.json
├── README.md
├── .env.example
├── scripts/
│   ├── register-providers.ts   # Galileo: mint agentIds + metadata
│   └── upload-source.ts        # 0G Storage: pin source article
└── src/
    ├── server.ts               # coordinator (Hono, SSE, child processes)
    ├── config.ts               # env + workspace config
    ├── source.ts               # Kelp DAO article (verbatim)
    ├── event-forwarder.ts      # child → coordinator event pipe
    ├── agents/
    │   ├── client-process.ts   # ClientAgent + BuyerFlow attach
    │   ├── provider-process.ts # ProviderAgent + iNFT produceDeliverable + Op A
    │   └── evaluator-process.ts
    ├── inft/                   # Phase-2 (iNFT Commerce) glue
    │   └── buyer-flow.ts       # BuyerFlow: ACQUIRE/SKIP + selfComplete iNFT runJob
    │                           # (oracle, proof signing, OldDataHashMismatch retry
    │                           #  detector all live in @acl/inft)
    └── web/
        ├── index.html          # one-row stage + 8-section evidence rail markup
        ├── styles.css          # dark workshop aesthetic + responsive grid
        ├── app.js              # entry point: SSE wiring + applyEvent dispatch
        ├── lib/                # shared, reusable helpers
        │   ├── state.js        # DOM helpers + shared mutable UI state
        │   ├── format.js       # tUSDC formatting (TEST_USDC_DECIMALS)
        │   ├── links.js        # Galileo / Sepolia / 0G Storage explorer URLs
        │   ├── api.js          # /api/* fetch wrappers + SSE reconnect
        │   └── diagram.js      # stage-tile / chain-step state setters + AXL packet anim
    └── panels/             # evidence-rail section panels + phase-2 / modal / timeline
        ├── discovery.js    # 01 ENS / CCIP-Read + 02 LLM rank panels + reputation chips
        ├── taskspec.js     # 03 LLM-authored TaskSpec render
            ├── negotiation.js  # 04 AXL transcript render (incl. COUNTER + replay)
            ├── escrow.js       # 05 ERC-8183 transitions panel
            ├── deliverable.js  # 06 0G Storage deliverable fetch + render
            ├── evaluation.js   # 07 0G Compute TEE proof + Phase-2 self-evaluator morph
            ├── hooks.js        # 08 Settlement & hooks (Reputation + INFTDelivery)
            ├── phase2.js       # client-tile Phase-2 ACQUIRE/SKIP beat + iNFT card flight
            ├── storage-modal.js# 0G Storage submission preview dialog
            └── timeline.js     # event row builder + describe / detail / links
```

### Coordinator API (`src/server.ts`)

The Hono coordinator exposes a small surface that the browser consumes
via `web/lib/api.js`:

- `GET /api/config` — deployment addresses + provider ENS labels +
  current child-process roster, used to seed the static panels and
  drive the [Run job] button gate.
- `GET /events` — Server-Sent Events stream (each line is a
  serialised `AgentEvent` with `bigint` rendered as a string).
- `POST /api/start` / `POST /api/run` — driver controls exposed by
  the `[Start agents]` / `[Run job]` buttons.
- `POST /api/event` — child→coordinator event ingress (the agent
  processes POST here via `event-forwarder.ts`).
- `GET /api/storage/:kind/:rootHash` — pull a 0G Storage object by
  `kind` (`taskspec` / `deliverable` / `attestation`) and Merkle root
  for the corresponding panel preview.
- `GET /api/reputation/:agentId` — last-known reputation roll-up
  fetched off-chain from `ACLReputationRegistry`.
- `GET /api/inft/owner/:contract/:tokenId` — `ownerOf` passthrough
  used by the Phase-2 panel to show the buyer's tokenId after the
  `iTransfer` settles, without forcing the browser to mint its own
  viem client.
- `GET /api/inft-keys/:tokenId` — coordinator's in-process iNFT key
  registry (the demo's stand-in for a TEE attestation channel). The
  provider POSTs the freshly-derived AES `dataKey` here after each Op A;
  the buyer's demo-local `ReencryptionOracle` reads from it.

The `web/` UI is split into ES modules (`<script src="/app.js" type="module">`).
The coordinator serves `web/lib/<file>.js` and `web/panels/<file>.js` straight
out of the source tree. Every browser file is plain JS + DOM — no
framework, no bundler.

## Verified end-to-end (Galileo testnet)

Two consecutive jobs through the same coordinator session, May 2026,
against `ACLEvaluator` at
[`0x5684ef7345FD14434128b2DA056332e2a7187615`](https://chainscan-galileo.0g.ai/address/0x5684ef7345FD14434128b2DA056332e2a7187615).
Both ran with the LLM-driven discovery + AXL negotiation + TEE-attested
settle path — no shortcuts.

Storage explorer pages are linked by 0G submission sequence (`txSeq`),
not Merkle root, because the public storagescan UI keys files that
way. The SDK now surfaces `txSeq` directly in every `storage.upload`
event so downstream apps can build working links without guessing.

Job 27 is the first run after the negotiation strategy change in
`@acl/agent`: the `ClientAgent` now defaults to opening at the
midpoint of `[provider.minBudget, maxBudget]` instead of always
opening at `maxBudget`, and the bundled `PROVIDER_DECIDE_PROMPT`
allows providers to COUNTER for fair value on substantial work.
Job 27's timeline shows a real PROPOSE → COUNTER → ACCEPT round, not
a one-shot ACCEPT. To opt out of the midpoint default, pass
`openingBudget` in `runJob({ ... })`.

| Job | TaskSpec submission                                            | Deliverable submission                                         | Attestation submission                                         | Settle (TEE-verified)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --: | :------------------------------------------------------------- | :------------------------------------------------------------- | :------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  77 | [`#72755`](https://storagescan-galileo.0g.ai/submission/72755) | [`#72760`](https://storagescan-galileo.0g.ai/submission/72760) | [`#72768`](https://storagescan-galileo.0g.ai/submission/72768) | [`JobSettled(jobId=77, approved=true)`](https://chainscan-galileo.0g.ai/tx/0xa30795927aa9a9315d5efae2b0e5528eb756e0ec257e90eb45532760569535e8) — Phase 1 commission. `kelp-security.acl.eth` won discovery + negotiation; 600-word post-mortem hits all six required claims (116,500 rsETH, $292M, 20+ chains, LayerZero bypass, Aave/SparkLend/Fluid/Lido/Ethena pauses).                                                                                                           |
|  78 | [`#72755`](https://storagescan-galileo.0g.ai/submission/72755) | [`#72755`](https://storagescan-galileo.0g.ai/submission/72755) | embedded in `iTransfer`                                        | [`JobSettled(jobId=78, approved=true) + iTransfer`](https://chainscan-galileo.0g.ai/tx/0x2db9853fd519347445d942024addfcb14f13e80eebe5530cec45acf6654fcbbc) — autonomous Phase 2 follow-up. Client LLM scored Op A `0.95`, dispatched a second job carrying the `inft-sale` capability; settlement re-encrypted the corpus under the buyer's pubkey and atomically transferred `ACLAgentNFT#19` from the provider to the client (verified via on-chain `ownerOf(19)` after the demo). |

Each `JobSettled` proves that `ACLEvaluator` ran `ecrecover` against
the registered TEE signer for the actual 0G Compute provider that
produced the verdict (model `qwen/qwen-2.5-7b-instruct`). The taskSpec
the evaluator graded was re-derived from 0G Storage and asserted
against `Job.description` — which the client wrote at `createJob`
time — so a tampered storage root would have aborted the settle.

## Notes / known limitations

- Testnet `qwen-2.5-7b-instruct` is small. We hand the LLM strict
  templates (one JSON object per call), inline the source material, and
  cap negotiation at one counter-offer. Some runs still produce a
  malformed verdict; the evaluator will surface the parse error and
  reject the job.
- AXL needs one bridge per agent because the bridge owns the peer id.
  We run three locally; in production each agent process would run its
  own bridge somewhere it can reach the rest of the mesh.
- The 0G Compute Router rate-limits aggressively when multiple agents
  fire completions in quick succession. The SDK's
  `createOpenAICompatibleBackend` retries 408/425/429/5xx with
  `Retry-After` honouring (default 4 retries / 30s ceiling), which
  hides occasional 429s on the public testnet endpoint.
- Each agent process runs an `exitWhenOrphaned` watchdog so that if the
  coordinator gets `kill -9`'d the agents shut down too, instead of
  lingering as init-reparented zombies.
- The example does not redeploy the ACL contracts. If you redeploy
  `ACLEvaluator` (e.g. after a constructor change), run
  `make redeploy-evaluator && make merge-env` from the repo root, then
  update `sdk/packages/core/src/addresses.ts` and re-run
  `bun run setup:providers` so each provider's `acl.evaluator-address`
  metadata points at the new contract before booting agents.
