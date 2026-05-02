import { type Hex, decodeAbiParameters, encodeAbiParameters, slice } from "viem";

/**
 * Resolver inner-call selectors. The CCIP-Read gateway must inspect the
 * leading 4 bytes of the inner `data` payload to know which resolver
 * function the client invoked, and ABI-encode the response shape it
 * expects.
 */
export const RESOLVER_SELECTORS = {
  addr: "0x3b3b57de", // addr(bytes32)
  addrMulticoin: "0xf1cb7e06", // addr(bytes32,uint256)
  text: "0x59d1d43c", // text(bytes32,string)
  contenthash: "0xbc1c58d1", // contenthash(bytes32)
} as const;

export type ResolverCall =
  | { kind: "addr"; node: Hex }
  | { kind: "addrMulticoin"; node: Hex; coinType: bigint }
  | { kind: "text"; node: Hex; key: string }
  | { kind: "contenthash"; node: Hex }
  | { kind: "unknown"; selector: Hex };

export function decodeResolverCall(data: Hex): ResolverCall {
  const selector = slice(data, 0, 4) as Hex;
  const args = `0x${data.slice(10)}` as Hex;
  switch (selector) {
    case RESOLVER_SELECTORS.addr: {
      const [node] = decodeAbiParameters([{ type: "bytes32" }], args);
      return { kind: "addr", node: node as Hex };
    }
    case RESOLVER_SELECTORS.addrMulticoin: {
      const [node, coinType] = decodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }],
        args,
      );
      return {
        kind: "addrMulticoin",
        node: node as Hex,
        coinType: coinType as bigint,
      };
    }
    case RESOLVER_SELECTORS.text: {
      const [node, key] = decodeAbiParameters([{ type: "bytes32" }, { type: "string" }], args);
      return { kind: "text", node: node as Hex, key: key as string };
    }
    case RESOLVER_SELECTORS.contenthash: {
      const [node] = decodeAbiParameters([{ type: "bytes32" }], args);
      return { kind: "contenthash", node: node as Hex };
    }
    default:
      return { kind: "unknown", selector };
  }
}

/** ABI-encode an `address` resolver result as expected by ENS clients. */
export function encodeAddrResult(addr: Hex): Hex {
  return encodeAbiParameters([{ type: "address" }], [addr]);
}

/** ABI-encode a `string` resolver result. */
export function encodeTextResult(value: string): Hex {
  return encodeAbiParameters([{ type: "string" }], [value]);
}

/** ABI-encode a `bytes` resolver result (used for contenthash + multicoin addr). */
export function encodeBytesResult(value: Hex): Hex {
  return encodeAbiParameters([{ type: "bytes" }], [value]);
}
