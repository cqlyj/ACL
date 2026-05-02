import { describe, expect, test } from "bun:test";
import { ACL_TESTNET, INFT_DELIVERY_TYPE, INFT_POINTER_CONTENT_TYPE } from "@acl/core";
import type { TaskSpec } from "@acl/core";
import type { Address, PublicClient, WalletClient } from "viem";

import { inftDeliverableCommitment } from "./hook.js";
import { inftSaleDeliverableStrategy } from "./sale-deliverable.js";

const PROVIDER: Address = "0x0000000000000000000000000000000000000abc";

const baseInput = (deliveryType: string) => ({
  jobId: 1n,
  taskSpec: {
    deliveryType,
    description: "test",
    requirements: [],
    paymentToken: "0x0000000000000000000000000000000000000001" as Address,
    minBudget: 0n,
    maxBudget: 0n,
    expectedTurnaroundSeconds: 60,
  } as unknown as TaskSpec,
  provider: PROVIDER,
  taskSpecRoot: `0x${"00".repeat(32)}` as `0x${string}`,
});

// We never actually invoke `beforeSubmit` in these tests (they'd
// fan out to viem write calls), so the public/wallet client stubs
// only need to be type-shaped. The factory does NOT call them up
// front, so this is safe.
const stubPublicClient = {} as unknown as PublicClient;
const stubWalletClient = {} as unknown as WalletClient;

describe("inftSaleDeliverableStrategy", () => {
  test("returns null for non-iNFT delivery types so Flow-1 falls through to default", async () => {
    const strategy = inftSaleDeliverableStrategy({
      publicClient: stubPublicClient,
      walletClient: stubWalletClient,
      deployment: ACL_TESTNET,
      tokenId: 7n,
      providerAgentId: 42n,
    });
    expect(await strategy(baseInput("text"))).toBeNull();
    expect(await strategy(baseInput("application/json"))).toBeNull();
  });

  test("for iNFT deliveryType returns the canonical pointer commitment + skipStorageUpload", async () => {
    const strategy = inftSaleDeliverableStrategy({
      publicClient: stubPublicClient,
      walletClient: stubWalletClient,
      deployment: ACL_TESTNET,
      tokenId: 7n,
      providerAgentId: 42n,
    });
    const out = await strategy(baseInput(INFT_DELIVERY_TYPE));
    expect(out).not.toBeNull();
    if (!out) throw new Error("unreachable");
    const expectedDeliverable = inftDeliverableCommitment({
      nftContract: ACL_TESTNET.galileo.aclAgentNFT,
      tokenId: 7n,
      providerAgentId: 42n,
    });
    expect(out.deliverable).toBe(expectedDeliverable);
    expect(out.contentType).toBe(INFT_POINTER_CONTENT_TYPE);
    expect(out.skipStorageUpload).toBe(true);
    expect(typeof out.beforeSubmit).toBe("function");
  });

  test("contractAddress override changes the pointer commitment domain", async () => {
    const customNft: Address = "0x9999999999999999999999999999999999999999";
    const strategy = inftSaleDeliverableStrategy({
      publicClient: stubPublicClient,
      walletClient: stubWalletClient,
      deployment: ACL_TESTNET,
      tokenId: 7n,
      providerAgentId: 42n,
      contractAddress: customNft,
    });
    const out = await strategy(baseInput(INFT_DELIVERY_TYPE));
    if (!out) throw new Error("unreachable");
    expect(out.deliverable).toBe(
      inftDeliverableCommitment({
        nftContract: customNft,
        tokenId: 7n,
        providerAgentId: 42n,
      }),
    );
  });
});
