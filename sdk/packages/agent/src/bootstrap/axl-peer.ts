/**
 * Shared poller for the AXL bridge's `/topology` endpoint. Both
 * `bin/acl-axl.ts` (operator-facing CLI) and `bootstrap/spawn-axl.ts`
 * (programmatic spawner) wait for the bridge to surface a peer id
 * before they declare success; centralising the poll here keeps both
 * paths byte-identical.
 */

/** Time to wait between `/topology` probes while the bridge warms up. */
export const AXL_TOPOLOGY_POLL_INTERVAL_MS = 500;
/**
 * Hard ceiling on the topology poll loop. 30s covers the worst-case
 * cold-start (TLS handshake + Yggdrasil bootstrap on a slow VM)
 * without making the operator stare at a hung CLI for minutes.
 */
export const AXL_TOPOLOGY_POLL_TIMEOUT_MS = 30_000;

/**
 * Poll the bridge's `/topology` endpoint until `our_public_key` is
 * present (or `timeoutMs` elapses). Returns the public peer id on
 * success or `null` on timeout — surfacing the binary-mix-up failure
 * mode (operator pointed at Node.js by accident) is the caller's job.
 */
export async function pollAxlPeerId(
  apiUrl: string,
  timeoutMs: number = AXL_TOPOLOGY_POLL_TIMEOUT_MS,
): Promise<string | null> {
  const startAt = Date.now();
  while (Date.now() - startAt < timeoutMs) {
    try {
      const res = await fetch(`${apiUrl}/topology`);
      if (res.ok) {
        const body = (await res.json()) as { our_public_key?: string };
        if (body.our_public_key) return body.our_public_key;
      }
    } catch {
      // keep polling — bridge isn't listening yet
    }
    await new Promise((r) => setTimeout(r, AXL_TOPOLOGY_POLL_INTERVAL_MS));
  }
  return null;
}
