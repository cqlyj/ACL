import { type Address, isAddress } from "viem";

/**
 * Top-level keys an `inft-sale`-capable provider publishes inside the
 * ENSIP-26 `agent-context` record so buyer SDKs can negotiate the
 * sale without an extra round-trip.
 *
 * Keep these in lockstep with the on-chain hook config:
 *   - `contract`     → the ERC-7857 iNFT contract that holds the token
 *                      (typically `deployment.galileo.aclAgentNFT`).
 *   - `tokenId`      → the iNFT this provider sells; decimal string
 *                      because JSON has no native uint256.
 *   - `minPrice`     → minimum acceptable budget, smallest-unit decimal
 *                      string in the same payment token as `paymentToken`.
 *   - `paymentToken` → ERC-20 the buyer must escrow with; defaults to
 *                      the deployment's `acltUSDC` if omitted.
 *   - `verifier`     → trusted-party verifier the iNFT contract delegates
 *                      `TransferValidityProof[]` checking to; defaults to
 *                      `deployment.galileo.trustedPartyVerifier` if omitted.
 *
 * The keys are dotted strings (rather than nested objects) so they
 * survive the lossy JSON-to-text-record round-trip the ENS resolver
 * does without a schema agreement on either side.
 */
export const INFT_SALE_CAPABILITY_KEYS = {
  contract: "acl.cap.inft-sale.contract",
  tokenId: "acl.cap.inft-sale.token-id",
  minPrice: "acl.cap.inft-sale.min-price",
  paymentToken: "acl.cap.inft-sale.payment-token",
  verifier: "acl.cap.inft-sale.verifier",
} as const;

export type InftSaleCapabilityKey =
  (typeof INFT_SALE_CAPABILITY_KEYS)[keyof typeof INFT_SALE_CAPABILITY_KEYS];

/**
 * Strongly-typed view of an `inft-sale` capability after parsing the
 * dotted-key fields out of `agentContext.extra`.
 *
 * `paymentToken` and `verifier` are nullable so callers can fall back
 * to the deployment defaults without re-walking the raw extra map.
 */
export type InftSaleCapability = {
  contract: Address;
  tokenId: bigint;
  minPrice: bigint;
  paymentToken: Address | null;
  verifier: Address | null;
};

/**
 * Lenient parser: returns `null` when the three required keys
 * (`contract`, `tokenId`, `minPrice`) are missing or malformed; that
 * way buyer flows can do a single `if (!cap) return SKIP` check
 * without TypeScript narrowing each field individually.
 *
 * Lenient on purpose:
 *   - non-string values are coerced via `String(...)` so a provider
 *     that wrote a JSON number for `min-price` still parses,
 *   - `paymentToken` / `verifier` that are present but invalid are
 *     dropped to `null` rather than failing the whole parse —
 *     buyer code is expected to substitute a deployment default,
 *   - `tokenId` / `minPrice` reject non-numeric input via the
 *     `BigInt(...)` throw, which is caught and returned as `null`.
 *
 * The intent is parity with `examples/kelp-postmortem/src/inft/buyer-flow.ts`,
 * minus the inline string casts; that file should call this instead.
 */
export function parseInftSaleCapability(
  extra: Record<string, unknown> | undefined,
): InftSaleCapability | null {
  if (!extra) return null;
  const contract = _readAddress(extra[INFT_SALE_CAPABILITY_KEYS.contract]);
  const tokenIdRaw = _readDecString(extra[INFT_SALE_CAPABILITY_KEYS.tokenId]);
  const minPriceRaw = _readDecString(extra[INFT_SALE_CAPABILITY_KEYS.minPrice]);
  if (!contract || tokenIdRaw === null || minPriceRaw === null) return null;
  let tokenId: bigint;
  let minPrice: bigint;
  try {
    tokenId = BigInt(tokenIdRaw);
    minPrice = BigInt(minPriceRaw);
  } catch {
    return null;
  }
  return {
    contract,
    tokenId,
    minPrice,
    paymentToken: _readAddress(extra[INFT_SALE_CAPABILITY_KEYS.paymentToken]),
    verifier: _readAddress(extra[INFT_SALE_CAPABILITY_KEYS.verifier]),
  };
}

function _readAddress(value: unknown): Address | null {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    return null;
  }
  return value as Address;
}

function _readDecString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  if (typeof value === "bigint") return value.toString();
  return null;
}
