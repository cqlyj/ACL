/**
 * Coordinator HTTP server. Owns the lifecycle of every child process
 * the demo needs:
 *
 *   - 3 AXL bridges (client / provider-security / provider-generalist)
 *   - 2 provider agent processes
 *   - 1 evaluator agent process
 *   - 1 client agent process
 *
 * Web UI talks to this server only:
 *
 *   GET  /                       static UI
 *   GET  /events                 SSE stream of agent events
 *   GET  /api/config             deployment / explorer-prefix metadata
 *   POST /api/event              ingress from child processes
 *   POST /api/start              spawn all child processes
 *   POST /api/run                trigger a job on the client process
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnAxlBridge } from "@acl/agent";
import { type AttestationBundle, type Deliverable, createGalileoClients } from "@acl/core";
import { fetchReputation } from "@acl/discovery";
import { createINftClient } from "@acl/inft";
import { type AclStorage, createAclStorage } from "@acl/storage";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AXL_BRIDGES, PROVIDER_SPECS, config } from "./config.js";
import { KELP_SOURCE_PROVENANCE, KELP_SOURCE_TEXT } from "./source.js";

type ChildName =
  | "axl-client"
  | "axl-provider-security"
  | "axl-provider-generalist"
  | "agent-client"
  | "agent-provider-security"
  | "agent-provider-generalist"
  | "agent-evaluator";

const HERE = import.meta.dir;
const ROOT = resolve(HERE, "..");
const AXL_BIN = config.axlBin;

type ChildHandle = { name: ChildName; child: ChildProcess; startedAt: string };

const children = new Map<ChildName, ChildHandle>();
type CoordinatorEvent = {
  id: number;
  ts: string;
  payload: Record<string, unknown>;
};
let eventCounter = 0;
const recent: CoordinatorEvent[] = [];
const RECENT_LIMIT = 1_000;

const app = new Hono();

// ---------------- static ----------------

app.get("/", async (c) => c.html(await staticFile("index.html")));
app.get("/styles.css", async (c) =>
  c.body(await staticFile("styles.css"), 200, { "Content-Type": "text/css" }),
);

const _SAFE_JS = /^[a-zA-Z0-9_-]+\.js$/;

app.get("/app.js", async (c) =>
  c.body(await staticFile("app.js"), 200, {
    "Content-Type": "application/javascript",
  }),
);
app.get("/lib/:file{.+\\.js$}", async (c) => {
  const file = c.req.param("file");
  if (!_SAFE_JS.test(file)) return c.text("not found", 404);
  return c.body(await staticFile(`lib/${file}`), 200, {
    "Content-Type": "application/javascript",
  });
});
app.get("/panels/:file{.+\\.js$}", async (c) => {
  const file = c.req.param("file");
  if (!_SAFE_JS.test(file)) return c.text("not found", 404);
  return c.body(await staticFile(`panels/${file}`), 200, {
    "Content-Type": "application/javascript",
  });
});

// ---------------- API ----------------

app.get("/api/config", (c) =>
  c.json({
    deployment: {
      galileo: {
        chainId: config.deployment.galileo.chainId,
        agenticCommerce: config.deployment.galileo.agenticCommerce,
        aclEvaluator: config.deployment.galileo.aclEvaluator,
        identityRegistry: config.deployment.galileo.identityRegistry,
        reputationRegistry: config.deployment.galileo.reputationRegistry,
        validationRegistry: config.deployment.galileo.validationRegistry,
        testUSDC: config.deployment.galileo.testUSDC,
        aclAgentNFT: config.deployment.galileo.aclAgentNFT,
        trustedPartyVerifier: config.deployment.galileo.trustedPartyVerifier,
        reputationHook: config.deployment.galileo.reputationHook,
        inftDeliveryHook: config.deployment.galileo.inftDeliveryHook,
      },
      ens: {
        chainId: config.deployment.ens.chainId,
        parentName: config.deployment.ens.parentName,
      },
    },
    providers: {
      security: `${config.providerSecurityEnsLabel}.${config.deployment.ens.parentName}`,
      generalist: `${config.providerGeneralistEnsLabel}.${config.deployment.ens.parentName}`,
    },
    children: Array.from(children.entries()).map(([name, h]) => ({
      name,
      pid: h.child.pid,
      startedAt: h.startedAt,
    })),
    recentEvents: recent,
  }),
);

// ---------------- in-process iNFT key registry ----------------
// Demo-only "oracle custody" surface. The provider
// process POSTs the AES `dataKey` it used to encrypt the agent
// bundle; the buyer process GETs it back to decrypt the on-chain
// ciphertext, then re-encrypts under its own pubkey before driving
// `iTransfer`. Production would replace this with a 0G TeeML
// enclave that signs `OwnershipProof`s without ever exposing keys
// in the clear.

type INftKeyRecord = {
  dataKey: string;
  rootHash: string;
  dataHash: string;
  ensLabel?: string;
  updatedAt: string;
};
const inftKeyRegistry = new Map<string, INftKeyRecord>();

app.post("/api/inft-keys/:tokenId", async (c) => {
  const tokenId = c.req.param("tokenId");
  const body = (await c.req.json().catch(() => ({}))) as Partial<INftKeyRecord>;
  if (!body.dataKey || !body.rootHash || !body.dataHash) {
    return c.json({ ok: false, error: "dataKey, rootHash, dataHash required" }, 400);
  }
  inftKeyRegistry.set(tokenId, {
    dataKey: body.dataKey,
    rootHash: body.rootHash,
    dataHash: body.dataHash,
    ...(body.ensLabel ? { ensLabel: body.ensLabel } : {}),
    updatedAt: new Date().toISOString(),
  });
  return c.json({ ok: true });
});

app.get("/api/inft-keys/:tokenId", (c) => {
  const tokenId = c.req.param("tokenId");
  const record = inftKeyRegistry.get(tokenId);
  if (!record) return c.json({ ok: false, error: "not found" }, 404);
  return c.json(record);
});

// ---------------- 0G Storage proxy ----------------
// Provides the web UI a way to materialise an on-chain `rootHash`
// (deliverable / attestation bundle / task spec) back into bytes.
// We use the SDK's `readOnly: true` mode so the coordinator never
// holds a Flow signer just to fetch — proves we're reading from 0G
// Storage proper, not a local cache.

let _readonlyStorage: AclStorage | null = null;
function readonlyStorage(): AclStorage {
  if (!_readonlyStorage) {
    _readonlyStorage = createAclStorage({ readOnly: true });
  }
  return _readonlyStorage;
}

function isHexRoot(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

app.get("/api/storage/:kind/:rootHash", async (c) => {
  const kind = c.req.param("kind");
  const rootHash = c.req.param("rootHash");
  if (!isHexRoot(rootHash)) {
    return c.json({ ok: false, error: "rootHash must be 0x + 64 hex chars" }, 400);
  }
  try {
    const storage = readonlyStorage();
    const fetchedAt = new Date().toISOString();
    const startedAt = Date.now();
    if (kind === "deliverable") {
      const d: Deliverable = await storage.downloadDeliverable(rootHash);
      return c.json({
        ok: true,
        kind: "deliverable",
        rootHash,
        fetchedAt,
        elapsedMs: Date.now() - startedAt,
        deliverable: d,
      });
    }
    if (kind === "attestation") {
      const a: AttestationBundle = await storage.downloadAttestationBundle(rootHash);
      return c.json({
        ok: true,
        kind: "attestation",
        rootHash,
        fetchedAt,
        elapsedMs: Date.now() - startedAt,
        attestation: a,
      });
    }
    if (kind === "json") {
      const j = await storage.downloadJson(rootHash);
      return c.json({
        ok: true,
        kind: "json",
        rootHash,
        fetchedAt,
        elapsedMs: Date.now() - startedAt,
        body: j,
      });
    }
    if (kind === "text") {
      const t = await storage.downloadString(rootHash);
      return c.json({
        ok: true,
        kind: "text",
        rootHash,
        fetchedAt,
        elapsedMs: Date.now() - startedAt,
        body: t,
      });
    }
    return c.json({ ok: false, error: `unknown kind ${kind}` }, 400);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    return c.json({ ok: false, error: `0G Storage fetch failed: ${message}` }, 502);
  }
});

// ---------------- ERC-8004 reputation passthrough ----------------
// Exposes the on-chain `ACLReputationRegistry.getSummary` for an
// agentId so the web UI can render "before/after settle" feedback
// numbers without baking RPC creds into the browser.

const _reputationClients = createGalileoClients({
  deployment: config.deployment,
});

app.get("/api/reputation/:agentId", async (c) => {
  const raw = c.req.param("agentId");
  if (!/^\d+$/.test(raw)) {
    return c.json({ ok: false, error: "agentId must be a positive integer" }, 400);
  }
  try {
    const summary = await fetchReputation(
      {
        deployment: config.deployment,
        galileoClient: _reputationClients.publicClient,
      },
      BigInt(raw),
    );
    return c.json({
      ok: true,
      agentId: raw,
      reputation: summary
        ? {
            count: summary.count.toString(),
            summaryValue: summary.summaryValue.toString(),
            summaryValueDecimals: summary.summaryValueDecimals,
            normalized: _normaliseReputation(summary),
          }
        : null,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: `reputation fetch failed: ${(err as Error).message}`,
      },
      502,
    );
  }
});

/**
 * Convert ERC-8004's fixed-point `(summaryValue, summaryValueDecimals)`
 * pair into a plain JS `number` in `[0, 1]` for cheap UI rendering.
 * The on-chain layout is `summaryValue / 10^summaryValueDecimals` per
 * ERC-8004 v2.
 */
function _normaliseReputation(s: {
  summaryValue: bigint;
  summaryValueDecimals: number;
}): number {
  const denom = 10n ** BigInt(s.summaryValueDecimals);
  if (denom === 0n) return 0;
  // Convert via string to avoid bigint→number rounding for large
  // numerators; for the demo's single-digit feedback counts this is
  // overkill but harmless.
  return Number(s.summaryValue) / Number(denom);
}

// ---------------- iNFT ownerOf passthrough ----------------

app.get("/api/inft/owner/:contract/:tokenId", async (c) => {
  const contract = c.req.param("contract");
  const tokenId = c.req.param("tokenId");
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    return c.json({ ok: false, error: "contract must be a 0x-prefixed 20-byte address" }, 400);
  }
  if (!/^\d+$/.test(tokenId)) {
    return c.json({ ok: false, error: "tokenId must be a positive integer" }, 400);
  }
  try {
    const nft = createINftClient({
      publicClient: _reputationClients.publicClient,
      deployment: config.deployment,
      contractAddress: contract as `0x${string}`,
    });
    const owner = await nft.ownerOf(BigInt(tokenId));
    return c.json({
      ok: true,
      owner,
      contract,
      tokenId,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({ ok: false, error: `ownerOf failed: ${(err as Error).message}` }, 502);
  }
});

app.post("/api/event", async (c) => {
  const body = (await c.req.json()) as {
    source?: string;
    event?: Record<string, unknown>;
  };
  if (!body.event) return c.text("missing event", 400);
  recordEvent({ source: body.source ?? "unknown", event: body.event });
  return c.text("ok");
});

app.post("/api/start", async (c) => {
  if (children.size > 0) {
    return c.json({ ok: false, error: "children already running" }, 409);
  }
  await spawnAll();
  return c.json({ ok: true, started: Array.from(children.keys()) });
});

app.post("/api/run", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    brief?: string;
    maxBudget?: string;
    sourceMaterial?: unknown;
  };
  const brief = body.brief?.trim();
  const maxBudget = body.maxBudget;
  if (!brief || !maxBudget)
    return c.json({ ok: false, error: "brief and maxBudget required" }, 400);
  const client = children.get("agent-client");
  if (!client?.child.stdin) return c.json({ ok: false, error: "client not running" }, 409);

  // Prefer the explicit body.sourceMaterial if the caller passes one,
  // otherwise fall back to the demo's pre-uploaded Kelp DAO article.
  // Only emit `rootHash` when the upload script has populated it —
  // sending `rootHash: undefined` over the wire is wasted bytes and
  // confuses TaskSpec consumers that null-check the field.
  const fallbackRoot = config.kelpSourceRoot();
  const sourceMaterial = body.sourceMaterial ?? {
    provenance: KELP_SOURCE_PROVENANCE,
    text: KELP_SOURCE_TEXT,
    ...(fallbackRoot ? { rootHash: fallbackRoot } : {}),
  };
  // Derive the discovery domain filter from the demo's provider
  // catalogue so adding a new flavour to PROVIDER_SPECS automatically
  // widens the client's discovery without a parallel edit here.
  const allowedDomains = [...new Set(Object.values(PROVIDER_SPECS).flatMap((s) => s.taskDomains))];
  const envelope = {
    action: "runJob",
    input: {
      brief,
      maxBudget,
      sourceMaterial,
      allowedDomains,
    },
  };
  client.child.stdin.write(`${JSON.stringify(envelope)}\n`);
  recordEvent({
    source: "coordinator",
    event: {
      type: "log",
      agentRole: "client",
      level: "info",
      message: "job dispatched",
      at: new Date().toISOString(),
    },
  });
  return c.json({ ok: true });
});

app.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    for (const ev of recent) {
      await stream.writeSSE({
        id: String(ev.id),
        data: JSON.stringify({ ts: ev.ts, ...ev.payload }),
      });
    }
    const sub = subscribe((ev) => {
      stream
        .writeSSE({
          id: String(ev.id),
          data: JSON.stringify({ ts: ev.ts, ...ev.payload }),
        })
        .catch(() => {});
    });
    await new Promise<void>((res) => {
      stream.onAbort(() => {
        sub();
        res();
      });
    });
  }),
);

const sseListeners = new Set<(ev: CoordinatorEvent) => void>();
function subscribe(listener: (ev: CoordinatorEvent) => void): () => void {
  sseListeners.add(listener);
  return () => sseListeners.delete(listener);
}

function recordEvent(payload: Record<string, unknown>): void {
  eventCounter += 1;
  const ev: CoordinatorEvent = {
    id: eventCounter,
    ts: new Date().toISOString(),
    payload,
  };
  recent.push(ev);
  if (recent.length > RECENT_LIMIT) recent.shift();
  for (const listener of sseListeners) listener(ev);
}

// ---------------- child-process orchestration ----------------

async function staticFile(name: string): Promise<string> {
  const filePath = resolve(HERE, "web", name);
  return Bun.file(filePath).text();
}

async function spawnAll(): Promise<void> {
  const axlDir = resolve(ROOT, ".axl");
  mkdirSync(axlDir, { recursive: true });

  // 3 AXL bridges, mesh-peered. Each peers to the other two over TLS
  // (their unique `listenPort`). The overlay `tcp_port` is shared and
  // is set per-bridge via `spawnAxlBridge`.
  const tlsPeers = (skipListenPort: number) =>
    Object.values(AXL_BRIDGES)
      .filter((b) => b.listenPort !== skipListenPort)
      .map((b) => `tls://127.0.0.1:${b.listenPort}`);

  // Slugs match `setup:providers` so the on-chain peer id (written
  // to ACLIdentityRegistry by register-providers.ts) and the runtime
  // peer id (boot from the same .axl/<slug>.pem file) stay aligned.
  await Promise.all([
    bootBridge(
      "axl-client",
      "client",
      AXL_BRIDGES.client,
      tlsPeers(AXL_BRIDGES.client.listenPort),
      axlDir,
    ),
    bootBridge(
      "axl-provider-security",
      config.providerSecurityEnsLabel,
      AXL_BRIDGES.providerSecurity,
      tlsPeers(AXL_BRIDGES.providerSecurity.listenPort),
      axlDir,
    ),
    bootBridge(
      "axl-provider-generalist",
      config.providerGeneralistEnsLabel,
      AXL_BRIDGES.providerGeneralist,
      tlsPeers(AXL_BRIDGES.providerGeneralist.listenPort),
      axlDir,
    ),
  ]);

  spawnAgent("agent-evaluator", "src/agents/evaluator-process.ts");
  spawnAgent("agent-provider-security", "src/agents/provider-process.ts", ["security"]);
  spawnAgent("agent-provider-generalist", "src/agents/provider-process.ts", ["generalist"]);
  // Client last so the rest of the mesh is up.
  await delay(2_000);
  spawnAgent("agent-client", "src/agents/client-process.ts", [], {
    pipeStdin: true,
  });
}

/**
 * Boot a single AXL bridge through {@link spawnAxlBridge} (the SDK
 * helper). Adds the spawned child to the coordinator's `children` map
 * so `attach(...)` can stream its stdout/stderr into the SSE feed
 * along with every other process.
 */
async function bootBridge(
  name: ChildName,
  agentSlug: string,
  bridge: { apiPort: number; listenPort: number; tcpPort: number },
  peers: string[],
  axlDir: string,
): Promise<void> {
  const cfgPath = join(axlDir, `${agentSlug}.config.json`);
  const keyPath = join(axlDir, `${agentSlug}.pem`);
  const { child } = await spawnAxlBridge({
    axlBin: AXL_BIN,
    apiPort: bridge.apiPort,
    tcpPort: bridge.tcpPort,
    listenPort: bridge.listenPort,
    apiHost: "127.0.0.1",
    peers,
    peerKeyPath: keyPath,
    configPath: cfgPath,
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  attach(name, child);
}

function spawnAgent(
  name: ChildName,
  scriptPath: string,
  args: string[] = [],
  opts: { pipeStdin?: boolean } = {},
): void {
  const child = spawn("bun", ["run", scriptPath, ...args], {
    cwd: ROOT,
    stdio: [opts.pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
    env: process.env,
  });
  attach(name, child);
  if (name === "agent-client") {
    child.stdout?.on("data", (chunk) => {
      const lines = chunk.toString("utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const evt = JSON.parse(line);
          recordEvent({ source: "client-stdout", event: evt });
        } catch {
          recordEvent({
            source: "client-stdout",
            event: {
              type: "log",
              agentRole: "client",
              level: "info",
              message: line,
              at: new Date().toISOString(),
            },
          });
        }
      }
    });
  }
}

function attach(name: ChildName, child: ChildProcess): void {
  const startedAt = new Date().toISOString();
  children.set(name, { name, child, startedAt });
  child.stdout?.on("data", (b) => process.stdout.write(`[${name}] ${b}`));
  child.stderr?.on("data", (b) => process.stderr.write(`[${name}] ${b}`));
  child.on("exit", (code) => {
    children.delete(name);
    recordEvent({
      source: "coordinator",
      event: {
        type: "log",
        agentRole: "client",
        level: "warn",
        message: `child ${name} exited code=${code}`,
        at: new Date().toISOString(),
      },
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

const port = config.port;
console.log(`[coordinator] listening on http://127.0.0.1:${port}`);

Bun.serve({
  port,
  fetch: app.fetch,
  idleTimeout: 0,
});

/**
 * Coordinator shutdown protocol:
 *
 *   1. Send SIGINT to every child (graceful: bun agents tear down
 *      their event listeners; the AXL `node` Go binary calls
 *      `Stopping...` and closes its TLS listener).
 *   2. Wait up to {@link CHILD_SIGINT_GRACE_MS} for them to exit.
 *   3. SIGKILL any survivor so the AXL TLS ports are freed before
 *      the coordinator dies; without this, a hung Go binary lingers
 *      as an orphan and the *next* coordinator boot gets
 *      `bind: address already in use` on 9201/9202/9203.
 */
const CHILD_SIGINT_GRACE_MS = 1_500;

let _shuttingDown = false;
async function shutdown(): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  const handles = Array.from(children.values());
  for (const h of handles) {
    try {
      h.child.kill("SIGINT");
    } catch {
      // ignore
    }
  }
  await Promise.race([
    Promise.all(
      handles.map(
        (h) =>
          new Promise<void>((res) => {
            if (h.child.exitCode !== null || h.child.signalCode) return res();
            h.child.once("exit", () => res());
          }),
      ),
    ),
    delay(CHILD_SIGINT_GRACE_MS),
  ]);
  for (const h of handles) {
    if (h.child.exitCode === null && !h.child.signalCode) {
      try {
        h.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  process.exit(0);
}
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
