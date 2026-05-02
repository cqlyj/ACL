import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { type Address, type Hex, getAddress, isHex } from "viem";
import {
  type BatchGatewayRequest,
  decodeBatchGatewayQuery,
  encodeBatchGatewayResponse,
  encodeHttpError,
  encodeStringError,
  isBatchGatewayQuery,
} from "./batch-gateway.js";
import {
  DEFAULT_BATCH_CONCURRENCY,
  DEFAULT_FAN_OUT_TIMEOUT_MS,
  DEFAULT_RESPONSE_TTL_SECONDS,
} from "./constants.js";
import type { IdentityRegistryIndexer } from "./indexer.js";
import {
  type ResolverService,
  decodeResolverServiceCall,
  reconstructExtraData,
} from "./resolver-service.js";
import { buildSignedResponse } from "./signing.js";

/**
 * Build the ACL CCIP-Read gateway as a Hono app. The app implements:
 *
 *   - EIP-3668 direct CCIP-Read (`{sender}/{data}.json`) where `data` is
 *     `IResolverService.resolve(name, data)` and `sender` is the
 *     ACLOffchainResolver. This is the path triggered when a client (or
 *     the legacy Universal Resolver) follows the inner `OffchainLookup`
 *     directly.
 *
 *   - ENSIP-21 Batch Gateway (BGOLP, selector `0xa780bab6`) where the
 *     UniversalResolver V3 wraps N parallel `OffchainLookup` reverts into
 *     a single `IBatchGateway.query(Request[])` call. The gateway decodes
 *     the array, dispatches each subrequest, and returns
 *     `(bool[] failures, bytes[] responses)`.
 *
 * Both routes ultimately produce gateway-signed `(result, expires, sig)`
 * tuples whose signature target is the ENS resolver address (NOT the
 * gateway HTTP sender), so the on-chain `resolveWithProof` callback
 * verifies a single canonical key for both transports.
 *
 * Routes:
 *   GET  /:sender/:data.json
 *   POST /:sender (also accepts /; body {data, sender})
 *   GET  /healthz
 *   GET  /agents               (debug list of indexed agents)
 */
export type GatewayConfig = {
  /** ACLOffchainResolver address — the ENS resolver whose signature the gateway forges. */
  resolverAddress: Address;
  /** Private key (0x-prefixed hex) for the EIP-191 v0 gateway signature. MUST
   *  be authorised on the resolver via `setSigner(addr, true)`. */
  signerPrivateKey: Hex;
  /** Live mirror of the IdentityRegistry. */
  indexer: IdentityRegistryIndexer;
  /** Computes resolver responses given a decoded inner call. */
  resolverService: ResolverService;
  /** Validity window for signed responses (seconds). Defaults to 300. */
  responseTtlSeconds?: number;
  /**
   * HTTP fan-out used by the BGOLP path when a subrequest's `sender` is not
   * our resolver. Defaults to the global `fetch`. Override for tests or to
   * inject a host-aware client (e.g. with retries / timeouts).
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Per-subrequest HTTP timeout in milliseconds for the BGOLP fan-out.
   * Defaults to 5 000 ms. Subrequests that exceed the timeout are reported
   * as `HttpError(504, ...)` to the caller.
   */
  fanOutTimeoutMs?: number;
  /**
   * Maximum number of BGOLP subrequests to dispatch in parallel for a
   * single batch. Defaults to {@link DEFAULT_BATCH_CONCURRENCY}.
   * Subrequests that exceed this cap run on the next free slot.
   */
  batchConcurrency?: number;
};

const HTTP_GATEWAY_TIMEOUT = 504;
const HTTP_GATEWAY_BAD_RESPONSE = 502;

/**
 * EIP-3668 section "Client Lookup Protocol" steps 8-9: a 4xx from a gateway URL is
 * fatal for that subrequest, but a 5xx means "try the next URL". We mirror
 * that here when fanning a BGOLP subrequest out to its `urls`.
 */
const HTTP_FATAL_MIN = 400;
const HTTP_FATAL_MAX = 499;
const HTTP_RETRY_MIN = 500;
const HTTP_RETRY_MAX = 599;

export function createGateway(cfg: GatewayConfig) {
  const app = new Hono();
  app.use("*", logger());
  app.use("*", cors());

  app.get("/healthz", (c) =>
    c.json({ ok: true, indexedAgents: cfg.indexer.agents().length }),
  );

  app.get("/agents", (c) => {
    const capability = c.req.query("capability");
    let entries = cfg.indexer.agents();
    if (capability) {
      const needle = capability.trim().toLowerCase();
      entries = entries.filter(({ agentId }) =>
        cfg.indexer.hasCapability(agentId, needle),
      );
    }
    return c.json({
      agents: entries.map(({ agentId, metadata }) => ({
        agentId: agentId.toString(),
        metadata: Object.fromEntries(metadata),
        capabilities: cfg.indexer.capabilitiesOf(agentId),
      })),
    });
  });

  // GET form: /<sender>/<data>.json
  app.get("/:sender/:dataWithExt", async (c) => {
    const sender = c.req.param("sender");
    const rawData = c.req.param("dataWithExt");
    const data = rawData.endsWith(".json")
      ? rawData.slice(0, -".json".length)
      : rawData;
    return await handleLookup(c, sender, data, cfg);
  });

  // POST form: body { sender, data }. Per EIP-3668 "Gateway Interface".
  app.post("/:sender?", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      sender?: string;
      data?: string;
    } | null;
    if (!body?.sender || !body?.data) {
      return c.json({ message: "POST body must include {sender,data}" }, 400);
    }
    return await handleLookup(c, body.sender, body.data, cfg);
  });

  app.notFound((c) => c.json({ message: "Not found" }, 404));
  app.onError((err, c) => {
    console.error("[gateway] error", err);
    return c.json({ message: err.message ?? "Internal error" }, 500);
  });

  return app;
}

/**
 * Single-request signed CCIP-Read response. `data` is exactly what an
 * EIP-3668 client expects in the `data` field of the gateway JSON body
 * (i.e. the bytes to pass into `resolveWithProof(data, extraData)`).
 */
type InnerLookupResult = {
  data: Hex;
  expires: bigint;
  signature: Hex;
  messageHash: Hex;
  meta: ReturnType<ResolverService["resolve"]>["meta"];
};

/**
 * Process a single `IResolverService.resolve(name, data)` call against our
 * resolver. Pure function modulo the indexer + signer state; used by both
 * the direct CCIP-Read route and each subrequest of a BGOLP fan-out.
 *
 * `target` MUST be the ACLOffchainResolver address — the on-chain
 * `resolveWithProof` recomputes the EIP-191 v0 hash with `target =
 * address(this)` and rejects mismatches.
 */
async function processInnerLookup(
  callData: Hex,
  cfg: GatewayConfig,
): Promise<InnerLookupResult> {
  const inner = decodeResolverServiceCall(callData);
  const { result, meta } = cfg.resolverService.resolve({
    dnsName: inner.name,
    innerData: inner.data,
  });
  const extraData = reconstructExtraData({
    callData,
    resolver: cfg.resolverAddress,
  });
  const signed = await buildSignedResponse({
    privateKey: cfg.signerPrivateKey,
    target: cfg.resolverAddress,
    request: extraData,
    result,
    ttlSeconds: cfg.responseTtlSeconds ?? DEFAULT_RESPONSE_TTL_SECONDS,
  });
  return { ...signed, meta };
}

async function handleLookup(
  c: import("hono").Context,
  rawSender: string,
  rawData: string,
  cfg: GatewayConfig,
): Promise<Response> {
  try {
    getAddress(rawSender);
  } catch {
    return c.json({ message: `Invalid sender address: ${rawSender}` }, 400);
  }

  if (!isHex(rawData)) {
    return c.json({ message: "data param must be 0x-prefixed hex" }, 400);
  }
  const callData = rawData as Hex;

  // ENSIP-21: when the UniversalResolver fans multiple OffchainLookup reverts
  // into a single batch, the outer calldata is `IBatchGateway.query(...)`.
  if (isBatchGatewayQuery(callData)) {
    return await handleBatchGatewayLookup(c, callData, cfg);
  }

  return await handleDirectLookup(c, callData, cfg);
}

async function handleDirectLookup(
  c: import("hono").Context,
  callData: Hex,
  cfg: GatewayConfig,
): Promise<Response> {
  let res: InnerLookupResult;
  try {
    res = await processInnerLookup(callData, cfg);
  } catch (err) {
    return c.json({ message: (err as Error).message }, 400);
  }

  c.header("cache-control", "no-store");
  return c.json({
    data: res.data,
    debug: {
      transport: "direct",
      name: res.meta.name,
      label: res.meta.label,
      agentId: res.meta.agentId?.toString() ?? null,
      callKind: res.meta.call.kind,
      expires: res.expires.toString(),
      messageHash: res.messageHash,
    },
  });
}

async function handleBatchGatewayLookup(
  c: import("hono").Context,
  callData: Hex,
  cfg: GatewayConfig,
): Promise<Response> {
  let requests: BatchGatewayRequest[];
  try {
    requests = decodeBatchGatewayQuery(callData);
  } catch (err) {
    return c.json({ message: (err as Error).message }, 400);
  }

  const concurrency = Math.max(
    1,
    cfg.batchConcurrency ?? DEFAULT_BATCH_CONCURRENCY,
  );
  const results = await mapWithConcurrency(requests, concurrency, (req) =>
    dispatchBatchSubrequest(req, cfg),
  );

  const failures = results.map((r) => r.failure);
  const responses = results.map((r) => r.body);

  c.header("cache-control", "no-store");
  return c.json({
    data: encodeBatchGatewayResponse(failures, responses),
    debug: {
      transport: "batch-gateway",
      requests: results.map((r) => r.debug),
    },
  });
}

type SubrequestResult = {
  failure: boolean;
  body: Hex;
  debug: Record<string, unknown>;
};

/**
 * Dispatch a single BGOLP subrequest. When the subrequest's `sender`
 * matches our resolver we short-circuit and process locally; otherwise we
 * HTTP-fan-out to the supplied `urls` per EIP-3668. Failures are encoded
 * as `Error(string)` or `HttpError(uint16,string)` per ENSIP-21.
 */
async function dispatchBatchSubrequest(
  req: BatchGatewayRequest,
  cfg: GatewayConfig,
): Promise<SubrequestResult> {
  if (req.sender.toLowerCase() === cfg.resolverAddress.toLowerCase()) {
    try {
      const res = await processInnerLookup(req.data, cfg);
      return {
        failure: false,
        body: res.data,
        debug: {
          sender: req.sender,
          transport: "local",
          name: res.meta.name,
          label: res.meta.label,
          agentId: res.meta.agentId?.toString() ?? null,
          callKind: res.meta.call.kind,
        },
      };
    } catch (err) {
      return {
        failure: true,
        body: encodeStringError((err as Error).message),
        debug: {
          sender: req.sender,
          transport: "local",
          error: (err as Error).message,
        },
      };
    }
  }

  const fan = await fanOut(req, cfg);
  return {
    failure: fan.failure,
    body: fan.body,
    debug: { sender: req.sender, transport: "http", ...fan.debug },
  };
}

/**
 * Forward a subrequest whose `sender` is NOT our resolver to one of its
 * `urls`. Implements the EIP-3668 section "Client Lookup Protocol" rules:
 *
 *   - GET when the template carries `{data}`, POST `{sender,data}` otherwise.
 *   - HTTP 4xx is fatal — return that gateway's HttpError to the caller.
 *   - HTTP 5xx, network errors, or malformed bodies fall through to the next
 *     URL in the list.
 *   - Per-URL timeout is enforced via `AbortController`; a timeout is
 *     surfaced as `HttpError(504, …)` only after every URL has been tried.
 */
async function fanOut(
  req: BatchGatewayRequest,
  cfg: GatewayConfig,
): Promise<{ failure: boolean; body: Hex; debug: Record<string, unknown> }> {
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const timeoutMs = cfg.fanOutTimeoutMs ?? DEFAULT_FAN_OUT_TIMEOUT_MS;
  const errors: string[] = [];
  const attempts: Array<Record<string, unknown>> = [];

  if (req.urls.length === 0) {
    return {
      failure: true,
      body: encodeStringError("BGOLP subrequest has empty urls[]"),
      debug: { errors: ["empty urls[]"] },
    };
  }

  for (const template of req.urls) {
    const url = template
      .replace("{sender}", req.sender.toLowerCase())
      .replace("{data}", req.data);
    const useGet = template.includes("{data}");
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const response = useGet
        ? await fetchImpl(url, { method: "GET", signal: ac.signal })
        : await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sender: req.sender, data: req.data }),
            signal: ac.signal,
          });
      clearTimeout(timer);

      if (
        response.status >= HTTP_FATAL_MIN &&
        response.status <= HTTP_FATAL_MAX
      ) {
        // EIP-3668: 4xx is fatal — surface it as the canonical HttpError.
        return {
          failure: true,
          body: encodeHttpError(response.status, await safeText(response)),
          debug: {
            url,
            status: response.status,
            attempts: [...attempts, { url, status: response.status }],
          },
        };
      }
      if (
        response.status >= HTTP_RETRY_MIN &&
        response.status <= HTTP_RETRY_MAX
      ) {
        // EIP-3668: 5xx — fall through to the next URL.
        const text = await safeText(response);
        errors.push(`${url}: ${response.status} ${text}`);
        attempts.push({ url, status: response.status, retryable: true });
        continue;
      }
      if (!response.ok) {
        // 1xx/3xx etc. — treat as malformed.
        errors.push(`${url}: unexpected status ${response.status}`);
        attempts.push({ url, status: response.status });
        continue;
      }
      const body = (await response.json().catch(() => null)) as {
        data?: string;
      } | null;
      if (!body || typeof body.data !== "string" || !isHex(body.data)) {
        errors.push(`${url}: malformed JSON body`);
        attempts.push({ url, status: response.status, malformed: true });
        continue;
      }
      return {
        failure: false,
        body: body.data as Hex,
        debug: {
          url,
          status: response.status,
          attempts: [...attempts, { url, status: response.status }],
        },
      };
    } catch (err) {
      const aborted = (err as Error).name === "AbortError";
      if (aborted) {
        errors.push(`${url}: timed out after ${timeoutMs}ms`);
        attempts.push({ url, error: "timeout" });
        continue;
      }
      errors.push(`${url}: ${(err as Error).message}`);
      attempts.push({ url, error: (err as Error).message });
    }
  }

  // Every URL exhausted. Pick a status code that reflects the last failure
  // mode: 504 if any URL timed out, 502 otherwise.
  const anyTimeout = attempts.some((a) => a.error === "timeout");
  return {
    failure: true,
    body: encodeHttpError(
      anyTimeout ? HTTP_GATEWAY_TIMEOUT : HTTP_GATEWAY_BAD_RESPONSE,
      errors.join("; ") || "all gateways failed",
    ),
    debug: { attempts, errors },
  };
}

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 256);
  } catch {
    return r.statusText;
  }
}

/**
 * Run `worker(item)` over `items` with at most `concurrency` in-flight
 * tasks. Order-preserving: the result array indices match `items`.
 *
 * Used for the BGOLP fan-out so the gateway never amplifies one
 * inbound batch request into an unbounded number of upstream HTTPS
 * connections.
 */
async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        out[idx] = await worker(items[idx] as T);
      }
    },
  );
  await Promise.all(runners);
  return out;
}
