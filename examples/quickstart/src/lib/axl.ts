/**
 * Local AXL bridge spawn helper. Each quickstart process owns its own
 * `gensyn-axl/node` binary — no central message broker, separate AXL
 * nodes per agent (the Gensyn track requirement). This module is the
 * one place port allocation lives, so the only thing the agent files
 * have to do is `spawnLocalAxl("client" | "provider")` and pass the
 * returned `apiUrl` into the agent class.
 *
 * Port allocation is role-stable: the same role always gets the same
 * `apiPort` / `listenPort`, so the AXL pem file (`<role>.pem`)
 * produces a peer id that's stable across runs. That stability lets
 * the on-chain `acl.axl-peer-id` metadata stay correct without
 * re-running setup every boot.
 */
import { type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { spawnAxlBridge } from "@acl/agent";
import { env } from "../config.js";

/**
 * AXL overlay TCP port. The mesh is encrypted, so sharing the same
 * value across nodes is correct (and matches the AXL docs).
 */
const AXL_OVERLAY_TCP_PORT = 7000;

/** Per-role AXL bridge port table. */
export const AXL_PORTS = {
  provider: { apiPort: 9111, listenPort: 9211, tcpPort: AXL_OVERLAY_TCP_PORT },
  client: { apiPort: 9112, listenPort: 9212, tcpPort: AXL_OVERLAY_TCP_PORT },
} as const;

export const AXL_DIR = resolve(import.meta.dir, "..", "..", ".axl");

export type AxlRole = "client" | "provider";

export type SpawnLocalAxlResult = {
  child: ChildProcess;
  apiUrl: string;
  peerId: string;
};

const peersFor = (role: AxlRole): string[] => {
  const peer = role === "client" ? AXL_PORTS.provider : AXL_PORTS.client;
  return [`tls://127.0.0.1:${peer.listenPort}`];
};

/**
 * Spawn the per-role AXL bridge and resolve its public peer id.
 *
 * @param role  "client" | "provider" — picks the port row + pem path.
 * @param opts.peers
 *   Override the auto-derived peer list. Pass `[]` from `setup.ts`
 *   where the bridge runs alone briefly to read the peer id.
 * @param opts.quiet
 *   When true, suppress the AXL Go binary's stdout/stderr (used by
 *   `setup.ts` so the structured progress logs aren't drowned out).
 *   Long-lived processes keep the default `inherit` so the AXL
 *   "Connected inbound/outbound" messages surface on stdout.
 */
export async function spawnLocalAxl(
  role: AxlRole,
  opts: { peers?: string[]; quiet?: boolean } = {},
): Promise<SpawnLocalAxlResult> {
  const ports = AXL_PORTS[role];
  const apiUrl = `http://127.0.0.1:${ports.apiPort}`;
  const result = await spawnAxlBridge({
    axlBin: env.axlBin,
    apiPort: ports.apiPort,
    tcpPort: ports.tcpPort,
    listenPort: ports.listenPort,
    apiHost: "127.0.0.1",
    peers: opts.peers ?? peersFor(role),
    peerKeyPath: resolve(AXL_DIR, `${role}.pem`),
    configPath: resolve(AXL_DIR, `${role}.config.json`),
    ...(opts.quiet ? { stdio: ["ignore", "pipe", "pipe"] as const } : {}),
  });
  return { ...result, apiUrl };
}
