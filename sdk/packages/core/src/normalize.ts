import { type Address, getAddress, isAddress } from "viem";

/**
 * Best-effort canonicalisation of a string into a checksummed
 * {@link Address}. Returns `null` when the input is not a 20-byte
 * hex address; otherwise returns the EIP-55 checksummed form.
 *
 * Lower-level than `viem.isAddress` because:
 *   - it accepts BOTH lowercased AND checksummed input (`strict:
 *     false`), so we don't reject perfectly valid addresses that just
 *     happen to have lost their checksum somewhere along the AXL /
 *     JSON / multicall round-trip,
 *   - it always re-checksums via `getAddress` so the rest of the
 *     SDK sees a single canonical shape regardless of input casing.
 *
 * Use this everywhere the SDK validates a peer-supplied address.
 * Sites that bypass it (and the cost of doing so):
 *   - {@link encodeErc7930} — strict by spec.
 *   - on-chain ABI-decoded values — already checksummed by viem.
 */
export function normalizeAddress(value: string): Address | null {
  if (!value) return null;
  if (!isAddress(value, { strict: false })) return null;
  return getAddress(value);
}
