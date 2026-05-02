#!/usr/bin/env -S bun run
/**
 * `acl-axl` — friendly wrapper around the AXL `node` binary
 * (https://github.com/gensyn-ai/axl) that:
 *
 *   - validates AXL configuration before launching so the operator gets
 *     a clear error instead of an opaque Go panic,
 *   - polls the bridge HTTP API on startup and prints the public peer
 *     id (the value the agent must publish in its `acl.axl-peer-id`
 *     ENS metadata).
 *
 * Why a thin shim and not a full lifecycle manager? Operator-facing
 * AXL config (peer key path, listen address, bootstrap peers, ports)
 * is environment-specific. We spawn the binary verbatim and just front
 * the most common foot-guns.
 *
 * Usage:
 *   acl-axl                                   # use defaults
 *   AXL_CONFIG=./node-config.json acl-axl     # custom config
 *   AXL_BIN=/abs/path/to/node acl-axl         # alternate binary
 *
 * Default config (when AXL_CONFIG is unset and no config in cwd):
 *   - api_port:        AXL_API_PORT  (default 9002)
 *   - tcp_port:        AXL_TCP_PORT  (default 9201)
 *   - PrivateKeyPath:  AXL_PEER_KEY  (default ./private.pem)
 *   - Peers:           AXL_PEERS     (csv, default empty)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_AXL_API_HOST,
  DEFAULT_AXL_API_PORT,
  DEFAULT_AXL_CONFIG_PATH,
  DEFAULT_AXL_PEER_KEY,
  DEFAULT_AXL_TCP_PORT,
  writeAxlConfig,
} from "../src/bootstrap/axl-config.js";
import { AXL_TOPOLOGY_POLL_TIMEOUT_MS, pollAxlPeerId } from "../src/bootstrap/axl-peer.js";
import { DEFAULT_AXL_BIN, ensurePeerKey } from "../src/bootstrap/spawn-axl.js";

const AXL_BIN = process.env.AXL_BIN ?? DEFAULT_AXL_BIN;
const API_PORT = process.env.AXL_API_PORT ?? String(DEFAULT_AXL_API_PORT);
const TCP_PORT = process.env.AXL_TCP_PORT ?? String(DEFAULT_AXL_TCP_PORT);
const API_HOST = process.env.AXL_API_HOST ?? DEFAULT_AXL_API_HOST;
const PEER_KEY = process.env.AXL_PEER_KEY ?? DEFAULT_AXL_PEER_KEY;
const PEERS = (process.env.AXL_PEERS ?? "").split(",").filter(Boolean);
const CONFIG_PATH = process.env.AXL_CONFIG ?? DEFAULT_AXL_CONFIG_PATH;

const apiUrl = `http://${API_HOST}:${API_PORT}`;

const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function main() {
  const cfgPath = resolve(CONFIG_PATH);
  // Always ensure the ed25519 peer key exists before launching AXL —
  // the Go binary refuses to boot without it. `ensurePeerKey` is
  // idempotent so re-runs against an already-initialised directory
  // are free.
  const peerKeyPath = resolve(PEER_KEY);
  ensurePeerKey(peerKeyPath);
  if (!existsSync(cfgPath)) {
    writeAxlConfig(cfgPath, {
      PrivateKeyPath: PEER_KEY,
      Peers: PEERS,
      Listen: [`tls://0.0.0.0:${TCP_PORT}`],
      api_port: Number(API_PORT),
      tcp_port: Number(TCP_PORT),
      bridge_addr: API_HOST,
    });
    console.log(dim(`acl-axl: wrote default config to ${cfgPath}`));
  } else {
    console.log(dim(`acl-axl: using existing ${cfgPath}`));
    try {
      JSON.parse(readFileSync(cfgPath, "utf8"));
    } catch (err) {
      console.error(red(`acl-axl: ${cfgPath} is not valid JSON: ${(err as Error).message}`));
      process.exit(2);
    }
  }

  console.log(`acl-axl: launching ${AXL_BIN} -config ${cfgPath} (api=${apiUrl})`);
  const child = spawn(AXL_BIN, ["-config", cfgPath], { stdio: "inherit" });
  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(red(`acl-axl: ${AXL_BIN} binary not found.`));
      console.error(dim("Build the AXL binary from https://github.com/gensyn-ai/axl"));
      console.error(dim("  go build -o node ./cmd/node/  (binary is literally named `node`)"));
      console.error(dim("Then either drop it in cwd or set AXL_BIN to its absolute path."));
      console.error(dim("If AXL_BIN points at Node.js, the bridge will boot Node.js against"));
      console.error(dim("a JSON config and crash with a JS stack trace — set AXL_BIN to the"));
      console.error(dim("AXL Go binary, NOT the Node.js executable."));
      process.exit(127);
    }
    throw err;
  });
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  const peerId = await pollAxlPeerId(apiUrl, AXL_TOPOLOGY_POLL_TIMEOUT_MS);
  if (peerId === null) {
    console.error(
      red(`acl-axl: bridge did not surface a peer id within ${AXL_TOPOLOGY_POLL_TIMEOUT_MS}ms.`),
    );
    console.error(dim("Did you accidentally point AXL_BIN at Node.js? The AXL binary is the"));
    console.error(dim("Go binary built from https://github.com/gensyn-ai/axl (literally named"));
    console.error(dim("`node` after `go build -o node ./cmd/node/`)."));
    return;
  }
  console.log(`\nacl-axl: bridge up.\n  api    = ${apiUrl}\n  peerId = ${peerId}\n`);
}

main().catch((err) => {
  console.error(red(`acl-axl: fatal: ${(err as Error).message}`));
  process.exit(1);
});
