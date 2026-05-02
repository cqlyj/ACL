import { type Address, type Hex, getAddress, toHex } from "viem";

import { normalizeAddress } from "./normalize.js";

/**
 * ENSIP-25 helpers. Builds the parameterised `agent-registration[<registry>][<agentId>]`
 * text-record key used to verify the link between an ENS name and an ERC-8004
 * agent registry entry.
 *
 * Spec: https://docs.ens.domains/ensip/25
 *
 * `<registry>` is the ERC-7930 interoperable address of the registry contract;
 * `<agentId>` is the registry-defined agent identifier (string, no `[`/`]`).
 */

/**
 * Encode an EVM (chain-id + address) pair as an ERC-7930 v1 interoperable
 * address. Layout:
 *
 *   ┌─────────┬───────────┬───────────────────────┬─────────────────┬───────────────┬─────────┐
 *   │ Version │ ChainType │ ChainReferenceLength  │ ChainReference  │ AddressLength │ Address │
 *   │  0x0001 │  0x0000   │  uint8 = N            │   N bytes BE    │   0x14        │  20 b   │
 *   └─────────┴───────────┴───────────────────────┴─────────────────┴───────────────┴─────────┘
 *
 * For EIP-155 chains (CAIP-350 EVM profile), `ChainType = 0x0000` and the
 * `ChainReference` is the unsigned big-endian byte representation of the
 * EIP-155 chain id with leading zero bytes stripped.
 *
 * @example
 * ```ts
 * encodeErc7930({ chainId: 1, address: '0x8004A169...' })
 * // '0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432'
 * ```
 */
export function encodeErc7930(params: {
  chainId: number | bigint;
  address: Address;
}): Hex {
  const { chainId, address } = params;
  // Accept both lowercased and checksummed inputs — the binary form
  // ends up lowercased anyway per CAIP-350 EVM profile (see line below
  // where we `address.slice(2).toLowerCase()`), so checksum strictness
  // here would only reject perfectly-valid lowercased peers.
  if (!normalizeAddress(address)) {
    throw new Error(`encodeErc7930: not a valid address: ${address}`);
  }

  const chainIdBig = typeof chainId === "bigint" ? chainId : BigInt(chainId);
  if (chainIdBig < 0n) throw new Error("encodeErc7930: chainId must be non-negative");

  const chainRef = stripLeadingZeros(toHex(chainIdBig).slice(2));
  if (chainRef.length / 2 > 0xff) {
    throw new Error("encodeErc7930: chainId too large to fit in a single length byte");
  }

  const chainRefLen = chainRef.length / 2;
  // Lowercase the 20-byte EVM address per CAIP-350 EVM profile binary form.
  const addrBytes = address.slice(2).toLowerCase();

  return `0x0001${"0000"}${u8(chainRefLen)}${chainRef}${u8(20)}${addrBytes}` as Hex;
}

function u8(n: number): string {
  if (n < 0 || n > 0xff) throw new Error(`u8: out of range: ${n}`);
  return n.toString(16).padStart(2, "0");
}

function stripLeadingZeros(hex: string): string {
  // Drop leading "00" pairs, but keep at least one byte to represent zero
  // (CAIP-350 EVM profile says zero-length is valid; we keep a single byte
  // for chain ids 1..255 to match Nick Johnson's reference vectors).
  let i = 0;
  while (i + 2 <= hex.length && hex.slice(i, i + 2) === "00") i += 2;
  // Pad to even length and ensure single-byte minimum representation.
  const trimmed = hex.slice(i);
  if (trimmed.length === 0) return "00";
  return trimmed.length % 2 === 0 ? trimmed : `0${trimmed}`;
}

/**
 * Build the ENSIP-25 verification text-record key.
 *
 * @example
 * ```ts
 * buildAgentRegistrationKey({ chainId: 1, registry: '0x8004A169...', agentId: 167n })
 * // 'agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][167]'
 * ```
 */
export function buildAgentRegistrationKey(params: {
  chainId: number | bigint;
  registry: Address;
  agentId: bigint | number | string;
}): string {
  const { chainId, registry, agentId } = params;
  const idStr = typeof agentId === "string" ? agentId : agentId.toString();
  if (idStr.includes("[") || idStr.includes("]")) {
    throw new Error("ENSIP-25: agentId MUST NOT contain `[` or `]`");
  }
  // Checksum the address before encoding to fail loudly on malformed input.
  const checksummed = getAddress(registry);
  const interop = encodeErc7930({ chainId, address: checksummed });
  return `agent-registration[${interop}][${idStr}]`;
}

/**
 * Canonical ENSIP-25 attestation value to publish as the text-record
 * payload when the ENS name owner wants to assert "this name is the
 * agent at <registry>[<agentId>]".
 *
 * Per ENSIP-25 section "Parameterized Verification Text Record Key":
 *
 *   > The value of this text record MUST be a non-empty string.
 *   > Implementations SHOULD set the value to "1". The specific value has
 *   > no semantic meaning; the presence of a non-empty value is interpreted
 *   > as an attestation [...]. Verification clients MUST NOT depend on the
 *   > specific value beyond it being non-empty.
 *
 * Use this constant when writing the record. When VERIFYING, accept any
 * non-empty value.
 */
export const ENSIP25_ATTESTATION_VALUE = "1";
