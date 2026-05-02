/**
 * Shared decoder for `ACLIdentityRegistry` metadata values.
 *
 * Every metadata value is stored on chain as ABI-encoded bytes, but the
 * encoding shape depends on the key:
 *
 * | key                                                   | abi type     |
 * | ----------------------------------------------------- | ------------ |
 * | `acl.evaluator-address`                               | `address`    |
 * | `acl.payment-tokens`                                  | `address[]`  |
 * | `acl.min-budget`, `acl.chain-id`                      | `uint256`    |
 * | `acl.task-domains`, `acl.delivery-types`,             | utf-8 bytes  |
 * | `acl.axl-peer-id`, `acl.ens-label`, `agent-context`   |              |
 *
 * Both the gateway (`@acl/gateway/indexer`) and the discovery layer
 * (`@acl/discovery/profile`) need to surface these as plain strings —
 * the gateway over CCIP-Read, the discovery layer in `AgentProfile`.
 * Centralising here keeps the two paths byte-identical.
 */
import { type Address, type Hex, bytesToString, decodeAbiParameters, hexToBytes } from "viem";

import { ACL_METADATA_KEYS, type AclMetadataKey } from "./types.js";

/**
 * Decode a single metadata value according to its on-chain encoding
 * type. Returns the typed shape (address, address[], bigint, or string)
 * — see {@link decodeMetadataAsText} for the gateway / discovery
 * representation that always returns a string.
 */
export const decodeMetadata = {
  asAddress(value: Hex): Address {
    const [addr] = decodeAbiParameters([{ type: "address" }], value);
    return addr as Address;
  },
  asAddressArray(value: Hex): Address[] {
    const [arr] = decodeAbiParameters([{ type: "address[]" }], value);
    return arr as Address[];
  },
  asUint256(value: Hex): bigint {
    const [n] = decodeAbiParameters([{ type: "uint256" }], value);
    return n as bigint;
  },
  /**
   * Decode UTF-8 bytes verbatim — used for the free-form text keys
   * (`acl.task-domains`, `acl.delivery-types`, `acl.axl-peer-id`,
   * `acl.ens-label`, `agent-context`). Returns `""` on malformed
   * input so callers can short-circuit safely.
   */
  asString(value: Hex): string {
    if (value === "0x") return "";
    try {
      return bytesToString(hexToBytes(value));
    } catch {
      return "";
    }
  },
};

/**
 * Decode a metadata value into the same `string` representation the
 * gateway and discovery profile builders surface. The encoding is
 * key-dispatched; unknown keys (incl. the synthetic `acl.agent-id`)
 * yield `""`.
 */
export function decodeMetadataAsText(key: AclMetadataKey, raw: Hex): string {
  if (raw === "0x") return "";
  switch (key) {
    case ACL_METADATA_KEYS.evaluatorAddress:
      return decodeMetadata.asAddress(raw);
    case ACL_METADATA_KEYS.paymentTokens:
      return decodeMetadata.asAddressArray(raw).join(",");
    case ACL_METADATA_KEYS.minBudget:
    case ACL_METADATA_KEYS.chainId:
      return decodeMetadata.asUint256(raw).toString();
    case ACL_METADATA_KEYS.agentAddress:
      // `agentAddress` is ABI-encoded as `address`. Surface as a
      // checksummed 0x-string so consumers reading the value through
      // ENS `text()` (rather than `addr()`) get the correct hex.
      return decodeMetadata.asAddress(raw);
    case ACL_METADATA_KEYS.taskDomains:
    case ACL_METADATA_KEYS.deliveryTypes:
    case ACL_METADATA_KEYS.axlPeerId:
    case ACL_METADATA_KEYS.ensLabel:
    case ACL_METADATA_KEYS.agentContext:
      // ENSIP-26 leaves `agent-context` as opaque UTF-8. Decode the
      // raw bytes here; downstream `parseAgentContext` JSON-parses
      // leniently (any non-JSON yields `capabilities: []`).
      return decodeMetadata.asString(raw);
    case ACL_METADATA_KEYS.agentId:
      // Synthetic record served by the gateway directly; never read
      // through this decoder.
      return "";
  }
}
