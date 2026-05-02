import {
  ACL_METADATA_KEYS,
  ENSIP25_ATTESTATION_VALUE,
  buildAgentRegistrationKey,
  decodeMetadata,
  decodeMetadataAsText,
} from "@acl/core";
import { type Address, type Hex, decodeAbiParameters, encodeAbiParameters, namehash } from "viem";
import { decodeDnsName, isSingleLabel, subLabelUnder } from "./dns-name.js";
import type { IdentityRegistryIndexer } from "./indexer.js";
import {
  type ResolverCall,
  decodeResolverCall,
  encodeAddrResult,
  encodeBytesResult,
  encodeTextResult,
} from "./resolver-call.js";

/**
 * Translate an ENS CCIP-Read inner call into a resolver result. Stateless,
 * pure given an indexer snapshot. Returning `0x` is a valid empty answer
 * (ENS clients accept it as "no record set"); throwing reserves true gateway
 * errors for the HTTP layer.
 */

export type ResolverServiceConfig = {
  indexer: IdentityRegistryIndexer;
  /** Parent ENS name (e.g. "acl.eth"). */
  parentName: string;
  /** Chain id where the IdentityRegistry lives. Used for ENSIP-25 verification. */
  registryChainId: number;
  /** Address of the IdentityRegistry. Used for ENSIP-25 verification. */
  registryAddress: Address;
};

export type ResolverServiceInput = {
  dnsName: Hex;
  innerData: Hex;
};

export type ResolverServiceResult = {
  result: Hex;
  /** Useful for logging/telemetry. */
  meta: {
    name: string;
    label: string | null;
    agentId: bigint | null;
    call: ResolverCall;
  };
};

export class ResolverService {
  constructor(private readonly cfg: ResolverServiceConfig) {}

  resolve(input: ResolverServiceInput): ResolverServiceResult {
    const { name } = decodeDnsName(input.dnsName);
    const call = decodeResolverCall(input.innerData);
    const label = subLabelUnder(name, this.cfg.parentName);

    if (label === null) {
      // The parent name itself: no agent backing — return empty for
      // everything until/unless we want to advertise registry-level data.
      return {
        result: this._emptyFor(call),
        meta: { name, label: null, agentId: null, call },
      };
    }

    if (!isSingleLabel(label)) {
      // Deep subname like `sub.foo.acl.eth`. The ACL registry binds one
      // agent per ENS label and does not inherit records to children, so
      // anything below a single-label child returns empty (i.e. ENS "no
      // record"). This is the canonical behaviour for unregistered ENS
      // names; callers wanting a different policy should layer their own
      // resolver service.
      return {
        result: this._emptyFor(call),
        meta: { name, label, agentId: null, call },
      };
    }

    const agentId = this.cfg.indexer.agentIdForLabel(label);
    if (agentId === null) {
      return {
        result: this._emptyFor(call),
        meta: { name, label, agentId: null, call },
      };
    }

    const result = this._resolveAgentCall(agentId, name, call);
    return {
      result,
      meta: { name, label, agentId, call },
    };
  }

  private _resolveAgentCall(agentId: bigint, name: string, call: ResolverCall): Hex {
    // ENSIP-10 sanity gate: every resolver call carries the original
    // ENS namehash as its first arg (`addr(bytes32)` / `text(bytes32,
    // string)` / `contenthash(bytes32)` / `addr(bytes32, uint256)`).
    // The hash MUST match the DNS-encoded name we decoded; mismatch
    // means the client is asking us to vouch for a name we never
    // verified, so we return the per-call empty answer rather than
    // serving the agent's data under a foreign label.
    if (
      call.kind !== "unknown" &&
      "node" in call &&
      call.node.toLowerCase() !== namehash(name).toLowerCase()
    ) {
      return this._emptyFor(call);
    }
    switch (call.kind) {
      case "addr": {
        const raw = this.cfg.indexer.metadata(agentId, ACL_METADATA_KEYS.agentAddress);
        if (!raw) return encodeAddrResult("0x0000000000000000000000000000000000000000");
        return encodeAddrResult(decodeMetadata.asAddress(raw));
      }
      case "addrMulticoin": {
        // Coin type 60 == ETH per SLIP-0044.
        if (call.coinType !== 60n) return encodeBytesResult("0x");
        const raw = this.cfg.indexer.metadata(agentId, ACL_METADATA_KEYS.agentAddress);
        if (!raw) return encodeBytesResult("0x");
        const addr = decodeMetadata.asAddress(raw);
        return encodeBytesResult(addr);
      }
      case "text": {
        const value = this._textRecord(agentId, call.key);
        return encodeTextResult(value);
      }
      case "contenthash":
        return encodeBytesResult("0x");
      case "unknown":
        return "0x";
    }
  }

  private _textRecord(agentId: bigint, key: string): string {
    if (key.startsWith("agent-registration[")) {
      return this._verifyEnsip25(agentId, key);
    }

    // Synthetic record: gateway computes from its label index. Lets clients
    // recover an agentId from a sub-name without a separate registry call.
    if (key === ACL_METADATA_KEYS.agentId) {
      return agentId.toString();
    }

    const raw = this.cfg.indexer.metadata(agentId, key);
    if (!raw) return "";

    if (_isCanonicalMetadataKey(key)) {
      // `agent-context` and the other canonical keys go through the
      // shared `decodeMetadataAsText` helper so the gateway, the
      // discovery layer, and any direct on-chain reader all surface
      // the same string for the same on-chain bytes.
      return decodeMetadataAsText(key, raw);
    }
    // Unknown key — best effort: treat as opaque UTF-8 bytes. ENS
    // clients still see a string; if a future ACL key adds a richer
    // encoding it should be added to `ACL_METADATA_KEYS` and the
    // shared decoder.
    return decodeMetadata.asString(raw);
  }

  /**
   * ENSIP-25 self-attestation: when a client asks for
   * `agent-registration[<7930>][<id>]`, return "1" if the parameters point
   * at THIS agent (registry+chain match our deployment, and id matches the
   * resolved agent), else "" (empty).
   *
   * Match is case-insensitive on the ERC-7930 hex payload to tolerate
   * verifiers that uppercase or mixed-case the binary form.
   */
  private _verifyEnsip25(agentId: bigint, key: string): string {
    const expected = buildAgentRegistrationKey({
      chainId: this.cfg.registryChainId,
      registry: this.cfg.registryAddress,
      agentId,
    }).toLowerCase();
    return key.toLowerCase() === expected ? ENSIP25_ATTESTATION_VALUE : "";
  }

  private _emptyFor(call: ResolverCall): Hex {
    switch (call.kind) {
      case "addr":
        return encodeAddrResult("0x0000000000000000000000000000000000000000");
      case "addrMulticoin":
      case "contenthash":
        return encodeBytesResult("0x");
      case "text":
        return encodeTextResult("");
      case "unknown":
        return "0x";
    }
  }
}

function _isCanonicalMetadataKey(
  key: string,
): key is (typeof ACL_METADATA_KEYS)[keyof typeof ACL_METADATA_KEYS] {
  return _CANONICAL_METADATA_KEYS.has(key);
}

const _CANONICAL_METADATA_KEYS = new Set<string>(Object.values(ACL_METADATA_KEYS));

/**
 * Decode the `IResolverService.resolve(name, data)` calldata that the
 * ACLOffchainResolver hands to the gateway. Selector is the `resolve(bytes,bytes)`
 * function selector (0x9061b923).
 */
export const RESOLVER_SERVICE_SELECTOR = "0x9061b923" as const;

export function decodeResolverServiceCall(callData: Hex): {
  name: Hex;
  data: Hex;
} {
  if (callData.slice(0, 10).toLowerCase() !== RESOLVER_SERVICE_SELECTOR) {
    throw new Error(
      `decodeResolverServiceCall: unexpected selector ${callData.slice(0, 10)}; expected ${RESOLVER_SERVICE_SELECTOR}`,
    );
  }
  const args = `0x${callData.slice(10)}` as Hex;
  const [name, data] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], args);
  return { name: name as Hex, data: data as Hex };
}

/**
 * Build the `extraData` payload that the resolver originally produced when
 * it threw `OffchainLookup`: `abi.encode(callData, address(this))`. The
 * gateway must reconstruct this exactly so the EIP-191 v0 hash matches what
 * `SignatureVerifier.verify` will recompute on-chain.
 *
 * Note: this layout is an intentional ACL deviation from the
 * ensdomains/offchain-resolver-example reference, which uses
 * `extraData = callData`. See the rationale in
 * `src/ens/ACLOffchainResolver.sol::resolve`. Both the resolver and this
 * gateway agree on the layout, but a third-party gateway following the
 * canonical reference will NOT produce signatures that
 * `ACLOffchainResolver.resolveWithProof` accepts.
 */
export function reconstructExtraData(params: {
  callData: Hex;
  resolver: Address;
}): Hex {
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "address" }],
    [params.callData, params.resolver],
  );
}
