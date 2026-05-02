/**
 * `spawnAxlBridge` — programmatic spawner for the Gensyn AXL bridge
 * (https://github.com/gensyn-ai/axl). Centralises the operator
 * foot-guns the CLI shim already covers (binary collision with
 * Node.js, peer-id polling, JSON config validation) AND adds two
 * extras the example coordinator needs:
 *
 *   1. Explicit `peers: string[]` so callers can wire a multi-bridge
 *      mesh (`tls://127.0.0.1:920X` URIs); the CLI shim only handles
 *      the single-bridge case.
 *   2. Returns the spawned `child` so the caller manages lifecycle.
 *
 * The CLI binary (`bin/acl-axl.ts`) keeps the operator-friendly
 * stderr formatting; this helper keeps the caller-friendly programmatic
 * surface. Both share the same defaults to avoid drift.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  DEFAULT_AXL_API_HOST,
  DEFAULT_AXL_API_PORT,
  DEFAULT_AXL_CONFIG_PATH,
  DEFAULT_AXL_PEER_KEY,
  DEFAULT_AXL_TCP_PORT,
  writeAxlConfig,
} from "./axl-config.js";
import { AXL_TOPOLOGY_POLL_TIMEOUT_MS, pollAxlPeerId } from "./axl-peer.js";

/**
 * Default path the SDK looks for the AXL `node` binary at. We use
 * `./node` (relative path) instead of a bare `node` to dodge the
 * collision with the Node.js executable on operator $PATH layouts —
 * the AXL binary built from https://github.com/gensyn-ai/axl is
 * literally named `node` (`go build -o node ./cmd/node/`).
 */
export const DEFAULT_AXL_BIN = "./node";

export type SpawnAxlBridgeInput = {
  /**
   * Path to the AXL `node` binary. Defaults to `./node` to dodge the
   * collision with the Node.js executable on operator $PATH layouts.
   * Override with the absolute path when running from CI / tests.
   */
  axlBin?: string;
  /** AXL HTTP API port (`api_port`). Default 9002. */
  apiPort?: number;
  /** AXL TCP overlay port (`tcp_port`). Default 9201. */
  tcpPort?: number;
  /**
   * AXL TLS listen port (the per-bridge port the mesh peers point at).
   * Defaults to {@link tcpPort} if unset — for a single-bridge run
   * that's correct; in a mesh you MUST give every bridge its own
   * `listenPort`.
   */
  listenPort?: number;
  /** Bind address of the API + bridge_addr field. Default `127.0.0.1`. */
  apiHost?: string;
  /**
   * Peer URIs for the mesh, e.g. `tls://127.0.0.1:9202`. Empty array
   * is fine for a standalone bridge.
   */
  peers?: string[];
  /** Path to the bridge's PEM private key. Default `./private.pem`. */
  peerKeyPath?: string;
  /** Where to write the generated `node-config.json`. Default `./node-config.json`. */
  configPath?: string;
  /**
   * Extra environment variables to merge into the spawned process.
   * Useful when the AXL binary picks up Go-side env vars
   * (e.g. `GOMAXPROCS`).
   */
  env?: Record<string, string>;
  /**
   * Spawn cwd. Defaults to `process.cwd()`. Useful when the binary is
   * resolved relative (e.g. `./node`) and the caller wants to scope
   * the spawn to a specific directory.
   */
  cwd?: string;
  /**
   * `child_process.spawn` `stdio` argument. Defaults to `'inherit'` so
   * AXL's stdout streams to the operator's terminal. Set to `'pipe'`
   * (or `['ignore','pipe','pipe']`) to capture the output in tests.
   */
  stdio?: "inherit" | "pipe" | "ignore" | Array<"pipe" | "inherit" | "ignore">;
};

export type SpawnAxlBridgeResult = {
  /** Spawned child process — caller owns lifecycle. */
  child: ChildProcess;
  /** HTTP API URL for the bridge (`http://host:apiPort`). */
  apiUrl: string;
  /** Public peer id reported by `/topology.our_public_key`. */
  peerId: string;
};

/**
 * Spawn an AXL bridge and resolve once it's reporting a peer id.
 *
 * Throws on:
 *   - missing binary (ENOENT — likely `axlBin` collision with Node.js),
 *   - bridge that fails to surface a peer id within 30s (likely
 *     `axlBin` actually points at Node.js, not the AXL Go binary).
 *
 * The caller is responsible for `child.kill()` on shutdown.
 */
export async function spawnAxlBridge(
  input: SpawnAxlBridgeInput = {},
): Promise<SpawnAxlBridgeResult> {
  const axlBin = input.axlBin ?? DEFAULT_AXL_BIN;
  const apiPort = input.apiPort ?? DEFAULT_AXL_API_PORT;
  const tcpPort = input.tcpPort ?? DEFAULT_AXL_TCP_PORT;
  const listenPort = input.listenPort ?? tcpPort;
  const apiHost = input.apiHost ?? DEFAULT_AXL_API_HOST;
  const peerKeyPath = resolve(input.peerKeyPath ?? DEFAULT_AXL_PEER_KEY);
  const configPath = resolve(input.configPath ?? DEFAULT_AXL_CONFIG_PATH);
  const apiUrl = `http://${apiHost}:${apiPort}`;

  ensurePeerKey(peerKeyPath);
  writeAxlConfig(configPath, {
    PrivateKeyPath: peerKeyPath,
    Peers: input.peers ?? [],
    Listen: [`tls://0.0.0.0:${listenPort}`],
    api_port: apiPort,
    tcp_port: tcpPort,
    bridge_addr: apiHost,
  });

  // The Bun-only `@types/bun` ChildProcess shape doesn't expose the
  // EventEmitter `on/once` overloads — cast to a narrow interface that
  // only declares the two events we actually subscribe to. Keeps the
  // shape strictly typed without pulling in `@types/node`.
  const child = spawn(axlBin, ["-config", configPath], {
    stdio: input.stdio ?? "inherit",
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    env: { ...process.env, ...(input.env ?? {}) },
  }) as ChildProcess & {
    on(event: "error", listener: (err: Error) => void): unknown;
    on(
      event: "exit",
      listener: (code: number | null, signal: string | null) => void,
    ): unknown;
  };

  // Surface the most common foot-gun (binary not on disk / wrong
  // executable) early — without this the caller would see an opaque
  // ENOENT promise rejection and a process that "started" but never
  // surfaces a peer id. We race the spawn-error and early-exit signals
  // against the peer-id poll so any of them rejects the outer promise
  // instead of escaping as an unhandled error.
  let settled = false;
  const spawnFailure = new Promise<never>((_resolve, reject) => {
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if ((err as { code?: string }).code === "ENOENT") {
        reject(
          new Error(
            `@acl/agent: AXL binary not found at ${axlBin}. Build it from https://github.com/gensyn-ai/axl (\`go build -o node ./cmd/node/\`) and either drop it in cwd or pass an absolute axlBin.`,
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `@acl/agent: AXL bridge (${axlBin}) exited before reporting a peer id (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ),
      );
    });
  });

  let peerId: string | null;
  try {
    peerId = await Promise.race([
      pollAxlPeerId(apiUrl, AXL_TOPOLOGY_POLL_TIMEOUT_MS),
      spawnFailure,
    ]);
    settled = true;
  } catch (err) {
    settled = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore — child may already be gone
    }
    throw err;
  }
  if (peerId === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(
      `@acl/agent: AXL bridge at ${apiUrl} did not surface a peer id within ${AXL_TOPOLOGY_POLL_TIMEOUT_MS}ms. Likely cause: \`axlBin\` (${axlBin}) points at Node.js instead of the Gensyn AXL Go binary. Set \`axlBin\` to the absolute path of the AXL \`node\` binary.`,
    );
  }
  return { child, apiUrl, peerId };
}

/**
 * Generate an ed25519 PEM private key at `peerKeyPath` if one does not
 * already exist. AXL refuses to boot without it, so this is the
 * first-run idempotency primitive every bridge spawner needs. Exported
 * so the `bin/acl-axl` CLI shim shares the same code path as
 * {@link spawnAxlBridge}; otherwise a fresh `npx acl-axl` would crash
 * the AXL Go binary with a missing-key error.
 */
export function ensurePeerKey(peerKeyPath: string): void {
  if (existsSync(peerKeyPath)) return;
  mkdirSync(dirname(peerKeyPath), { recursive: true });
  const r = spawnSync("openssl", [
    "genpkey",
    "-algorithm",
    "ed25519",
    "-out",
    peerKeyPath,
  ]);
  if (r.status !== 0) {
    throw new Error(
      `@acl/agent: openssl genpkey failed for ${peerKeyPath}: ${
        r.stderr?.toString() ?? "(no stderr)"
      }`,
    );
  }
}
