/**
 * Shared defaults for the ACL CCIP-Read gateway. Hoisted into a separate
 * module so both `server.ts` (which decides when to apply them) and
 * `signing.ts` (which falls back to the same TTL when used standalone) can
 * import them without a circular dependency.
 */

/**
 * Default validity window for a signed CCIP-Read response. Five minutes
 * matches the Universal Resolver's default cache lifetime; consumers can
 * tighten or loosen via `responseTtlSeconds` on `GatewayConfig` or the
 * `ttlSeconds` argument to `buildSignedResponse`.
 */
export const DEFAULT_RESPONSE_TTL_SECONDS = 300;

/**
 * Per-subrequest HTTP timeout for the BGOLP fan-out path. Five seconds is
 * well below ENS's typical gateway budget but high enough to absorb most
 * cross-region jitter.
 */
export const DEFAULT_FAN_OUT_TIMEOUT_MS = 5_000;

/**
 * Max number of BGOLP subrequests we'll dispatch in parallel for a
 * single batch query. Caps the gateway's amplification factor so a
 * malicious / fat batch can't fan out hundreds of upstream HTTPS
 * connections from a single inbound request. Subrequests beyond this
 * concurrency limit run on the next free slot — total throughput is
 * unchanged, just bounded.
 */
export const DEFAULT_BATCH_CONCURRENCY = 16;
