import type { Hex } from "viem";

/**
 * The on-chain `Job.description` field is a free-form `string`, but ACL
 * uses the convention that it is a **66-character lowercase 0x-prefixed
 * bytes32 hex literal** carrying the EIP-712 `taskSpecHash`. The provider
 * agent's `JobFunded` handler keys its TaskSpec lookup off this hash via
 * {@link decodeJobDescription} below.
 *
 * These helpers centralise the convention so the encode and decode shapes
 * never drift apart, and so consumers who roll their own
 * `description` strings can opt out without breaking ACL-aware
 * counterparties:
 *
 *   - {@link encodeJobDescription}   — encode a `taskSpecHash` (Hex) into
 *                                       the canonical lowercase string.
 *   - {@link decodeJobDescription}   — recover a `taskSpecHash` from the
 *                                       canonical string. Returns `null`
 *                                       when the description does not
 *                                       conform (e.g. plain-text from a
 *                                       non-ACL client).
 *
 * Use these helpers everywhere instead of inline length/prefix checks.
 */

/**
 * Length of the canonical encoding (`0x` + 64 hex chars). Pinned in code
 * so tests and the on-chain decoder share one source of truth.
 */
export const JOB_DESCRIPTION_HEX_LENGTH = 66 as const;

/**
 * Lowercase the bytes32 hex so two implementations producing the same
 * hash always serialise to byte-identical strings, regardless of which
 * side normalised first. Throws when the input does not look like a
 * valid bytes32 (`0x` + 64 hex chars).
 */
export function encodeJobDescription(taskSpecHash: Hex): string {
  if (typeof taskSpecHash !== "string" || !taskSpecHash.startsWith("0x")) {
    throw new Error(
      `encodeJobDescription: expected 0x-prefixed bytes32, got ${String(taskSpecHash)}`,
    );
  }
  if (taskSpecHash.length !== JOB_DESCRIPTION_HEX_LENGTH) {
    throw new Error(
      `encodeJobDescription: expected ${JOB_DESCRIPTION_HEX_LENGTH}-char hex, got ${taskSpecHash.length} chars`,
    );
  }
  return taskSpecHash.toLowerCase();
}

/**
 * Recover a `taskSpecHash` from the canonical description string. Returns
 * `null` when the description does NOT look like a bytes32 hex literal —
 * the caller should fall back to a different correlation strategy (e.g.
 * client-address match) so non-ACL job descriptions don't crash the
 * provider's chain-poll handler.
 */
export function decodeJobDescription(description: string | null | undefined): Hex | null {
  if (typeof description !== "string") return null;
  if (description.length !== JOB_DESCRIPTION_HEX_LENGTH) return null;
  if (!description.startsWith("0x")) return null;
  // Reject anything past the 0x that isn't hex — the provider agent
  // relies on this round-trip being lossless.
  for (let i = 2; i < description.length; i++) {
    const c = description.charCodeAt(i);
    const isDigit = c >= 0x30 && c <= 0x39;
    const isLowerHex = c >= 0x61 && c <= 0x66;
    const isUpperHex = c >= 0x41 && c <= 0x46;
    if (!isDigit && !isLowerHex && !isUpperHex) return null;
  }
  return description.toLowerCase() as Hex;
}
