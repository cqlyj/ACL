/**
 * Shared defaults and helpers for generating an AXL `node-config.json`.
 *
 * The CLI shim (`bin/acl-axl.ts`) and the programmatic spawner
 * (`spawn-axl.ts`) used to maintain near-identical copies of the same
 * config-writer; that drift has bitten us once already (CLI silently
 * dropped `bridge_addr`, `spawnAxlBridge` had it, mesh diff'd against
 * the file diverged). This module is the single source of truth — both
 * call sites import these constants and {@link writeAxlConfig}.
 *
 * The Yggdrasil base fields stay PascalCase (`PrivateKeyPath` /
 * `Peers` / `Listen`); the AXL extension fields stay snake_case
 * (`api_port` / `tcp_port` / `bridge_addr`). Don't "normalise" the
 * casing — that's what the AXL Go binary actually parses.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Default HTTP API port the bridge serves on (`api_port`). */
export const DEFAULT_AXL_API_PORT = 9002;
/** Default TCP overlay port the bridge listens on (`tcp_port`). */
export const DEFAULT_AXL_TCP_PORT = 9201;
/** Default bind address for the bridge HTTP API + `bridge_addr`. */
export const DEFAULT_AXL_API_HOST = "127.0.0.1";
/** Default path of the bridge's PEM private key. */
export const DEFAULT_AXL_PEER_KEY = "./private.pem";
/** Default path of the generated `node-config.json`. */
export const DEFAULT_AXL_CONFIG_PATH = "./node-config.json";

export type AxlConfig = {
  /** Path to the bridge's PEM private key. */
  PrivateKeyPath: string;
  /** Mesh peer URIs (e.g. `tls://127.0.0.1:9202`). */
  Peers: string[];
  /** Listen addresses (e.g. `tls://0.0.0.0:9201`). */
  Listen: string[];
  /** AXL HTTP API port. */
  api_port: number;
  /** AXL TCP overlay port. */
  tcp_port: number;
  /** Bridge bind address. */
  bridge_addr: string;
};

/**
 * Write an AXL `node-config.json` and round-trip parse it so a silent
 * write corruption surfaces here instead of as a Go-side panic when
 * the operator launches the binary.
 */
export function writeAxlConfig(configPath: string, cfg: AxlConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  try {
    JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(
      `@acl/agent: ${configPath} is not valid JSON after writeFileSync: ${(err as Error).message}`,
    );
  }
}
