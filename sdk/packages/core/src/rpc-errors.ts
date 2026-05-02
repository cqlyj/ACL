/**
 * Heuristics for classifying common RPC errors that the SDK needs to
 * react to (instead of bubbling up to the caller). Centralised so the
 * gateway indexer, the settlement log paginator, and any future
 * consumer share one set of needles — drift between them is a real
 * cause of "the indexer back-offs but the paginator doesn't" bugs.
 *
 * The heuristics deliberately match on substrings the major hosted
 * RPC providers actually emit (Alchemy, Infura, QuickNode, public 0G
 * testnet, public Sepolia endpoints). They are conservative — anything
 * we cannot positively classify falls through and propagates so the
 * operator notices.
 */

/**
 * Substrings (lowercased) RPC providers use when rejecting an
 * `eth_getLogs` call because the from→to block window is too wide
 * (or the response would exceed their result-size cap, which the
 * provider sometimes phrases as a range error). Match on any.
 */
const RANGE_LIMIT_NEEDLES: readonly string[] = [
  "eth_getlogs is limited",
  "block range",
  "blockrange",
  "range exceeds",
  "range is too wide",
  "too many blocks",
  "exceed maximum block range",
  "query returned more than",
  "too many results",
  "limited to",
  "is limited to",
  "limit exceeded",
  "exceeds the limit",
  "response size",
  "log response",
  "over rpc maximum",
  "over response size limit",
];

/**
 * Pull every error-shape string we might find on a typed JsonRpcError
 * (viem) or a plain `Error`. We OR all three so a viem RpcError whose
 * informative payload only lives in `details` doesn't slip past a
 * matcher that only inspects `message`.
 */
function _errorHaystack(err: unknown): string {
  if (!err) return "";
  return `${(err as { message?: string }).message ?? ""} ${
    (err as { details?: string }).details ?? ""
  } ${(err as { shortMessage?: string }).shortMessage ?? ""}`.toLowerCase();
}

/**
 * Returns `true` when the supplied error looks like an RPC provider
 * rejecting an `eth_getLogs` window for being too wide (or for
 * returning more results than the provider's response cap allows).
 *
 * Used by the settlement log paginator and the gateway indexer to
 * automatically halve the scan window and retry instead of failing
 * the whole agent loop.
 */
export function isRpcRangeLimitError(err: unknown): boolean {
  const haystack = _errorHaystack(err);
  if (!haystack.trim()) return false;
  return RANGE_LIMIT_NEEDLES.some((n) => haystack.includes(n));
}
