import { type Address, type Hex, concat, encodeAbiParameters, keccak256, numberToHex } from "viem";
import { sign } from "viem/accounts";
import { DEFAULT_RESPONSE_TTL_SECONDS } from "./constants.js";

/**
 * EIP-191 v0 signing helper for ENS CCIP-Read responses, byte-for-byte
 * equivalent to ensdomains/offchain-resolver's `SignatureVerifier`:
 *
 *   digest = keccak256(0x19 || 0x00 || target || expires || keccak256(request) || keccak256(result))
 *
 * Notes:
 *  - `target` is the ACLOffchainResolver contract on Sepolia (NOT the gateway).
 *  - `expires` is a uint64 unix timestamp.
 *  - `request` is the full `extraData` blob the resolver included in the
 *    OffchainLookup error (`abi.encode(callData, address(this))`).
 *  - The signature is the raw secp256k1 sig over `digest`. Do NOT add a
 *    second EIP-191 personal_sign prefix.
 */
export function makeSignatureHash(params: {
  target: Address;
  expires: bigint;
  request: Hex;
  result: Hex;
}): Hex {
  const { target, expires, request, result } = params;
  const expiresBE = numberToHex(expires, { size: 8 });
  return keccak256(concat(["0x1900", target, expiresBE, keccak256(request), keccak256(result)]));
}

/** Build the `(result, expires, sig)` tuple that the resolver's
 *  `resolveWithProof(response, extraData)` callback expects, ABI-encoded. */
export async function buildSignedResponse(params: {
  privateKey: Hex;
  target: Address;
  request: Hex;
  result: Hex;
  /** Validity window in seconds. Defaults to 5 minutes. */
  ttlSeconds?: number;
}): Promise<{ data: Hex; expires: bigint; signature: Hex; messageHash: Hex }> {
  const { privateKey, target, request, result } = params;
  const ttl = params.ttlSeconds ?? DEFAULT_RESPONSE_TTL_SECONDS;
  const expires = BigInt(Math.floor(Date.now() / 1000) + ttl);

  const messageHash = makeSignatureHash({ target, expires, request, result });
  const signature = await sign({ hash: messageHash, privateKey, to: "hex" });

  const data = encodeAbiParameters(
    [{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }],
    [result, expires, signature as Hex],
  );

  return { data, expires, signature: signature as Hex, messageHash };
}
