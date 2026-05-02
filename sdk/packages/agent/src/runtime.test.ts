import { describe, expect, test } from "bun:test";
import { ACL_TESTNET } from "@acl/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type AgentEthersSigner, createAgentRuntime, pickRuntimeOverrides } from "./runtime.js";

const PK = generatePrivateKey();

describe("createAgentRuntime", () => {
  test("wires deployment + chain + clients + signer from a private key", () => {
    const runtime = createAgentRuntime({ account: PK });
    expect(runtime.deployment).toBe(ACL_TESTNET);
    expect(runtime.address).toBe(privateKeyToAccount(PK).address);
    expect(runtime.chain.id).toBe(ACL_TESTNET.galileo.chainId);
    expect(runtime.galileoRpcUrl).toBe(ACL_TESTNET.galileo.rpcUrl);
    // Storage and walletClient must be present so any consumer that
    // composes the SDK primitives on top of `createAgentRuntime` can
    // reach the 0G Storage helpers and submit on-chain txs without
    // re-wiring viem / ethers themselves.
    expect(typeof runtime.storage.uploadJson).toBe("function");
    expect(runtime.walletClient.account?.address).toBe(runtime.address);
  });

  test("accepts a pre-built LocalAccount and delegates ethers signer to caller", () => {
    const account = privateKeyToAccount(PK);
    const fakeSigner = {} as AgentEthersSigner;
    const runtime = createAgentRuntime({
      account,
      ethersSigner: fakeSigner,
    });
    expect(runtime.account).toBe(account);
    expect(runtime.ethersSigner).toBe(fakeSigner);
  });

  test("rejects a non-private-key account when no ethersSigner is supplied", () => {
    const account = privateKeyToAccount(PK);
    expect(() => createAgentRuntime({ account })).toThrow(/pass `ethersSigner` explicitly/);
  });
});

describe("pickRuntimeOverrides", () => {
  test("returns an empty object when nothing is overridden", () => {
    expect(pickRuntimeOverrides({})).toEqual({});
  });

  test("forwards only the runtime-relevant overrides, ignoring unrelated fields", () => {
    const picked = pickRuntimeOverrides({
      galileoRpcUrl: "https://galileo.example",
      sepoliaRpcUrl: "https://sepolia.example",
      pollingIntervalMs: 1234,
      // @ts-expect-error sanity: extra fields are tolerated at runtime
      // because pickRuntimeOverrides is about narrowing inputs, not
      // type-checking them. This guards against a regression where the
      // helper accidentally propagated fields like `events` or `llm`
      // into createAgentRuntime and triggered an exactOptionalPropertyTypes
      // failure downstream.
      events: "should-be-ignored",
    });
    expect(picked).toEqual({
      galileoRpcUrl: "https://galileo.example",
      sepoliaRpcUrl: "https://sepolia.example",
      pollingIntervalMs: 1234,
    });
  });

  test("omits keys whose value is undefined (exactOptionalPropertyTypes-safe)", () => {
    // Cast through `unknown` so we can deliberately exercise the
    // `=== undefined` branch even with exactOptionalPropertyTypes
    // turned on at compile time. The runtime contract is what we're
    // pinning here: explicit `undefined` values must be dropped, not
    // forwarded.
    const picked = pickRuntimeOverrides({
      galileoRpcUrl: undefined,
      sepoliaRpcUrl: "https://sepolia.example",
    } as unknown as Parameters<typeof pickRuntimeOverrides>[0]);
    expect(Object.keys(picked)).toEqual(["sepoliaRpcUrl"]);
  });
});
