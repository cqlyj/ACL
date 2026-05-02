import {
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeErrorResult,
  parseAbiParameters,
  slice,
  toFunctionSelector,
} from "viem";

/**
 * ENSIP-21 Batch Gateway Offchain Lookup Protocol (BGOLP).
 *
 * The Universal Resolver wraps multiple parallel `OffchainLookup` reverts
 * (one per ENS resolver call) into a single outer `OffchainLookup` whose
 * inner calldata is `IBatchGateway.query(Request[])` (selector
 * `0xa780bab6`). The gateway answering that outer lookup MUST decode the
 * `Request[]` payload, dispatch each subrequest individually (locally or
 * by HTTP-forwarding to its `urls`), and return
 * `(bool[] failures, bytes[] responses)` ABI-encoded as the body bytes.
 *
 * Spec: https://docs.ens.domains/ensip/21
 */

/** Solidity ABI signature for `IBatchGateway.query`. */
const BATCH_GATEWAY_QUERY_ABI = parseAbiParameters([
  "(address sender, string[] urls, bytes data)[] requests",
]);

const BATCH_GATEWAY_RESPONSE_ABI = parseAbiParameters("bool[] failures, bytes[] responses");

/** Function selector for `query((address,string[],bytes)[])` — `0xa780bab6`. */
export const BATCH_GATEWAY_QUERY_SELECTOR = toFunctionSelector(
  "function query((address sender, string[] urls, bytes data)[] requests) view returns (bool[] failures, bytes[] responses)",
);

/** Solidity error used to signal an HTTP failure for a single subrequest. */
export const BATCH_GATEWAY_HTTP_ERROR_ABI = [
  {
    type: "error",
    name: "HttpError",
    inputs: [
      { name: "status", type: "uint16" },
      { name: "message", type: "string" },
    ],
  },
] as const;

/** Single offchain lookup request as it appears inside `query`. */
export type BatchGatewayRequest = {
  sender: Address;
  urls: readonly string[];
  data: Hex;
};

/** Inspect the leading 4 bytes of arbitrary calldata and decide whether it
 *  targets the BGOLP `query` entrypoint. */
export function isBatchGatewayQuery(callData: Hex): boolean {
  if (callData.length < BATCH_GATEWAY_QUERY_SELECTOR.length) return false;
  return slice(callData, 0, 4).toLowerCase() === BATCH_GATEWAY_QUERY_SELECTOR;
}

/**
 * Decode `IBatchGateway.query` calldata into the list of subrequests. Throws
 * with a descriptive message when the selector or argument layout doesn't
 * match the spec, so the HTTP layer can return a 400 instead of a 500.
 */
export function decodeBatchGatewayQuery(callData: Hex): BatchGatewayRequest[] {
  if (!isBatchGatewayQuery(callData)) {
    throw new Error(
      `decodeBatchGatewayQuery: expected selector ${BATCH_GATEWAY_QUERY_SELECTOR}, got ${slice(
        callData,
        0,
        4,
      )}`,
    );
  }
  const args = `0x${callData.slice(BATCH_GATEWAY_QUERY_SELECTOR.length)}` as Hex;
  const [requests] = decodeAbiParameters(BATCH_GATEWAY_QUERY_ABI, args);
  return requests.map((r) => ({
    sender: r.sender as Address,
    urls: r.urls as readonly string[],
    data: r.data as Hex,
  }));
}

/**
 * ABI-encode the BGOLP response tuple. `failures[i] === true` means
 * `responses[i]` is an ABI-encoded error (either `Error(string)` or
 * `HttpError(uint16,string)`); otherwise `responses[i]` is the raw bytes
 * the corresponding subrequest's CCIP-Read URL would have returned.
 */
export function encodeBatchGatewayResponse(
  failures: readonly boolean[],
  responses: readonly Hex[],
): Hex {
  if (failures.length !== responses.length) {
    throw new Error(
      `encodeBatchGatewayResponse: failures.length (${failures.length}) !== responses.length (${responses.length})`,
    );
  }
  return encodeAbiParameters(BATCH_GATEWAY_RESPONSE_ABI, [
    failures as boolean[],
    responses as Hex[],
  ]);
}

/** ABI-encode a `string`-typed Solidity `Error(string)` revert. */
export function encodeStringError(message: string): Hex {
  return encodeErrorResult({
    abi: [
      {
        type: "error",
        name: "Error",
        inputs: [{ name: "message", type: "string" }],
      },
    ],
    errorName: "Error",
    args: [message],
  });
}

/** ABI-encode the canonical ENSIP-21 `HttpError(uint16,string)` revert. */
export function encodeHttpError(status: number, message: string): Hex {
  return encodeErrorResult({
    abi: BATCH_GATEWAY_HTTP_ERROR_ABI,
    errorName: "HttpError",
    args: [status, message],
  });
}
