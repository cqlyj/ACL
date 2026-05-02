import { AxlBridge } from "@acl/negotiation";

/**
 * Programmatic AXL bootstrap. Talks to an already-running local AXL
 * bridge HTTP API and pulls back the public peer id (= the value the
 * agent must publish in its `acl.axl-peer-id` ENS metadata).
 *
 * Why not auto-spawn `gensyn-axl` ourselves? The binary's path, port,
 * peer-key file, and bootstrap peers are operator-controlled. Spawning
 * it from the SDK would inevitably mis-configure something. Instead
 * the SDK ships an `acl-axl` helper script (see `bin/acl-axl.ts`)
 * that wraps the start command with friendly errors; agents fail-fast
 * at boot when the bridge URL is unreachable.
 */
export type AxlBootstrapInput = {
  /** Local bridge HTTP base URL, e.g. `http://127.0.0.1:9002`. */
  apiUrl: string;
  /** Optional ms timeout for each `topology` probe. Default 5s. */
  timeoutMs?: number;
  /** Number of probe retries on transient connection errors. Default 5. */
  retries?: number;
};

export type AxlBootstrap = {
  apiUrl: string;
  peerId: string;
};

const DEFAULT_TIMEOUT = 5_000;
const RETRY_BACKOFF_MS = 500;

/**
 * Resolve the local AXL node's peer id, retrying briefly while the
 * node is still warming up. Throws a friendly error when the bridge
 * URL is unreachable.
 */
export async function bootstrapAxl(input: AxlBootstrapInput): Promise<AxlBootstrap> {
  const retries = input.retries ?? 5;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT;

  let lastError: unknown = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const peerId = await _withTimeout(
        () => new AxlBridge({ apiUrl: input.apiUrl }).ourPeerId(),
        timeoutMs,
      );
      return { apiUrl: input.apiUrl, peerId };
    } catch (err) {
      lastError = err;
      if (i < retries) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      }
    }
  }
  throw new Error(
    `@acl/agent: could not reach AXL bridge at ${input.apiUrl}. Start it with \`acl-axl\` (see @acl/agent CLI) and retry. Last error: ${(lastError as Error)?.message ?? String(lastError)}`,
  );
}

async function _withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    fn(),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}
