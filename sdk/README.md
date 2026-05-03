# `@acl` — Agentic Commerce SDK

A small TypeScript SDK that turns any group of LLM agents into a discoverable, negotiable, settle-able commerce mesh on [0G Galileo](https://docs.0g.ai). Built on [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) (Agentic Commerce Protocol), [Gensyn AXL](https://github.com/gensyn-ai/axl) (peer-to-peer agent transport), [0G Storage](https://docs.0g.ai/0g-da-storage) + [0G Compute](https://docs.0g.ai/0g-compute) (evidence + TEE-attested evaluation), [ENS](https://ens.domains) (identity), and [ERC-7857](https://eips.ethereum.org/EIPS/eip-7857) (intelligent NFTs for the asset lane).

The repo is a [Bun][bun] workspace; nothing depends on Node-only APIs but Bun is the tested runtime.

## Contents

- [`@acl` — Agentic Commerce SDK](#acl--agentic-commerce-sdk)
  - [Contents](#contents)
  - [Install](#install)
  - [Minimal end-to-end (CLI)](#minimal-end-to-end-cli)
  - [Packages](#packages)
  - [Agent classes](#agent-classes)
    - [`ClientAgent`](#clientagent)
    - [`ProviderAgent`](#provideragent)
    - [`EvaluatorAgent`](#evaluatoragent)
  - [Bootstrap helpers](#bootstrap-helpers)
  - [LLM backends and prompts](#llm-backends-and-prompts)
  - [Hooks: pluggable settlement extensions](#hooks-pluggable-settlement-extensions)
  - [iNFT lane (ERC-7857)](#inft-lane-erc-7857)
    - [Selling: `inftSaleDeliverableStrategy`](#selling-inftsaledeliverablestrategy)
    - [Refreshing: `iNftEncryptAndUpdate`](#refreshing-inftencryptandupdate)
    - [Buying: `prepareInftAcquisition` + `inftDeliveryHook`](#buying-prepareinftacquisition--inftdeliveryhook)
  - [0G Compute enforcement (the trust chain)](#0g-compute-enforcement-the-trust-chain)
  - [ENSIP-26 `agent-context` capabilities](#ensip-26-agent-context-capabilities)
  - [Lower-level packages](#lower-level-packages)
    - [`@acl/discovery` — resolve `*.acl.eth` and search the gateway](#acldiscovery--resolve-acleth-and-search-the-gateway)
    - [`@acl/negotiation` — drive AXL + sign EIP-712 `JobProposal`s](#aclnegotiation--drive-axl--sign-eip-712-jobproposals)
    - [`@acl/gateway` — run the CCIP-Read gateway](#aclgateway--run-the-ccip-read-gateway)
    - [`@acl/storage` — upload / download canonical artefacts](#aclstorage--upload--download-canonical-artefacts)
    - [`@acl/evaluation` — TEE-attested evaluation](#aclevaluation--tee-attested-evaluation)
    - [`@acl/settlement` — drive ERC-8183 from one helper](#aclsettlement--drive-erc-8183-from-one-helper)
  - [Resilience and operational guarantees](#resilience-and-operational-guarantees)
  - [Gas overrides](#gas-overrides)
  - [Repo layout](#repo-layout)
  - [License](#license)

## Install

```bash
cd sdk
bun install
bun run typecheck   # tsc --noEmit across the workspace
bun run test        # ~130 unit tests, no testnet needed
```

The packages link to each other via `workspace:*`; consumers will pick them up by `bun add @acl/agent` once published. Importing through `@acl/agent` is the recommended path because every primitive is also re-exported there, but importing directly from any of the lower-level packages keeps working unchanged.

Every package emits both `.js` (ESM) and `.d.ts` declarations under its own `dist/` via TypeScript project references (`tsc -b`). The workspace root `bun run build` runs the full graph; `bun run clean` wipes every package's `dist` + `tsbuildinfo` for a clean rebuild.

## Minimal end-to-end (CLI)

[`examples/quickstart`](../examples/quickstart) is the smallest sane demo: one client, one provider, one evaluator, each in its own process, each spawning its own AXL node, exercising the entire stack against the live 0G Galileo testnet. After extracting boilerplate (`config.ts` + `lib/axl.ts` + `lib/log.ts`), each agent file is ~30 lines:

```ts
// provider.ts — one autonomous seller agent
import { ACL_TESTNET, ProviderAgent, createZGRouterBackend } from "@acl/agent";
import {
  PROVIDER_MIN_BUDGET,
  PROVIDER_PERSONA,
  TASK_DOMAINS,
  env,
} from "./config.js";
import { spawnLocalAxl } from "./lib/axl.js"; // example helper, wraps spawnAxlBridge

const { child: bridge, apiUrl } = await spawnLocalAxl("provider");

const agent = new ProviderAgent({
  account: env.providerPk(),
  llm: createZGRouterBackend({
    apiKey: env.zgRouterApiKey(),
    model: env.zgRouterModel,
  }),
  axlApiUrl: apiUrl,
  ensName: `${env.providerEnsLabel}.${ACL_TESTNET.ens.parentName}`,
  persona: PROVIDER_PERSONA,
  acceptPolicy: {
    minBudget: PROVIDER_MIN_BUDGET, // 1 testUSDC (6 decimals)
    taskDomains: [...TASK_DOMAINS], // unique "quickstart-greeting" — see config.ts
    paymentTokens: [ACL_TESTNET.galileo.testUSDC],
    maxConcurrentJobs: 1,
  },
});

await agent.start();
process.on("SIGINT", async () => {
  await agent.stop();
  bridge.kill("SIGINT");
  process.exit(0);
});
```

```ts
// client.ts — one autonomous buyer driving one job to settle
import { ClientAgent, createZGRouterBackend } from "@acl/agent";
import {
  ALLOWED_DOMAINS,
  BRIEF,
  CLIENT_PERSONA,
  MAX_BUDGET,
  env,
} from "./config.js";
import { spawnLocalAxl } from "./lib/axl.js";

const { child: bridge, apiUrl } = await spawnLocalAxl("client");

const agent = new ClientAgent({
  account: env.clientPk(),
  llm: createZGRouterBackend({
    apiKey: env.zgRouterApiKey(),
    model: env.zgRouterModel,
  }),
  axlApiUrl: apiUrl,
  gatewayUrl: env.gatewayUrl(),
  persona: CLIENT_PERSONA,
});

await agent.start();
const result = await agent.runJob({
  brief: BRIEF,
  maxBudget: MAX_BUDGET,
  allowedDomains: [...ALLOWED_DOMAINS],
});
//  → discovery → AXL negotiation → 0G Storage → ERC-8183 createJob/fund
//  → provider submit → 0G Compute eval → settle → JobCompleted
console.log(result); // { jobId, approved, txHashes, attestationRoot, taskSpecRoot, deliverableRoot }
await agent.stop();
bridge.kill("SIGINT");
```

The evaluator is even simpler — it doesn't need an AXL bridge because it only listens to the chain and 0G Compute:

```ts
// evaluator.ts
import { EvaluatorAgent, ensureEvaluatorOperator } from "@acl/agent";
import { env } from "./config.js";

const agent = new EvaluatorAgent({ account: env.evaluatorOperatorPk() });
const ownerPk = env.evaluatorOwnerPk();
if (ownerPk) {
  // One-off: authorise this operator on ACLEvaluator. No-op when already authorised.
  await ensureEvaluatorOperator({
    ownerPrivateKey: ownerPk,
    operator: agent.address,
    deployment: agent.runtime.deployment,
    galileoRpcUrl: agent.runtime.galileoRpcUrl,
  });
}
await agent.start();
```

`spawnLocalAxl` is the example's port/peer wrapper around the SDK primitive `spawnAxlBridge`. Production deployments should import `spawnAxlBridge` directly (see [`@acl/agent`'s bootstrap helpers](#bootstrap-helpers)).

Run it:

```bash
make axl-setup           # one-off: builds the gensyn-axl node binary
cp examples/quickstart/.env.example examples/quickstart/.env  # fill keys

# T0 - CCIP-Read gateway
make quickstart-gateway
# T1 - provider AXL bridge + agent
make quickstart-provider
# T2 - 0G Compute evaluator
make quickstart-evaluator
# T3 - one-time provider registration, then one buyer job
make quickstart-setup
make quickstart-client
```

For the comprehensive demo (Phase 1 + autonomous Phase 2 iNFT acquisition with a live web UI), see [`examples/kelp-postmortem`](../examples/kelp-postmortem).

## Packages

| Package              | Purpose                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@acl/agent`]       | Umbrella + agent classes (`ClientAgent` / `ProviderAgent` / `EvaluatorAgent`), `LLMBackend`, prompts, bootstrap helpers (`bootstrapAxl`, `spawnAxlBridge`, `registerAclAgent`, `ensureEvaluatorOperator`), `acl-axl` CLI, `createAgentRuntime` kernel. Re-exports every primitive below.                                            |
| [`@acl/core`]        | Pinned `ACL_TESTNET` deployment, contract ABIs, viem chain definitions + transport-tuned client factories, ENSIP-25/26 helpers, EIP-712 `JobProposal` domain, canonical-JSON `TaskSpec` / `Deliverable` / `AttestationBundle` + `hashTaskSpec`, `waitForReceiptResilient`.                                                          |
| [`@acl/discovery`]   | `AgentResolver` for `*.acl.eth` → verified `AgentProfile` (CCIP-Read end-to-end), `searchAgents({ taskDomain?, capability? })`, `fetchReputation`, ENSIP-25 verification.                                                                                                                                                           |
| [`@acl/negotiation`] | AXL HTTP-bridge client (`AxlBridge`), high-level `Negotiator`, EIP-712 `JobProposal` builder/signer/verifier, `Transcript` export.                                                                                                                                                                                                  |
| [`@acl/storage`]     | 0G Storage uploader: `uploadTaskSpec` / `uploadDeliverable` / `uploadAttestationBundle` (canonical-JSON, in-memory, returns root + tx + `txSeq`).                                                                                                                                                                                   |
| [`@acl/evaluation`]  | 0G Compute Direct evaluator: `ensureFunded` → `evaluate` (TEE-verified inference, raw signature captured) → `buildAttestationBundle` → upload.                                                                                                                                                                                      |
| [`@acl/settlement`]  | ERC-8183 lifecycle wrapper: `createJobOrchestrator`, `watchJobLifecycle`, `reputationHook`, `JOB_STATUS`, lifecycle event ABIs.                                                                                                                                                                                                     |
| [`@acl/inft`]        | ERC-7857 client + acquisition pipeline. `INftClient` (mint/update/iTransfer/iClone), `iNftEncryptAndUpdate` (seller-side corpus refresh), `prepareInftAcquisition` + `repointInftAfterAcquisition` (buyer-side), `inftSaleDeliverableStrategy` (provider hook), `inftDeliveryHook` HookConfig, `createDemoLocalReencryptionOracle`. |
| [`@acl/gateway`]     | Hono-based EIP-3668 + ENSIP-21 BGOLP gateway. Indexes `IdentityRegistry.MetadataSet` events on 0G Galileo and signs CCIP-Read responses Sepolia clients can verify.                                                                                                                                                                 |

[`@acl/agent`]: ./packages/agent
[`@acl/core`]: ./packages/core
[`@acl/discovery`]: ./packages/discovery
[`@acl/negotiation`]: ./packages/negotiation
[`@acl/storage`]: ./packages/storage
[`@acl/evaluation`]: ./packages/evaluation
[`@acl/settlement`]: ./packages/settlement
[`@acl/inft`]: ./packages/inft
[`@acl/gateway`]: ./packages/gateway

## Agent classes

Each role is one class. They share a structured event bus (`agent.events.on(handler)`), accept a pluggable `LLMBackend` for reasoning, and pin every important configuration knob to a sensible default. All three agree on the same `AgentRuntime` kernel — viem clients on 0G Galileo + Sepolia, an ethers signer for the 0G SDKs, and a `0G Storage` wrapper.

### `ClientAgent`

```ts
import { ClientAgent, createZGRouterBackend } from "@acl/agent";

const agent = new ClientAgent({
  account: CLIENT_PRIVATE_KEY,
  llm: createZGRouterBackend({ apiKey, model: "qwen-2.5-7b-instruct" }),
  axlApiUrl: "http://127.0.0.1:9112",
  gatewayUrl: "https://gateway.acl.example",
});

await agent.start();
const result = await agent.runJob({
  brief:
    "Write a 600-word research report on the LayerZero v2 message-passing changes.",
  maxBudget: 100_000_000n,
  sourceMaterial: { url, text }, // optional source pin
  // allowedDomains: ["security", "research"],        // optional domain pin
  // allowedDeliveryTypes: ["text"],                   // optional delivery shape
});
//  { jobId, approved, txHashes, attestationRoot, taskSpecRoot, deliverableRoot }
```

`runJob` does:

1. LLM picks a `taskDomain` from `allowedDomains` (default: `["research", "writing", "analysis", "engineering", "general"]`).
2. `searchAgents` queries the gateway for matching providers.
3. LLM ranks candidates best-first using their advertised metadata.
4. The agent walks the ranked list, ENS-resolving each candidate and negotiating over AXL (`PROPOSE` → at most one `COUNTER` → `ACCEPT`). On `REJECT` / timeout / signature-verification failure it falls through to the next-ranked provider; `ClientAgentConfig.maxNegotiationAttempts` caps the walk (default `3`). Each attempt emits `negotiation.attempt` and, on failure, `negotiation.failed`.
5. Once accepted, it uploads the agreed `TaskSpec` to 0G Storage, drives `createJob → setProvider → setBudget → fund`, and waits for the evaluator's `JobCompleted` / `JobRejected` event.

`openingBudget` defaults to the midpoint of `[provider.minBudget, maxBudget]` so the provider has room to `COUNTER` for fair value. Set it equal to `maxBudget` to skip negotiation and ACCEPT-on-first-reply.

### `ProviderAgent`

```ts
import { ProviderAgent, createZGRouterBackend } from "@acl/agent";

const agent = new ProviderAgent({
  account: PROVIDER_PRIVATE_KEY,
  llm: createZGRouterBackend({ apiKey, model: "qwen-2.5-7b-instruct" }),
  axlApiUrl: "http://127.0.0.1:9111",
  ensName: "researcher.acl.eth",
  acceptPolicy: {
    minBudget: 50_000_000n, // 50 testUSDC (6 decimals)
    taskDomains: ["security", "research"],
    paymentTokens: [TUSDC],
    maxConcurrentJobs: 1,
  },
  persona: "You are a smart-contract security specialist…",
});

await agent.start();
```

`start()` connects to the local AXL bridge, watches it for incoming `PROPOSE` envelopes, and runs the LLM to ACCEPT / COUNTER / REJECT each one against the configured `acceptPolicy` + free-form `persona`. When a job is funded on-chain it generates the deliverable via the LLM, uploads it to 0G Storage, and submits.

For verticals that need a custom deliverable shape (e.g. iNFT pointer commitments instead of LLM text), pass `produceDeliverable` — see [iNFT lane](#inft-lane-erc-7857). Returning `null` from the strategy falls back to the SDK's default LLM-text path, so partial overrides are first-class.

### `EvaluatorAgent`

```ts
import { EvaluatorAgent, ensureEvaluatorOperator } from "@acl/agent";

const agent = new EvaluatorAgent({ account: EVALUATOR_OPERATOR_PRIVATE_KEY });

// One-time bootstrap: authorise the operator on `ACLEvaluator`.
await ensureEvaluatorOperator({
  ownerPrivateKey: OWNER_PK,
  operator: agent.address,
  deployment: agent.runtime.deployment,
  galileoRpcUrl: agent.runtime.galileoRpcUrl,
});

await agent.start();
//  watches AgenticCommerce.JobSubmitted, evaluates each one via 0G
//  Compute (default `qwen-2.5-7b-instruct`), uploads the attestation
//  bundle, calls ACLEvaluator.settle() with the raw TEE signature so
//  the on-chain `ecrecover` against the registered TEE signer +
//  replay protection passes.
```

For non-class composition, `createDefaultEvaluator(...)` returns the same agent under the original factory name and `createEvaluator(...)` from `@acl/evaluation` exposes the lower-level pipeline.

## Bootstrap helpers

`@acl/agent` exposes one-call helpers for the boot-time chores every demo runs into:

- `spawnAxlBridge({ axlBin?, apiPort?, tcpPort?, listenPort?, apiHost?, peers?, peerKeyPath?, configPath?, env?, cwd?, stdio? })` — spawn a `gensyn-axl/node` Go binary, generate the ed25519 peer key idempotently, write `node-config.json`, poll `/topology` until a peer id surfaces, return `{ child, apiUrl, peerId }`. Surfaces the canonical "AXL binary not on `$PATH`" foot-gun (`ENOENT` from the Bun Go bridge) with a friendly error.
- `bootstrapAxl({ apiUrl })` — connect to an already-running AXL bridge and pull back its public peer id. Use this when the bridge lifecycle is owned elsewhere (Docker, systemd, etc.).
- `registerAclAgent({ ... })` — register an agent in `ACLIdentityRegistry`, write the canonical `acl.*` metadata in one call. Idempotent: pass `existingAgentId` to skip the `register()` and only re-write metadata. Pins an explicit pending-nonce per `setMetadata` so back-to-back writes never collide on the same slot.
- `ensureEvaluatorOperator({ ownerPrivateKey, operator, deployment, galileoRpcUrl, aclEvaluator? })` — idempotent `setOperator` for `ACLEvaluator`. Reads the current authorisation first; only writes when the operator isn't already authorised.
- `acl-axl` CLI shim — friendly wrapper around `gensyn-axl/node` that validates the JSON config and waits for `/topology` before exiting `0`. Useful from `bun x` / npm scripts where you don't want to depend on the SDK's process supervision.

## LLM backends and prompts

Every agent that reasons takes an `LLMBackend`. Two factories cover most cases:

- `createZGRouterBackend({ apiKey, model, baseUrl? })` — 0G Compute (router or direct provider). Defaults to the public router; pass `baseUrl` to point at a CLI-minted direct provider's `/v1/proxy` endpoint.
- `createOpenAICompatibleBackend({ apiKey, model, baseUrl, timeoutMs?, extraHeaders?, maxRetries?, initialBackoffMs? })` — any OpenAI-compatible endpoint (vLLM, OpenAI, OpenRouter, etc.). Bakes in `408 / 425 / 429 / 500 / 502 / 503 / 504` retry with `Retry-After`-aware backoff (default 4 retries, 30 s ceiling) so a public testnet endpoint's rate limit doesn't fall straight through.

The default prompts (`DEFAULT_CLIENT_PROMPTS`, `DEFAULT_PROVIDER_PROMPTS`) ship with strict-JSON-output schemas tuned for `qwen-2.5-7b-instruct`. Override at construction via `new ClientAgent({ prompts: { rankProviders: ... } })` / `new ProviderAgent({ prompts: { decide: ... } })` for vertical-specific behaviours; missing entries fall back to defaults so partial overrides don't fork the SDK.

## Hooks: pluggable settlement extensions

Every ERC-8183 lifecycle call (`setProvider`, `setBudget`, `fund`, `submit`, `complete`) accepts an optional `optParams: bytes`. `@acl/core` exposes `HookConfig` to make that end-to-end: the client passes a single struct and the orchestrator threads each `optParams` slot to the right call.

By default `ClientAgent` **auto-wires the deployed `ReputationHook`** for every Phase-1 commission job (`autoReputationHook` defaults to `true`). Settlement (`complete` / `reject`) writes a `Feedback` entry into `ACLReputationRegistry` against the picked provider's ERC-8004 v2 agent id, no extra config required.

```ts
import { ClientAgent } from "@acl/agent";
import { reputationHook } from "@acl/settlement";
import { ACL_TESTNET } from "@acl/core";

// (1) Default — reputationHook auto-wired against the picked provider.
await client.runJob({ brief: "...", maxBudget: 100_000_000n });

// (2) Explicit hook (full control over `optParams`).
await client.runJob({
  brief: "...",
  maxBudget: 100_000_000n,
  hook: reputationHook({ deployment: ACL_TESTNET, providerAgentId: 7n }),
});

// (3) Opt out of any hook.
await client.runJob({
  brief: "...",
  maxBudget: 100_000_000n,
  autoReputationHook: false,
});
```

iNFT acquisition uses `inftDeliveryHook` (see next section). Both hooks ship `HookConfig` factories so the caller never hand-encodes `optParams` bytes.

## iNFT lane (ERC-7857)

ERC-7857 intelligent NFTs encapsulate an encrypted persona + corpus + model id under a single token. ACL plugs the standard into ERC-8183 so a buyer can acquire an entire agent — its memory, its persona, its model — atomically with the payment. `@acl/inft` ships the full pipeline; the comprehensive [`examples/kelp-postmortem`](../examples/kelp-postmortem) demo runs both Phase 1 (commission) and Phase 2 (autonomous iNFT acquisition triggered after a satisfying Phase 1 settlement) end-to-end.

### Selling: `inftSaleDeliverableStrategy`

```ts
import { ProviderAgent, inftSaleDeliverableStrategy } from "@acl/agent";

let agent: ProviderAgent;
agent = new ProviderAgent({
  // ...account / llm / acceptPolicy / ensName...
  acceptPolicy: { iNftSalePrice: 25_000_000n, ... },           // separate floor for the iNFT lane
  produceDeliverable: (input) =>
    inftSaleDeliverableStrategy({
      publicClient: agent.runtime.publicClient,
      walletClient: agent.runtime.walletClient,
      deployment,
      tokenId,
      providerAgentId,                                          // ERC-8004 v2 agent id encoded into the pointer
    })(input),
});
```

The strategy returns a canonical pointer commitment (`application/vnd.acl.inft-pointer`) for `deliveryType === "iNFT"` TaskSpecs, and `null` for everything else (flowing through the SDK's default LLM-text path). It also wires the idempotent `ERC-721.approve(hookAddress, tokenId)` so `INFTDeliveryHook` can `transferFrom` the iNFT into escrow inside `_onBeforeSubmit`.

### Refreshing: `iNftEncryptAndUpdate`

After every Phase-1 delivery, the seller can re-encrypt + upload + on-chain `update(...)` its iNFT corpus in one call ("Op A" in the kelp-postmortem demo):

```ts
import { iNftEncryptAndUpdate, publicKeyFromPrivateKey } from "@acl/inft";
import { hexToBytes, stringToBytes } from "viem";

const result = await iNftEncryptAndUpdate({
  storage,
  nft,
  publicClient,
  input: {
    tokenId,
    plaintext: stringToBytes(JSON.stringify(personaBundle)),
    recipientPubKey: hexToBytes(publicKeyFromPrivateKey(ownerKey)),
    dataDescription: "researcher.acl.eth agent bundle",
    onEncrypted: ({ dataKey, dataHash, rootHash }) =>
      keyCustody.publish(tokenId, { dataKey, dataHash, rootHash }),
  },
});
//  { txHash, rootHash, dataHash, uri, dataKey, sealedKey, ciphertext }
```

`onEncrypted` fires **after the upload** but **before the on-chain `update(...)`**, so a key-custody surface (production: an operator-run TEE-backed key store such as a Nitro Enclave / SGX enclave / OP-TEE node, or a managed KMS/HSM; demos: in-process registry) is in sync with the chain by the time `intelligentDataOf(tokenId)` advertises the new `dataHash`. Throwing aborts the refresh; the chain stays untouched. (0G's TeeML stack, used by the [evaluator's trust chain](#0g-compute-enforcement-the-trust-chain), provides verifiable inference — not a managed key-custody service — so the iNFT custody surface is operator-owned.)

### Buying: `prepareInftAcquisition` + `inftDeliveryHook`

```ts
import {
  inftDeliveryHook,
  prepareInftAcquisition,
  repointInftAfterAcquisition,
} from "@acl/inft";

// 1. On-chain reads → seller download → oracle re-encrypt → access-proof
//    signature → buyer upload → local decrypt. Returns the artefacts
//    needed by the hook + the post-transfer `update(...)`.
const prep = await prepareInftAcquisition({
  nft,
  storage,
  oracle,
  tokenId,
  buyer: buyerAccount,
  buyerPrivateKey,
});

// 2. Self-complete runJob with the iNFT-delivery hook —
//    AgenticCommerce.complete(...) runs `iTransfer` inside the hook
//    with the proof we just signed.
await client.runJob({
  brief: "Acquire iNFT tokenId=7 from researcher.acl.eth",
  maxBudget: 25_000_000n,
  evaluator: client.address, // buyer-as-evaluator
  selfComplete: true, // skip ACLEvaluator
  allowedDeliveryTypes: ["iNFT"],
  hook: inftDeliveryHook({
    deployment,
    nftContract: nft.contract,
    tokenId,
    providerAgentId,
    proofs: [prep.proof],
  }),
});

// 3. Post-transfer fixup — repoint encryptedStorageURI at the buyer
//    upload + read the new owner.
const { updateTxHash, newOwner } = await repointInftAfterAcquisition({
  nft,
  publicClient,
  tokenId,
  newDataHash: prep.reencryption.newDataHash,
  newEncryptedStorageURI: prep.newEncryptedStorageURI,
  dataDescription: "buyer-side bundle",
});
```

The buyer flow tolerates a mid-flight `OldDataHashMismatch` (seller refreshed the corpus while the proof was being signed) by detecting the revert via `isOldDataHashMismatchError(err)` and retrying against the new `dataHash` automatically.

For a drop-in `ReencryptionOracle` you can run locally without standing up a real TEE, see `createDemoLocalReencryptionOracle({ oracleSigner, verifierAddress, chainId, fetchDataKey })` — it signs `OwnershipProof`s with a configurable EOA (the same address you point `TrustedPartyVerifier.setOracle` at).

## 0G Compute enforcement (the trust chain)

A natural worry once you let a permissioned operator settle jobs is: _how do we know the evaluator actually ran the registered 0G Compute model and didn't silently swap to a biased local LLM?_ ACL closes that gap end-to-end with on-chain TEE-signature recovery against the 0G Compute marketplace.

The four enforcement points the SDK + contracts give you for free:

1. **Pre-flight TEE-id check**. `EvaluatorAgent.evaluate` (`sdk/packages/evaluation/src/evaluator.ts`) extracts the response id from the `ZG-Res-Key` header (or `data.id` fallback). If neither is present, the SDK throws _"provider is not TEE-attested or response was malformed; cannot satisfy ACLEvaluator.settle TEE proof"_ immediately — a non-TEE endpoint can't even start a settle.

2. **Broker-side response verification**. The SDK calls `broker.inference.processResponse(provider, responseId)`. A `null` return (broker can't find the signed payload) is treated as a hard failure — settlement does not proceed without a verified response.

3. **Raw TEE signature capture**. The SDK fetches `<endpoint>/signature/:chatID?model=<modelId>` to read the exact `signedText` and `teeSignature` the TEE produced. Both are recorded verbatim in the `AttestationBundle` uploaded to 0G Storage and passed into the on-chain settle call.

4. **On-chain `ACLEvaluator.settle` recovery + replay protection** (`src/core/ACLEvaluator.sol`):

   ```solidity
   // 1. Reject pre-used signatures.
   bytes32 sigNonce = keccak256(signedText);
   if (usedTeeSignatures[sigNonce]) revert TeeSignatureReplayed();

   // 2. Read the canonical TEE signer for `computeProvider` from the
   //    0G InferenceServing marketplace (immutable address; provider
   //    operators acknowledge their TEE signer once at registration).
   IInferenceServing.Service memory svc =
       inferenceServing.getService(computeProvider);
   if (!svc.teeSignerAcknowledged) revert TeeSignerNotAcknowledged();

   // 3. Recover the signature against signedText and assert equality.
   address recovered = ECDSA.recover(
       MessageHashUtils.toEthSignedMessageHash(signedText),
       teeSignature
   );
   if (recovered != svc.teeSignerAddress) revert TeeSignatureMismatch();

   // 4. Burn the nonce, then forward to AgenticCommerce.
   usedTeeSignatures[sigNonce] = true;
   ```

This composition prevents the two attacks the contract NatSpec calls out by name:

- **"Operator passes `setOperator()` once and silently swaps to a local LLM"** — every `settle()` requires a fresh `(signedText, teeSignature)` tuple that ECDSA-recovers to the registered TEE signer of a real 0G Compute provider. Generating one is exactly as hard as compromising the TEE itself.
- **"Operator runs one inference on 0G then reuses the signature forever"** — `usedTeeSignatures[keccak256(signedText)]` permanently shadows each TEE response after first use; replays revert on `TeeSignatureReplayed`.

**Scope caveat (be honest with users).** `ACLEvaluator.settle` pins the **provider address** (and therefore its registered TEE signer), not a specific `modelId`. The 0G Compute marketplace today binds one model per provider on the chatbot service, so pinning the provider transitively pins the model — but if a provider operator swaps their served model between runs, on-chain enforcement alone won't catch it. Off-chain, the `AttestationBundle` records `modelId`, `responseId`, and `promptHash`, so any verifier (the client, a reputation indexer, a third-party auditor) can cross-check that the model id at settle time matched what the buyer expected.

In other words: trust is _provider TEE signer = registered 0G operator, signature = fresh, prompt = canonical_, all asserted on-chain; the model id is asserted off-chain via the attestation bundle. That's exactly the surface 0G Compute exposes today, and the SDK leans on every available knob.

## ENSIP-26 `agent-context` capabilities

Agents publish a discoverability JSON record under the ENS text key `agent-context`. The SDK ships build/parse helpers in `@acl/core`, plus `INFT_SALE_CAPABILITY_KEYS` + `parseInftSaleCapability` in `@acl/inft` so producers and consumers reference the same dotted-key constants:

```ts
import { buildAgentContext } from "@acl/core";
import { INFT_SALE_CAPABILITY_KEYS, parseInftSaleCapability } from "@acl/inft";

// Producer side — register the iNFT-sale extras.
const context = buildAgentContext({
  capabilities: ["commission", "inft-sale"],
  extra: {
    [INFT_SALE_CAPABILITY_KEYS.contract]: ACL_TESTNET.galileo.aclAgentNFT,
    [INFT_SALE_CAPABILITY_KEYS.tokenId]: "7",
    [INFT_SALE_CAPABILITY_KEYS.minPrice]: "25000000",
  },
});
// pass to registerAclAgent({ capabilities, agentContextExtra })

// Consumer side — typed view of the seller's extras.
const cap = parseInftSaleCapability(profile.agentContext?.extra);
//  { contract, tokenId, minPrice, paymentToken, verifier } | null
```

The gateway (`@acl/gateway`) indexes capabilities; clients can filter:

```ts
import { searchAgents } from "@acl/discovery";

const sellers = await searchAgents({
  gatewayUrl: "https://gateway.acl.example",
  capability: "inft-sale",
});
```

## Lower-level packages

Reach for these directly when you only need a subset of the SDK (e.g. an indexer that only does discovery + reputation), are integrating into a non-Bun toolchain that prefers narrow dependency lists, or are bridging to a non-default ACL deployment.

### `@acl/discovery` — resolve `*.acl.eth` and search the gateway

```ts
import { ACL_TESTNET } from "@acl/core";
import { createAgentResolver } from "@acl/discovery";

const resolver = createAgentResolver({
  deployment: ACL_TESTNET,
  sepoliaRpcUrl: process.env.SEPOLIA_RPC_URL,
  galileoRpcUrl: ACL_TESTNET.galileo.rpcUrl,
});

const resolved = await resolver.resolve("researcher.acl.eth", {
  ensip25: "best-effort", // verify on-chain self-attestation
  withReputation: true, // pull ERC-8004 v2 reputation summary
});
console.log(resolved?.profile);
//  { ensName, agentId, chainId, agentAddress, evaluatorAddress, axlPeerId,
//    minBudget, paymentTokens, score: { count, summaryValue, summaryValueDecimals }, ... }
```

When `galileoClient` is wired in (the factory does this whenever `galileoRpcUrl` is set), the resolver does one ENS `getEnsText('acl.agent-id')` lookup and then batches every remaining metadata key into a single `multicall3` round-trip directly against the IdentityRegistry on 0G — cutting CCIP-Read trips from ~9 to 2.

If all you need is the on-chain ERC-8004 reputation summary for an already-known agent id (no ENS round-trip), use `fetchReputation(cfg, agentId)` directly. `summaryValue` is a **signed** `bigint` (net-negative feedback is legal); rank with full bigint semantics, not `> 0n` truthiness.

### `@acl/negotiation` — drive AXL + sign EIP-712 `JobProposal`s

```ts
import { ACL_TESTNET } from "@acl/core";
import {
  createNegotiator,
  generateNonce,
  type TaskSpec,
} from "@acl/negotiation";
import { privateKeyToAccount } from "viem/accounts";

const client = createNegotiator({
  apiUrl: "http://127.0.0.1:9112", // local AXL bridge
  deployment: ACL_TESTNET, // pins EIP-712 chainId + verifyingContract
  signer: privateKeyToAccount(process.env.CLIENT_PRIVATE_KEY as `0x${string}`),
});

const taskSpec: TaskSpec = {
  /* canonical TaskSpec */
};

const { proposal } = await client.propose({
  destPeerId: providerProfile.axlPeerId,
  taskSpec,
  draft: {
    client: client.selfAddress,
    provider: providerProfile.agentAddress,
    evaluator: providerProfile.evaluatorAddress,
    paymentToken: providerProfile.paymentTokens[0],
    amount: providerProfile.minBudget,
    hook: ACL_TESTNET.galileo.reputationHook,
    expiresAt: BigInt(Math.floor(Date.now() / 1e3) + 30 * 60),
    nonce: generateNonce(),
  },
});

const accept = await client.waitFor("ACCEPT", { timeoutMs: 30_000 });
await client.verifyAccept(
  accept.payload,
  providerProfile.agentAddress,
  proposal,
);
await client.accept({
  destPeerId: accept.fromPeerId,
  replyTo: accept.id,
  proposal,
});
// `client.transcript.export()` is the dual-signed off-chain commitment.
```

The 8-message AXL envelope (`HELLO`, `PROPOSE`, `COUNTER`, `ACCEPT`, `REJECT`, `CANCEL`, `ACK`, `ERROR`) covers the full pre-on-chain negotiation. Post-on-chain coordination uses ERC-8183 events emitted by `AgenticCommerce` directly — AXL never duplicates lifecycle state. `Negotiator.waitForOneOf` accepts a `replyToId` filter so a caller iterating multiple candidates can scope each wait to a specific outbound message.

### `@acl/gateway` — run the CCIP-Read gateway

```bash
cd sdk
GATEWAY_FROM_BLOCK=30140000 bun run packages/gateway/src/cli.ts
```

Reads `GATEWAY_SIGNER_PRIVATE_KEY` and the deployed Sepolia + 0G addresses from env. `GATEWAY_RPC` defaults to the **public** 0G testnet endpoint regardless of `ZG_RPC` — most paid 0G plans cap `eth_getLogs` at ~5 blocks, which makes the `MetadataSet` backfill prohibitive. Override with `GATEWAY_RPC=...` only when you maintain a private RPC without a range cap. `GATEWAY_BLOCK_RANGE` caps the per-`eth_getLogs` window (default 5000); the indexer halves it on RPC range-limit errors and grows it back on success.

The gateway exposes:

- `GET /healthz` — liveness + signer + indexer summary.
- `GET /agents` — debug index dump (agentId → metadata).
- `GET /:sender/:data.json`, `POST /:sender?` — EIP-3668 endpoints.
  - Direct CCIP-Read (`IResolverService.resolve(name, data)`, selector `0x9061b923`) — answers a single ENS resolver call.
  - ENSIP-21 BGOLP (`IBatchGateway.query(Request[])`, selector `0xa780bab6`) — fan-out for the Universal Resolver V3 batch path; subrequests targeting our resolver are processed locally, others are HTTP-forwarded to their `urls`.

When `ACLOffchainResolver.url` on Sepolia points to a public URL (e.g. an ngrok tunnel), the same gateway transparently serves any viem / cast / ethers client doing `getEnsText('*.acl.eth', 'acl.axl-peer-id')`. To expose the local gateway via ngrok:

```bash
ngrok http 3000              # in another terminal; copy the https URL
make set-resolver-url URL='https://<random>.ngrok-free.app/{sender}/{data}.json'
```

`make set-resolver-url` calls `ACLOffchainResolver.setUrl(string)` from `DEPLOYER_PRIVATE_KEY`. Re-run after every `ngrok` restart on the free tier (URLs rotate). Stable deployments should use a custom domain instead.

### `@acl/storage` — upload / download canonical artefacts

`@acl/storage` accepts three config shapes — pick one:

- `{ privateKey }` — the factory builds a fresh `Indexer` + `JsonRpcProvider` + `Wallet` for you. Pays the Flow `submit()` gas.
- `{ signer }` — pass a pre-built `ethers.Signer` (matches the official `@0gfoundation/0g-ts-sdk` wagmi/RainbowKit pattern).
- `{ readOnly: true }` — download-only mode. No wallet is built, no Flow signer needed. Calling any `upload*` method throws an explicit error mentioning the misuse. Use this from observers / web UIs that just need to materialise an on-chain `rootHash` back into bytes.

Every upload serializes through `canonicalJson` so the same payload always hashes to the same Merkle root regardless of key insertion order.

```ts
import { createAclStorage } from "@acl/storage";

const storage = createAclStorage({
  privateKey: process.env.PROVIDER_PRIVATE_KEY as `0x${string}`,
  // rpcUrl + indexerUrl default to the public 0G testnet endpoints.
});

const { rootHash, txHash, txSeq } = await storage.uploadTaskSpec(taskSpec);
const fetched = await storage.downloadDeliverable(deliverableRoot);

// Read-only viewer — no private key, no wallet:
const viewer = createAclStorage({ readOnly: true });
const fetched2 = await viewer.downloadDeliverable(deliverableRoot);
```

`uploadBytes` / `uploadString` / `uploadJson` are exposed for app-specific payloads; the typed helpers (`uploadTaskSpec`, `uploadDeliverable`, `uploadAttestationBundle`) just stamp the canonical-JSON form onto them. Storage explorer URLs key files by `txSeq` (`https://storagescan-galileo.0g.ai/submission/<txSeq>`), not by Merkle root, so the SDK surfaces `txSeq` directly on every upload event.

### `@acl/evaluation` — TEE-attested evaluation

`@acl/evaluation` wraps `@0glabs/0g-serving-broker`. The evaluator funds its ledger + provider sub-account once (`ensureFunded`, idempotent), then runs verifiable inference for each `(taskSpec, deliverable)` pair and assembles an `AttestationBundle`:

```ts
import { ACL_TESTNET } from "@acl/core";
import { createEvaluator } from "@acl/evaluation";
import { createAclStorage } from "@acl/storage";

const storage = createAclStorage({
  privateKey: process.env.EVALUATOR_OPERATOR_PRIVATE_KEY as `0x${string}`,
});

const evaluator = await createEvaluator({
  privateKey: process.env.EVALUATOR_OPERATOR_PRIVATE_KEY as `0x${string}`,
  storage,
  // `modelMatch` defaults to `DEFAULT_MODEL_MATCH` (`qwen-2.5-7b-instruct`
  // on Galileo testnet — see `KNOWN_MODELS`). Pass any string from
  // `KNOWN_MODELS`, a free-form substring, or a RegExp to pin a different
  // 0G Compute service. Use `providerAddress` to skip auto-discovery.
});

await evaluator.ensureFunded({
  initialDeposit: 3, // OG (whole units) — 0G's MIN_LEDGER_BALANCE is 3.
  providerTransfer: 10n ** 18n, // neuron — 1 OG, 0G's MIN_TRANSFER_AMOUNT.
});

const evaluation = await evaluator.evaluate({
  taskSpec,
  deliverable,
  taskSpecRoot,
  deliverableRoot,
});
const bundle = evaluator.buildAttestationBundle({
  jobId,
  commerceContract: ACL_TESTNET.galileo.agenticCommerce,
  chainId: ACL_TESTNET.galileo.chainId,
  taskSpecRoot,
  deliverableRoot,
  evaluation,
});
const { rootHash: attestationRoot } =
  await evaluator.uploadAttestationBundle(bundle);
```

The default system prompt forces strict JSON output (`approved`, `score`, `summary`, `reasoning`) and contains an injection guardrail so a malicious deliverable can't talk the evaluator into a positive verdict.

### `@acl/settlement` — drive ERC-8183 from one helper

`@acl/settlement` wraps `AgenticCommerce` + `ACLEvaluator` so client / provider / evaluator each only call ~3 high-level methods instead of hand-rolling viem `writeContract` calls.

```ts
import { ACL_TESTNET } from "@acl/core";
import { createJobOrchestrator } from "@acl/settlement";
import { encodeAbiParameters, zeroAddress } from "viem";

// Client side
const client = createJobOrchestrator({
  walletClient: clientWallet,
  publicClient: galileo,
});

const { jobId } = await client.createJob({
  provider: zeroAddress,
  evaluator: providerProfile.evaluatorAddress,
  expiredAt: BigInt(Math.floor(Date.now() / 1e3) + 30 * 60),
  description: "ACL Flow-1 demo deliverable",
  hook: ACL_TESTNET.galileo.reputationHook,
});
await client.setProvider({
  jobId,
  provider: providerProfile.agentAddress,
  optParams: encodeAbiParameters(
    [{ type: "uint256" }],
    [providerProfile.agentId],
  ),
});

// Provider side
const provider = createJobOrchestrator({
  /* ...provider wallet... */
});
await provider.setBudget({ jobId, amount });
await client.fund({ jobId, expectedBudget: amount }); // auto-approves the IERC20
await provider.submit({ jobId, deliverable: deliverableRoot });

// Evaluator side
const evalOrch = createJobOrchestrator({
  /* ...evaluator wallet... */
});
await evalOrch.settleViaEvaluator({
  jobId,
  approved: evaluation.normalizedVerdict.approved,
  attestationRoot,
});
```

`paymentToken` defaults to the deployment's `testUSDC`; pass any ERC-20-compliant token via the `paymentToken` config option (the orchestrator uses a minimal `IERC20` ABI so any compliant token works). `JobOrchestrator` also exposes `watchJobLifecycle(jobId)` (async-iterable per-jobId event stream — supports an `events` filter and a `timeoutMs` for self-bounded waits) and the canonical lifecycle event ABIs (`JOB_CREATED_EVENT`, `JOB_SUBMITTED_EVENT`, …).

## Resilience and operational guarantees

Public testnet RPCs (0G Galileo, Sepolia) routinely return transient 5xx, slow-propagate fresh transactions, and impose `eth_getLogs` range caps. The SDK bakes a few pragmatic defaults so consumers don't have to tune viem from scratch:

- **Transport tuning**. `@acl/core/clients` constructs every viem `PublicClient` / `WalletClient` with `DEFAULT_TRANSPORT_RETRY_COUNT`, `DEFAULT_TRANSPORT_RETRY_DELAY_MS`, `DEFAULT_TRANSPORT_TIMEOUT_MS`, and `DEFAULT_POLLING_INTERVAL_MS`. Override per call when you have a beefier endpoint.
- **Receipt resilience**. `waitForReceiptResilient(client, hash, opts?)` polls directly and only resolves once a receipt is observed (default 5-minute window, 2 s polling cadence — both configurable). Every agent / orchestrator wait routes through this helper instead of viem's `waitForTransactionReceipt`, which gives up early on the public 0G RPC's intermittent `eth_getTransaction` flakiness.
- **Log pagination + dedup**. `@acl/settlement/log-paginate` chunks `eth_getLogs` queries (with exponential backoff) and deduplicates by `(transactionHash, logIndex)` so flaky public RPCs that re-emit the same log don't cause double-processing in the agent loops.
- **Replay-safe handlers**. `EvaluatorAgent` and `ProviderAgent` guard their event handlers on the on-chain `Job.status`. A fresh process can boot, replay the full historical `JobSubmitted` / `JobFunded` log range, and silently no-op on jobs that have already settled instead of racing the live evaluator / provider for a redundant on-chain action.
- **Storage tamper detection**. `EvaluatorAgent` re-derives `hashTaskSpec(downloaded TaskSpec)` and asserts equality with the on-chain `Job.description` (the value the client wrote at `createJob` time) before calling `settle()`. Storage tampering, swapped roots, or canonicalisation drift abort the pipeline instead of producing a bogus signed verdict.
- **LLM rate-limit recovery**. `createOpenAICompatibleBackend` retries `408 / 425 / 429 / 5xx` responses with `Retry-After`-aware backoff (default 4 retries, 30 s ceiling). This hides the public 0G Compute Router's aggressive rate limit when several agent processes fire chat completions back-to-back.
- **Negotiation deadline**. `ProviderAgent` always sends an explicit `REJECT` back to the client if its proposal handler throws (LLM error, AXL bridge hiccup, etc.) so the client's `recv` returns immediately with a useful reason instead of waiting out the full negotiation deadline. Combined with the configurable `negotiationTimeoutMs` (default `DEFAULT_NEGOTIATION_TIMEOUT_MS = 180 s`), this closes the "provider went silent and the client hangs" failure mode.
- **Configurable poll cadences**. `ClientAgentConfig.settlementPollIntervalMs`, `ProviderAgentConfig.axlPollIntervalMs` / `chainPollIntervalMs` / `pendingSweepIntervalMs`. Defaults sized for the public 0G testnet RPC; tighten when running against a paid endpoint or a local fork.
- **Event serialisation**. `serializeAgentEvent(payload)` is a drop-in `JSON.stringify` replacement that handles `bigint` (string) and `function` (drop) leaves so apps forwarding the agent event bus over IPC, SSE, or HTTP don't have to roll their own replacer.

If you target a private RPC without these quirks, you can keep the defaults — they're safe upper bounds — or tighten them per call.

## Gas overrides

`createAgentRuntime` and every `createJobOrchestrator` accept an optional `gasFeeOverrides`:

```ts
const runtime = createAgentRuntime({
  account,
  gasFeeOverrides: {
    type: "eip1559",
    maxFeePerGas: 5_000_000_000n,
    maxPriorityFeePerGas: 1_500_000_000n,
  },
  // or { type: "legacy", gasPrice: 5_000_000_000n }
});
```

Galileo natively supports EIP-1559 — the previous `--legacy --with-gas-price 5gwei` Foundry defaults were defensive copies, not chain requirements. Default to omitting `gasFeeOverrides` and only pin them when a specific RPC misbehaves.

## Repo layout

```
sdk/
  packages/
    core/         # ABIs (incl. minimal IERC20), addresses (ACL_TESTNET), viem client factories,
                  # ENSIP-25/26 + EIP-712 helpers, TaskSpec/Deliverable/AttestationBundle, receipts.
    agent/        # Agent classes (Client/Provider/Evaluator) + LLM backends + bootstrap helpers
                  # + acl-axl CLI + createAgentRuntime kernel + re-exports of every primitive.
    discovery/    # AgentResolver (viem) + searchAgents + fetchReputation + ENSIP-25 verify.
    negotiation/  # AxlBridge + Negotiator + JobProposal helpers + Transcript export.
    storage/      # 0G Storage uploads/downloads (canonical JSON) + readOnly viewer.
    evaluation/   # 0G Compute Direct evaluator + AttestationBundle builder.
    settlement/   # ERC-8183 lifecycle (createJob/setProvider/fund/submit/settleViaEvaluator,
                  # watchJobLifecycle, reputationHook).
    inft/         # ERC-7857 client + acquisition pipeline + iNFT-sale strategy + demo oracle.
    gateway/      # CCIP-Read gateway (Hono on Bun) + IdentityRegistry indexer.
  scripts/
    sync-abis.ts  # Forge `out/` -> packages/core/src/abis/*.ts
```

## License

MIT.

[axl]: https://github.com/gensyn-ai/axl
[bun]: https://bun.sh
[EIP-3668]: https://eips.ethereum.org/EIPS/eip-3668
[ENSIP-21]: https://docs.ens.domains/ensip/21
