import { describe, expect, test } from "bun:test";
import { ACL_METADATA_KEYS, buildAgentRegistrationKey } from "@acl/core";
import {
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  isAddressEqual,
  namehash,
  toHex,
} from "viem";
import { packetToBytes } from "viem/ens";
import type { IdentityRegistryIndexer } from "./indexer.js";
import { ResolverService } from "./resolver-service.js";

/**
 * Unit tests for the gateway's pure resolver layer. These exercise the
 * stateless decoder + selector logic without the HTTP / signing surface,
 * so any regression in DNS-name parsing, label scoping, ABI shapes or
 * ENSIP-25 verification surfaces here before the integration tests.
 */

const PARENT = "acl.eth";
const REGISTRY = "0x301c4b1Acf4f043ff4aE0907C938062792f5435E" as Address;
const CHAIN_ID = 16_602;
const AGENT_ADDRESS = "0xcC802eCCAaeb58D8Ef00F2aa5A2ABF94B64FC0A3" as Address;
const EVALUATOR = "0x120C1fc5B7f357c0254cDC8027970DDD6405e115" as Address;
const PAYMENT_TOKENS = [
  "0x8Cc99bd97CD8cc7A7da1c9859415773FDa23e50c",
  "0xa38d4fa8de96C0284a079B10d27A68c8C15C3dd6",
] as Address[];
const AXL_PEER = "cc774d96b8c51763eb62d679501fa932b7e2c0218fbed7b48a683bdd37fa46c2";

/**
 * Test double for {@link IdentityRegistryIndexer}. We satisfy the methods
 * the resolver service actually calls (`agentIdForLabel`, `metadata`); the
 * full backfill / polling surface is irrelevant here and we don't want to
 * stand a real client up just to populate a map.
 */
function makeMockIndexer(opts: {
  label: string;
  agentId: bigint;
  metadata: Record<string, Hex>;
}): IdentityRegistryIndexer {
  return {
    agentIdForLabel(label: string): bigint | null {
      return label.toLowerCase() === opts.label.toLowerCase() ? opts.agentId : null;
    },
    metadata(agentId: bigint, key: string): Hex | undefined {
      if (agentId !== opts.agentId) return undefined;
      return opts.metadata[key];
    },
  } as unknown as IdentityRegistryIndexer;
}

function mockFor(label: string, agentId: bigint) {
  return makeMockIndexer({
    label,
    agentId,
    metadata: {
      [ACL_METADATA_KEYS.agentAddress]: encodeAbiParameters([{ type: "address" }], [AGENT_ADDRESS]),
      [ACL_METADATA_KEYS.evaluatorAddress]: encodeAbiParameters([{ type: "address" }], [EVALUATOR]),
      [ACL_METADATA_KEYS.paymentTokens]: encodeAbiParameters(
        [{ type: "address[]" }],
        [PAYMENT_TOKENS],
      ),
      [ACL_METADATA_KEYS.minBudget]: encodeAbiParameters([{ type: "uint256" }], [100_000_000n]),
      [ACL_METADATA_KEYS.chainId]: encodeAbiParameters([{ type: "uint256" }], [BigInt(CHAIN_ID)]),
      [ACL_METADATA_KEYS.taskDomains]:
        `0x${Buffer.from("Quantum,Computing").toString("hex")}` as Hex,
      [ACL_METADATA_KEYS.deliveryTypes]: `0x${Buffer.from("text/markdown").toString("hex")}` as Hex,
      [ACL_METADATA_KEYS.axlPeerId]: `0x${Buffer.from(AXL_PEER).toString("hex")}` as Hex,
      [ACL_METADATA_KEYS.ensLabel]: `0x${Buffer.from(label).toString("hex")}` as Hex,
    },
  });
}

function buildService(label: string, agentId: bigint): ResolverService {
  return new ResolverService({
    indexer: mockFor(label, agentId),
    parentName: PARENT,
    registryChainId: CHAIN_ID,
    registryAddress: REGISTRY,
  });
}

function dnsName(name: string): Hex {
  return toHex(packetToBytes(name));
}

function encodeAddrCall(name: string): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "addr",
        stateMutability: "view",
        inputs: [{ type: "bytes32", name: "node" }],
        outputs: [{ type: "address" }],
      },
    ],
    functionName: "addr",
    args: [namehash(name)],
  });
}

function encodeTextCall(name: string, key: string): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "text",
        stateMutability: "view",
        inputs: [
          { type: "bytes32", name: "node" },
          { type: "string", name: "key" },
        ],
        outputs: [{ type: "string" }],
      },
    ],
    functionName: "text",
    args: [namehash(name), key],
  });
}

describe("ResolverService.resolve — addr(node)", () => {
  test("returns the agent's checksummed address for a known label", () => {
    const svc = buildService("researcher", 1n);
    const { result } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: encodeAddrCall("researcher.acl.eth"),
    });
    const [addr] = decodeAbiParameters([{ type: "address" }], result);
    expect(isAddressEqual(addr as Address, AGENT_ADDRESS)).toBe(true);
  });

  test("returns the zero address for an unknown label", () => {
    const svc = buildService("researcher", 1n);
    const { result } = svc.resolve({
      dnsName: dnsName("ghost.acl.eth"),
      innerData: encodeAddrCall("ghost.acl.eth"),
    });
    const [addr] = decodeAbiParameters([{ type: "address" }], result);
    expect(addr).toBe("0x0000000000000000000000000000000000000000");
  });

  test("returns the zero address for the parent name itself", () => {
    const svc = buildService("researcher", 1n);
    const { result } = svc.resolve({
      dnsName: dnsName(PARENT),
      innerData: encodeAddrCall(PARENT),
    });
    const [addr] = decodeAbiParameters([{ type: "address" }], result);
    expect(addr).toBe("0x0000000000000000000000000000000000000000");
  });

  test("returns the zero address for a deep subname (no inheritance)", () => {
    const svc = buildService("researcher", 1n);
    const { result } = svc.resolve({
      dnsName: dnsName("sub.researcher.acl.eth"),
      innerData: encodeAddrCall("sub.researcher.acl.eth"),
    });
    const [addr] = decodeAbiParameters([{ type: "address" }], result);
    expect(addr).toBe("0x0000000000000000000000000000000000000000");
  });
});

describe("ResolverService.resolve — text(node, key) decoding", () => {
  test("acl.evaluator-address returns the evaluator address as a string", () => {
    const svc = buildService("researcher", 1n);
    const { result } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: encodeTextCall("researcher.acl.eth", ACL_METADATA_KEYS.evaluatorAddress),
    });
    const [text] = decodeAbiParameters([{ type: "string" }], result);
    expect((text as string).toLowerCase()).toBe(EVALUATOR.toLowerCase());
  });

  test("acl.payment-tokens flattens the on-chain address[] to comma-separated checksum addresses", () => {
    const svc = buildService("researcher", 1n);
    const { result } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: encodeTextCall("researcher.acl.eth", ACL_METADATA_KEYS.paymentTokens),
    });
    const [text] = decodeAbiParameters([{ type: "string" }], result);
    const tokens = (text as string).split(",");
    expect(tokens).toHaveLength(PAYMENT_TOKENS.length);
    for (let i = 0; i < tokens.length; i++) {
      expect(tokens[i]?.toLowerCase()).toBe(PAYMENT_TOKENS[i]!.toLowerCase());
    }
  });

  test("acl.min-budget returns a decimal string", () => {
    const svc = buildService("researcher", 1n);
    const { result } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: encodeTextCall("researcher.acl.eth", ACL_METADATA_KEYS.minBudget),
    });
    const [text] = decodeAbiParameters([{ type: "string" }], result);
    expect(text).toBe("100000000");
  });

  test("acl.task-domains preserves case (regression: legacy decoder lowercased)", () => {
    const svc = buildService("researcher", 1n);
    const { result } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: encodeTextCall("researcher.acl.eth", ACL_METADATA_KEYS.taskDomains),
    });
    const [text] = decodeAbiParameters([{ type: "string" }], result);
    expect(text).toBe("Quantum,Computing");
  });

  test("acl.delivery-types preserves case for MIME-shaped values", () => {
    const svc = buildService("researcher", 1n);
    const { result } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: encodeTextCall("researcher.acl.eth", ACL_METADATA_KEYS.deliveryTypes),
    });
    const [text] = decodeAbiParameters([{ type: "string" }], result);
    expect(text).toBe("text/markdown");
  });

  test("synthetic acl.agent-id returns the indexer label hit as a decimal string", () => {
    const svc = buildService("researcher", 7n);
    const { result } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: encodeTextCall("researcher.acl.eth", ACL_METADATA_KEYS.agentId),
    });
    const [text] = decodeAbiParameters([{ type: "string" }], result);
    expect(text).toBe("7");
  });

  test("unknown text key returns the empty string (canonical ENS empty record)", () => {
    const svc = buildService("researcher", 1n);
    const { result } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: encodeTextCall("researcher.acl.eth", "x.com"),
    });
    const [text] = decodeAbiParameters([{ type: "string" }], result);
    expect(text).toBe("");
  });
});

describe("ResolverService.resolve — ENSIP-25 self-attestation", () => {
  test("returns '1' when the parameterised key matches the resolved agent", () => {
    const svc = buildService("researcher", 1n);
    const ensip25Key = buildAgentRegistrationKey({
      chainId: CHAIN_ID,
      registry: REGISTRY,
      agentId: 1n,
    });
    const { result } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: encodeTextCall("researcher.acl.eth", ensip25Key),
    });
    const [text] = decodeAbiParameters([{ type: "string" }], result);
    expect(text).toBe("1");
  });

  test("returns empty when the agentId in the key doesn't match", () => {
    const svc = buildService("researcher", 1n);
    const ensip25KeyForOtherAgent = buildAgentRegistrationKey({
      chainId: CHAIN_ID,
      registry: REGISTRY,
      agentId: 2n,
    });
    const { result } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: encodeTextCall("researcher.acl.eth", ensip25KeyForOtherAgent),
    });
    const [text] = decodeAbiParameters([{ type: "string" }], result);
    expect(text).toBe("");
  });

  test("returns empty when the registry address in the key doesn't match", () => {
    const svc = buildService("researcher", 1n);
    const ensip25KeyForOtherRegistry = buildAgentRegistrationKey({
      chainId: CHAIN_ID,
      registry: "0x0000000000000000000000000000000000000001",
      agentId: 1n,
    });
    const { result } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: encodeTextCall("researcher.acl.eth", ensip25KeyForOtherRegistry),
    });
    const [text] = decodeAbiParameters([{ type: "string" }], result);
    expect(text).toBe("");
  });
});

describe("ResolverService.resolve — multicoin addr(node, coinType)", () => {
  test("coinType 60 (ETH) returns the agent address as bytes", () => {
    const svc = buildService("researcher", 1n);
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "addr",
          stateMutability: "view",
          inputs: [
            { type: "bytes32", name: "node" },
            { type: "uint256", name: "coinType" },
          ],
          outputs: [{ type: "bytes" }],
        },
      ],
      functionName: "addr",
      args: [namehash("researcher.acl.eth"), 60n],
    });
    const { result } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: data,
    });
    const [bytes] = decodeAbiParameters([{ type: "bytes" }], result);
    expect((bytes as Hex).toLowerCase()).toBe(AGENT_ADDRESS.toLowerCase());
  });

  test("non-ETH coinType returns empty bytes", () => {
    const svc = buildService("researcher", 1n);
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "addr",
          stateMutability: "view",
          inputs: [
            { type: "bytes32", name: "node" },
            { type: "uint256", name: "coinType" },
          ],
          outputs: [{ type: "bytes" }],
        },
      ],
      functionName: "addr",
      args: [namehash("researcher.acl.eth"), 0n],
    });
    const { result } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: data,
    });
    const [bytes] = decodeAbiParameters([{ type: "bytes" }], result);
    expect(bytes).toBe("0x");
  });
});

describe("ResolverService.resolve — meta channel for telemetry", () => {
  test("propagates the parsed name + label + agentId on a hit", () => {
    const svc = buildService("researcher", 42n);
    const { meta } = svc.resolve({
      dnsName: dnsName("researcher.acl.eth"),
      innerData: encodeAddrCall("researcher.acl.eth"),
    });
    expect(meta.name).toBe("researcher.acl.eth");
    expect(meta.label).toBe("researcher");
    expect(meta.agentId).toBe(42n);
    expect(meta.call.kind).toBe("addr");
  });

  test("reports `agentId: null` for an unknown label", () => {
    const svc = buildService("researcher", 1n);
    const { meta } = svc.resolve({
      dnsName: dnsName("ghost.acl.eth"),
      innerData: encodeAddrCall("ghost.acl.eth"),
    });
    expect(meta.label).toBe("ghost");
    expect(meta.agentId).toBeNull();
  });
});
