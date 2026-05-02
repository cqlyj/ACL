import { describe, expect, test } from "bun:test";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ACL_JOB_PROPOSAL_DOMAIN_NAME,
  ACL_JOB_PROPOSAL_DOMAIN_VERSION,
  JOB_PROPOSAL_TYPES,
  type JobProposal,
  buildJobProposalDomain,
} from "./eip712.js";

const SAMPLE_DOMAIN = buildJobProposalDomain({
  chainId: 16_602,
  agenticCommerce: "0x38A5c19134C1a922E52eBd3c3F96eBb47f5582B4",
});

const SAMPLE_PROPOSAL: JobProposal = {
  client: "0xa38d4fa8de96C0284a079B10d27A68c8C15C3dd6",
  provider: "0xcC802eCCAaeb58D8Ef00F2aa5A2ABF94B64FC0A3",
  evaluator: "0x120C1fc5B7f357c0254cDC8027970DDD6405e115",
  paymentToken: "0x8Cc99bd97CD8cc7A7da1c9859415773FDa23e50c",
  amount: 100_000_000n,
  hook: "0x10C2c2D7cE63597BC8EAf3Dc75926a73092FeaE2",
  taskSpecHash: "0xdea49acb96e7235b13237fa925677f281831230658cea3ccb6cb52aad35e3d61",
  expiresAt: 1_777_475_084n,
  nonce: "0xa12ee9af834a62fde27a154a2802d07e7cfd1800bc152ebfedd0d6d039ec9903",
};

describe("JobProposal EIP-712 domain", () => {
  test("pins the canonical name + version", () => {
    expect(SAMPLE_DOMAIN.name).toBe(ACL_JOB_PROPOSAL_DOMAIN_NAME);
    expect(SAMPLE_DOMAIN.version).toBe(ACL_JOB_PROPOSAL_DOMAIN_VERSION);
  });

  test("pins chainId + verifyingContract from the deployment", () => {
    expect(SAMPLE_DOMAIN.chainId).toBe(16_602);
    expect(SAMPLE_DOMAIN.verifyingContract.toLowerCase()).toBe(
      "0x38a5c19134c1a922e52ebd3c3f96ebb47f5582b4",
    );
  });
});

describe("JobProposal EIP-712 typed-data hashing", () => {
  test("produces a deterministic 32-byte digest", () => {
    const digest = hashTypedData({
      domain: SAMPLE_DOMAIN,
      types: JOB_PROPOSAL_TYPES,
      primaryType: "JobProposal",
      message: SAMPLE_PROPOSAL,
    });
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("different chainId → different digest (replay protection)", () => {
    const digest1 = hashTypedData({
      domain: SAMPLE_DOMAIN,
      types: JOB_PROPOSAL_TYPES,
      primaryType: "JobProposal",
      message: SAMPLE_PROPOSAL,
    });
    const digest2 = hashTypedData({
      domain: { ...SAMPLE_DOMAIN, chainId: 1 },
      types: JOB_PROPOSAL_TYPES,
      primaryType: "JobProposal",
      message: SAMPLE_PROPOSAL,
    });
    expect(digest1).not.toBe(digest2);
  });

  test("different verifyingContract → different digest", () => {
    const digest1 = hashTypedData({
      domain: SAMPLE_DOMAIN,
      types: JOB_PROPOSAL_TYPES,
      primaryType: "JobProposal",
      message: SAMPLE_PROPOSAL,
    });
    const digest2 = hashTypedData({
      domain: {
        ...SAMPLE_DOMAIN,
        verifyingContract: "0x0000000000000000000000000000000000000001",
      },
      types: JOB_PROPOSAL_TYPES,
      primaryType: "JobProposal",
      message: SAMPLE_PROPOSAL,
    });
    expect(digest1).not.toBe(digest2);
  });

  test("different hook → different digest (so dual-signed proposal pins hook)", () => {
    const digest1 = hashTypedData({
      domain: SAMPLE_DOMAIN,
      types: JOB_PROPOSAL_TYPES,
      primaryType: "JobProposal",
      message: SAMPLE_PROPOSAL,
    });
    const digest2 = hashTypedData({
      domain: SAMPLE_DOMAIN,
      types: JOB_PROPOSAL_TYPES,
      primaryType: "JobProposal",
      message: {
        ...SAMPLE_PROPOSAL,
        hook: "0x0000000000000000000000000000000000000002",
      },
    });
    expect(digest1).not.toBe(digest2);
  });

  test("signature recovers to the signing address", async () => {
    const account = privateKeyToAccount(
      "0x40678d56fbebb4b14075ad5e813ee36d017039d041ba25401c8c0be8111cfc90",
    );
    const signature = await account.signTypedData({
      domain: SAMPLE_DOMAIN,
      types: JOB_PROPOSAL_TYPES,
      primaryType: "JobProposal",
      message: SAMPLE_PROPOSAL,
    });
    const recovered = await recoverTypedDataAddress({
      domain: SAMPLE_DOMAIN,
      types: JOB_PROPOSAL_TYPES,
      primaryType: "JobProposal",
      message: SAMPLE_PROPOSAL,
      signature,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });
});
