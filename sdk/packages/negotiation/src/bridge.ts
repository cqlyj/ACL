import { type NegotiationMessage, isNegotiationMessage } from "./messages.js";

/**
 * Default polling interval for `AxlBridge.recv`. Small enough that a 30-second
 * timeout still surfaces sub-second latency, large enough to keep loopback
 * CPU cheap. Override per call via the `pollIntervalMs` option, or globally
 * via {@link AxlBridgeConfig.pollIntervalMs}.
 *
 * Distinct from `DEFAULT_PROVIDER_AXL_POLL_INTERVAL_MS` exported by
 * `@acl/agent`, which controls the provider's high-level inbox polling
 * cadence rather than the bridge's raw HTTP recv cadence.
 */
export const DEFAULT_AXL_BRIDGE_RECV_POLL_INTERVAL_MS = 250;

/**
 * Default long-poll deadline for `AxlBridge.recv`. The negotiation flow
 * prefers shorter timeouts at the call site (`waitFor` defaults to 30 s) but
 * a single bridge `recv` will wait this long if no override is supplied.
 */
export const DEFAULT_AXL_RECV_TIMEOUT_MS = 30_000;

/**
 * Wire shape returned by an AXL node's `GET /topology` endpoint.
 * @see https://docs.gensyn.ai/tech/agent-exchange-layer/examples-and-building
 */
export type AxlTopology = {
  our_public_key: string;
  our_ipv6: string;
  peers: unknown[];
  tree?: unknown;
};

/**
 * A message popped off `GET /recv`, paired with the sender's mesh address
 * as reported by AXL.
 *
 * IMPORTANT: `fromPeerId` is the AXL routable form (first 14 bytes of the
 * Ed25519 public key followed by `ff` padding to 32 bytes), NOT the full
 * agent peer key. Use it for replying via `/send` (AXL accepts both forms),
 * but DO NOT use it as a security identity for the remote agent. The
 * authoritative agent identity comes from the EIP-712 signature on the
 * `JobProposal` and from the `acl.axl-peer-id` ENS text record.
 */
export type ReceivedMessage = {
  message: NegotiationMessage;
  fromPeerId: string;
  /** Raw JSON string for transcript fidelity (preserves byte-for-byte order). */
  raw: string;
};

export type AxlBridgeConfig = {
  /**
   * Base URL for the local AXL bridge HTTP API (e.g. `http://127.0.0.1:9002`).
   * Matches the `api_port` value in the node config.
   */
  apiUrl: string;
  /**
   * Polling interval used by `recv` while waiting. Defaults to
   * {@link DEFAULT_AXL_BRIDGE_RECV_POLL_INTERVAL_MS}.
   */
  pollIntervalMs?: number;
  /** Customise the fetch implementation (mainly for tests). */
  fetch?: typeof fetch;
};

/**
 * Thin wrapper over the AXL local HTTP bridge. We deliberately keep this
 * package free of any vendored AXL types so it tracks whatever version the
 * operator is running.
 *
 * Higher-level orchestration (proposal flows, transcript building) lives in
 * `Negotiator`; this class only does I/O.
 */
export class AxlBridge {
  private readonly apiUrl: string;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: AxlBridgeConfig) {
    this.apiUrl = cfg.apiUrl.replace(/\/$/, "");
    this.pollIntervalMs =
      cfg.pollIntervalMs ?? DEFAULT_AXL_BRIDGE_RECV_POLL_INTERVAL_MS;
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  /** Fetch the local node's identity + mesh state. */
  async topology(): Promise<AxlTopology> {
    const res = await this.fetchImpl(`${this.apiUrl}/topology`);
    if (!res.ok) {
      throw new Error(
        `[axl-bridge] /topology failed: ${res.status} ${await res.text()}`,
      );
    }
    return (await res.json()) as AxlTopology;
  }

  /** Convenience: just our public key. */
  async ourPeerId(): Promise<string> {
    const t = await this.topology();
    return t.our_public_key;
  }

  /**
   * Send a typed negotiation message to a peer. The destination peer is
   * encoded in the AXL `X-Destination-Peer-Id` header per
   * https://docs.gensyn.ai/tech/agent-exchange-layer/examples-and-building.
   */
  async send(destPeerId: string, message: NegotiationMessage): Promise<void> {
    if (!/^[0-9a-fA-F]{64}$/.test(destPeerId)) {
      throw new Error(
        `[axl-bridge] destination peer id must be a 64-char hex string, got ${destPeerId.length} chars`,
      );
    }
    const body = JSON.stringify(message);
    const res = await this.fetchImpl(`${this.apiUrl}/send`, {
      method: "POST",
      headers: {
        "X-Destination-Peer-Id": destPeerId,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!res.ok) {
      throw new Error(
        `[axl-bridge] /send to ${destPeerId.slice(0, 8)}…: ${res.status} ${await res.text()}`,
      );
    }
  }

  /**
   * Single non-blocking poll. Returns `null` immediately if no message is
   * waiting. Skips messages from foreign protocols so a shared mesh doesn't
   * confuse the negotiation flow.
   *
   * Per the AXL HTTP API
   * (https://github.com/gensyn-ai/axl/blob/main/docs/api.md#get-recv) the
   * empty-queue response is `204 No Content`; a `200 OK` response with
   * an empty body is treated the same way as a defensive fallback.
   */
  async recvOnce(): Promise<ReceivedMessage | null> {
    const res = await this.fetchImpl(`${this.apiUrl}/recv`);
    if (res.status === 204) return null;
    if (!res.ok) {
      throw new Error(
        `[axl-bridge] /recv failed: ${res.status} ${await res.text()}`,
      );
    }
    const text = await res.text();
    if (text.length === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isNegotiationMessage(parsed)) return null;
    const fromPeerId = res.headers.get("x-from-peer-id") ?? "";
    return { message: parsed, fromPeerId, raw: text };
  }

  /**
   * Long-poll for a single message. Resolves with the next negotiation
   * envelope or rejects after `timeoutMs` ms. The loop polls every
   * `pollIntervalMs` to avoid tight CPU spinning. Pass `pollIntervalMs` in
   * the options to override the bridge default for this single call.
   *
   * Optionally pass a `match` predicate (e.g. correlate by `replyTo === id`)
   * to skip unrelated traffic without losing it; non-matching messages are
   * forwarded to `onSkipped` so the caller can still record them in a
   * transcript.
   */
  async recv(
    opts: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      signal?: AbortSignal;
      match?: (msg: NegotiationMessage) => boolean;
      onSkipped?: (received: ReceivedMessage) => void;
    } = {},
  ): Promise<ReceivedMessage> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_AXL_RECV_TIMEOUT_MS;
    const pollIntervalMs = opts.pollIntervalMs ?? this.pollIntervalMs;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) {
        throw new Error("[axl-bridge] recv aborted");
      }
      const got = await this.recvOnce();
      if (got) {
        if (!opts.match || opts.match(got.message)) return got;
        opts.onSkipped?.(got);
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(`[axl-bridge] recv timeout after ${timeoutMs}ms`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
