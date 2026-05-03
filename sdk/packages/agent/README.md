# `@acl/agent`

Umbrella package for the ACL SDK. Three responsibilities:

1. **First-class agent classes** — `ClientAgent`, `ProviderAgent`,
   `EvaluatorAgent` (plus `createDefaultEvaluator()`). LLM-driven,
   configurable, autonomous. This is the recommended surface for app
   developers building any agent on top of ERC-8183.
2. **Bootstrap helpers** — `spawnAxlBridge()`, `bootstrapAxl()`,
   `registerAclAgent()`, `ensureEvaluatorOperator()`, and the
   `acl-axl` CLI shim around the Gensyn AXL `node` binary. They
   collapse the "wire up AXL + register on ENS + authorise the
   evaluator" boilerplate into a few lines.
3. **Primitive re-exports** + `createAgentRuntime` — every export from
   `@acl/core`, `@acl/discovery`, `@acl/negotiation`, `@acl/storage`,
   `@acl/evaluation`, `@acl/settlement`, and `@acl/inft` is
   re-published here, plus the chain-wiring kernel that bridges viem
   (Galileo + Sepolia), an ethers signer (for the 0G SDKs), and
   `AclStorage`.

## Minimal end-to-end agent (CLI)

A complete autonomous seller in one file — spawns its own AXL node
(separate process from the buyer's), runs the LLM, drafts the
deliverable, settles on chain. Pair with the `ClientAgent` snippet
in [`examples/quickstart`](../../../examples/quickstart) for the buyer
side.

```ts
// provider.ts (~30 lines)
import {
  ProviderAgent,
  createZGRouterBackend,
  spawnAxlBridge,
  ACL_TESTNET,
} from "@acl/agent";

const { child: bridge } = await spawnAxlBridge({
  apiPort: 9111,
  listenPort: 9211,
  peers: ["tls://127.0.0.1:9212"], // client's listen port
  peerKeyPath: ".axl/provider.pem",
  configPath: ".axl/provider.config.json",
});

const agent = new ProviderAgent({
  account: process.env.PROVIDER_PRIVATE_KEY as `0x${string}`,
  llm: createZGRouterBackend({
    apiKey: process.env.ZG_ROUTER_API_KEY!,
    model: "qwen-2.5-7b-instruct",
  }),
  axlApiUrl: "http://127.0.0.1:9111",
  ensName: "researcher.acl.eth",
  acceptPolicy: {
    minBudget: 50_000_000n, // 50 testUSDC
    taskDomains: ["research", "writing"],
    paymentTokens: [ACL_TESTNET.galileo.testUSDC],
  },
  persona: "You are a senior research analyst…",
});

agent.events.on(console.log); // structured event bus
await agent.start();
process.on("SIGINT", () => {
  agent.stop();
  bridge.kill("SIGINT");
  process.exit(0);
});
```

`spawnAxlBridge` shells out to the Gensyn AXL `node` Go binary
(built from [`gensyn-ai/axl`](https://github.com/gensyn-ai/axl) via
`go build -o node ./cmd/node/`), generates the ed25519 peer key
idempotently, writes `node-config.json`, and polls `/topology` until
a peer id surfaces. Each agent process spawns its own bridge —
that's what gives the demo "communication across separate AXL nodes"
rather than a single in-process channel.

For the buyer side and the full 4-terminal Makefile flow, see
[`examples/quickstart`](../../../examples/quickstart).

## Agent classes

```ts
import {
  ClientAgent,
  ProviderAgent,
  createDefaultEvaluator,
  createZGRouterBackend,
} from "@acl/agent";

// Provider — listens for AXL proposals + on-chain JobFunded events.
const provider = new ProviderAgent({
  account: process.env.PROVIDER_PRIVATE_KEY as `0x${string}`,
  llm: createZGRouterBackend({
    apiKey: process.env.ZG_ROUTER_API_KEY!,
    model: "qwen-2.5-7b-instruct",
  }),
  axlApiUrl: "http://127.0.0.1:9002",
  ensName: "researcher.acl.eth",
  acceptPolicy: {
    minBudget: 50_000_000n, // 50 testUSDC (6 decimals)
    taskDomains: ["research", "writing"],
    paymentTokens: [process.env.TUSDC as `0x${string}`],
    maxConcurrentJobs: 1, // serialise the wallet (default)
  },
  persona: "You are a senior research analyst…",
});
await provider.start();

// Client — runJob() does discovery → AXL negotiation → settlement.
const client = new ClientAgent({
  account: process.env.CLIENT_PRIVATE_KEY as `0x${string}`,
  llm: createZGRouterBackend({
    apiKey: process.env.ZG_ROUTER_API_KEY!,
    model: "qwen-2.5-7b-instruct",
  }),
  axlApiUrl: "http://127.0.0.1:9012",
  gatewayUrl: process.env.GATEWAY_URL!,
});
await client.start();
const result = await client.runJob({
  brief: "Write a research report comparing two consensus mechanisms.",
  maxBudget: 100_000_000n,
  // openingBudget is optional. When omitted, the client opens at the
  // midpoint of [provider.minBudget, maxBudget] which leaves room for
  // the provider to COUNTER for fair value and for the client to ACCEPT
  // within maxBudget. Pass an explicit value to skip the midpoint.
  // openingBudget: 60_000_000n,
});

// Default evaluator — in-process, 0G Compute Direct, on-chain TEE-verified.
const evaluator = await createDefaultEvaluator({
  account: process.env.EVALUATOR_OPERATOR_PRIVATE_KEY as `0x${string}`,
});
```

`createDefaultEvaluator()` is the zero-config path: it watches
`AgenticCommerce.JobSubmitted`, runs 0G Compute Direct inference,
captures the TEE-signed payload, uploads the attestation bundle, and
calls `ACLEvaluator.settle()` with the raw `(signedText,
teeSignature, computeProvider)` triple — `ACLEvaluator` then
`ecrecover`s the signature against the TEE signer registered in
`InferenceServing.getService(provider)` and rejects replays.

If you'd rather run your own evaluator, `EvaluatorAgent` exposes the
same surface and accepts a custom `computeProvider` / `modelMatch`
policy (the 0G Compute provider override + substring/RegExp model
filter forwarded to `@acl/evaluation`). Pair it with `ensureEvaluatorOperator(...)` —
exported from `@acl/agent` — to idempotently authorise the
operator address on `ACLEvaluator` from the contract owner key
before the agent starts, so a fresh demo wallet boots cleanly
without a manual `setOperator` step.

## Bootstrap helpers

| Helper                             | What it does                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawnAxlBridge({ ... })`          | Programmatic spawner: launches the Gensyn AXL `node` Go binary as a child process, generates the ed25519 peer key (`openssl genpkey -algorithm ed25519`), writes `node-config.json`, polls `/topology`, returns `{ child, apiUrl, peerId }`. Surfaces `ENOENT` cleanly on the canonical "AXL binary not on `$PATH`" foot-gun. |
| `bootstrapAxl({ apiUrl })`         | Wait for an already-running AXL bridge to come up, return its public peer id. Use when bridge lifecycle is owned externally (Docker, systemd, etc.).                                                                                                                                                                          |
| `registerAclAgent({ ... })`        | Mint an agent in `ACLIdentityRegistry` and sequentially write the canonical `acl.*` metadata entries (one `setMetadata` tx per key, each pinned to an explicit pending-nonce). Idempotent — pass `existingAgentId` to skip `register()` and only re-write metadata.                                                           |
| `ensureEvaluatorOperator({ ... })` | Idempotent `setOperator` for `ACLEvaluator`. Reads current authorisation first; only writes when not already authorised.                                                                                                                                                                                                      |
| `bin/acl-axl`                      | CLI shim around the same machinery as `spawnAxlBridge`. `bunx acl-axl` boots a single bridge with sane defaults — useful from `bun x` / npm scripts where you don't want to depend on the SDK's process supervision.                                                                                                          |

`acl-axl` is exposed as a `bin` entry — install the package and run
`bunx acl-axl` to start a bridge with sane defaults. (Use `bunx`, not
`npx` — the entry is a `.ts` file and needs Bun as its runtime.)

## `LLMBackend`

The agent classes call into a small backend interface:

```ts
interface LLMBackend {
  readonly modelId: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
}
```

`@acl/agent` ships two implementations:

- `createOpenAICompatibleBackend({ baseUrl, apiKey, model })` — any
  OpenAI-style `/v1/chat/completions` endpoint.
- `createZGRouterBackend({ apiKey, model })` — wraps the 0G Compute
  Router. Adds the optional `Verify-Tee` header when the consumer
  sets `verifyTee: true` to ask for TEE-attested responses (the
  evaluator does this automatically through `@acl/evaluation`'s
  direct broker, not through the router).

Plug in any other backend by implementing `LLMBackend` yourself.

## Lower-level kernel

If the agent classes don't fit, compose the primitives directly:

```ts
import { createAgentRuntime } from "@acl/agent";

const runtime = createAgentRuntime({
  account: process.env.PROVIDER_PRIVATE_KEY as `0x${string}`,
});
//  runtime.publicClient / walletClient / ensClient / chain /
//  deployment / account / address / galileoRpcUrl / ethersSigner /
//  storage — pass them to any primitive (resolver, negotiator,
//  storage, evaluator, settlement orchestrator).
```

## `AgentRuntimeOptions`

| Option              | Default                                      | Meaning                                                            |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `account`           | (required)                                   | `0x` private key OR a viem `LocalAccount`.                         |
| `deployment`        | `ACL_TESTNET`                                | Pinned ACL deployment.                                             |
| `galileoRpcUrl`     | `deployment.galileo.rpcUrl`                  | Override the 0G Galileo RPC.                                       |
| `sepoliaRpcUrl`     | `SEPOLIA_PUBLIC_RPC_URL`                     | Override the ENS host RPC.                                         |
| `storageIndexerUrl` | `ZG_STORAGE_TURBO_INDEXER`                   | Override the 0G Storage indexer.                                   |
| `ethersSigner`      | derived from `account` if it's a private key | Required when `account` is a non-private-key viem account.         |
| `transportOptions`  | `DEFAULT_TRANSPORT_*` constants              | Tune retry count / delay / timeout for the Galileo HTTP transport. |
| `pollingIntervalMs` | `DEFAULT_POLLING_INTERVAL_MS`                | viem `PublicClient` polling cadence.                               |
| `gasFeeOverrides`   | derived from chain (EIP-1559)                | Per-write gas/fee overrides threaded into `createGalileoClients`; set `{ type: 'legacy', gasPrice }` on chains without EIP-1559. |

The same field set is reused by every per-role agent config (every
agent class inherits from `AgentRuntimeOverrides`), and the helper
`pickRuntimeOverrides(config)` is exported for consumers that build
the runtime themselves but still want the agents' override semantics.

## Negotiation strategy

### Multi-provider fallback

The discovery → ranking step returns an **ordered** list of candidate
ENS names (best-first per the LLM, with the gateway's reputation
ordering as the deterministic fallback when the LLM output is
unparseable). `ClientAgent.runJob` walks that list with the helper
`_negotiateOnce` per attempt: a single PROPOSE → (optional COUNTER →
ACCEPT) round against one provider. REJECT, AXL recv timeout, or
EIP-712 signature verification failure ends the attempt and the loop
falls through to the next-ranked candidate. The walk is bounded by
`ClientAgentConfig.maxNegotiationAttempts` (default
`DEFAULT_MAX_NEGOTIATION_ATTEMPTS = 3`).

Each attempt emits a `negotiation.attempt` event; failed attempts emit
`negotiation.failed` with the underlying reason so a UI can surface
"tried provider A, fell through to provider B".

`Negotiator.waitForOneOf` is called with `replyToId` set to the local
PROPOSE id, so a stale ACCEPT/COUNTER from a previous round (e.g. a
provider that reconnected late) is recorded in the transcript but does
not satisfy the current wait.

### Opening budget

`runJob({ maxBudget })` does NOT open at the maximum: by default the
client opens at the **midpoint** of `[provider.minBudget, maxBudget]`,
exposed as the helper `pickOpeningBudget({ maxBudget, providerMinBudget,
openingBudget? })`. The reasoning is twofold:

1. Opening at `maxBudget` always trivially ACCEPTs and skips the AXL
   COUNTER round entirely — the negotiation primitive becomes dead
   weight. Midpoint leaves room for a meaningful round.
2. The bundled `PROVIDER_DECIDE_PROMPT` knows to COUNTER for a fair
   uplift on substantial tasks when the proposal sits between 1.0× and
   1.5× the provider's minimum, and the bundled
   `CLIENT_NEGOTIATE_RESPONSE_PROMPT` accepts any counter at-or-below
   `maxBudget` whose stated rationale matches the brief.

Override per call when you need different semantics:

```ts
await client.runJob({
  brief: "...",
  maxBudget: 100_000_000n,
  openingBudget: 100_000_000n, // skip negotiation, open at the cap
});

await client.runJob({
  brief: "...",
  maxBudget: 100_000_000n,
  openingBudget: provider.minBudget, // aggressive low-ball
});
```

`openingBudget` is validated to lie in `[provider.minBudget, maxBudget]`
(an out-of-range value throws synchronously before any AXL traffic).

## Worked example

[`examples/kelp-postmortem/`](../../../examples/kelp-postmortem) is a
reference app that runs all three agent classes end-to-end against
Galileo testnet behind a coordinator HTTP server with a live
timeline, clickable explorer links, and the `[Start agents]` /
`[Run job]` buttons that drive the demo. The brief used in that app
is incidental — `@acl/agent` itself has no awareness of any
particular task domain (see `DEFAULT_ALLOWED_DOMAINS` for the broad
neutral set the client falls back to when the caller passes none).
