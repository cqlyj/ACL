import { describe, expect, test } from "bun:test";
import { type JobProposal, buildJobProposalDomain } from "@acl/core";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TaskSpec } from "./messages.js";
import {
  assertTaskSpecMatchesProposal,
  deserializeJobProposal,
  generateNonce,
  hashTaskSpec,
  recoverJobProposalSigner,
  serializeJobProposal,
  signJobProposal,
  verifyJobProposalSignature,
} from "./proposal.js";

const DOMAIN = buildJobProposalDomain({
  chainId: 16_602,
  agenticCommerce: "0x38A5c19134C1a922E52eBd3c3F96eBb47f5582B4",
});

const SAMPLE_TASK: TaskSpec = {
  title: "Quantum error correction summary",
  objective: "Summarize the latest research on quantum error correction.",
  acceptanceCriteria: ["Cite at least 3 papers", "Markdown formatted"],
  requiredFormat: "markdown",
  deliveryType: "text",
  taskDomain: "science",
  createdAt: "2026-04-29T00:00:00.000Z",
};

describe("hashTaskSpec", () => {
  test("produces a 32-byte digest for a minimal spec", () => {
    expect(hashTaskSpec(SAMPLE_TASK)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("is canonical: object-key order does not change the hash", () => {
    const reordered: TaskSpec = {
      // Re-arrange every key — should match the original because we sort
      // keys recursively before hashing.
      createdAt: SAMPLE_TASK.createdAt,
      taskDomain: SAMPLE_TASK.taskDomain,
      deliveryType: SAMPLE_TASK.deliveryType,
      requiredFormat: SAMPLE_TASK.requiredFormat,
      acceptanceCriteria: SAMPLE_TASK.acceptanceCriteria,
      objective: SAMPLE_TASK.objective,
      title: SAMPLE_TASK.title,
    };
    expect(hashTaskSpec(reordered)).toBe(hashTaskSpec(SAMPLE_TASK));
  });

  test("preserves array order (acceptanceCriteria meaning is positional)", () => {
    const swapped: TaskSpec = {
      ...SAMPLE_TASK,
      acceptanceCriteria: [...SAMPLE_TASK.acceptanceCriteria].reverse(),
    };
    expect(hashTaskSpec(swapped)).not.toBe(hashTaskSpec(SAMPLE_TASK));
  });

  test("omitting an optional field is the same as setting it to its default", () => {
    const explicit: TaskSpec = {
      ...SAMPLE_TASK,
      extensions: {},
    };
    expect(hashTaskSpec(explicit)).toBe(hashTaskSpec(SAMPLE_TASK));
  });

  test("extensions hash with sorted keys but preserve nested array order", () => {
    const a = hashTaskSpec({
      ...SAMPLE_TASK,
      extensions: { tone: "concise", maxWords: 500 },
    });
    const b = hashTaskSpec({
      ...SAMPLE_TASK,
      extensions: { maxWords: 500, tone: "concise" },
    });
    expect(a).toBe(b);

    const c = hashTaskSpec({
      ...SAMPLE_TASK,
      extensions: { items: [1, 2, 3] },
    });
    const d = hashTaskSpec({
      ...SAMPLE_TASK,
      extensions: { items: [3, 2, 1] },
    });
    expect(c).not.toBe(d);
  });

  test("rejects bigint and non-finite numbers in extensions", () => {
    expect(() =>
      hashTaskSpec({
        ...SAMPLE_TASK,
        extensions: { big: 1n as unknown as number },
      }),
    ).toThrow();
    expect(() =>
      hashTaskSpec({
        ...SAMPLE_TASK,
        extensions: { broken: Number.NaN },
      }),
    ).toThrow();
  });

  test("matches a hand-rolled canonical reference", () => {
    // Pin a known good vector so future changes to canonicalize produce a
    // diff against this hash and the maintainer is forced to think about
    // whether peers downstream will still agree.
    const expected = keccak256(
      toBytes(
        JSON.stringify({
          acceptanceCriteria: SAMPLE_TASK.acceptanceCriteria,
          createdAt: SAMPLE_TASK.createdAt,
          deliveryType: SAMPLE_TASK.deliveryType,
          evaluationRubric: null,
          extensions: {},
          forbiddenClaims: null,
          objective: SAMPLE_TASK.objective,
          requiredFormat: SAMPLE_TASK.requiredFormat,
          taskDomain: SAMPLE_TASK.taskDomain,
          title: SAMPLE_TASK.title,
        }),
      ),
    );
    expect(hashTaskSpec(SAMPLE_TASK)).toBe(expected);
  });
});

describe("generateNonce", () => {
  test("produces 32 bytes of 0x-prefixed hex", () => {
    const n = generateNonce();
    expect(n).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("is monotonically distinct for back-to-back calls", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
  });
});

describe("assertTaskSpecMatchesProposal", () => {
  const proposal: JobProposal = {
    client: "0xa38d4fa8de96C0284a079B10d27A68c8C15C3dd6",
    provider: "0xcC802eCCAaeb58D8Ef00F2aa5A2ABF94B64FC0A3",
    evaluator: "0x120C1fc5B7f357c0254cDC8027970DDD6405e115",
    paymentToken: "0x8Cc99bd97CD8cc7A7da1c9859415773FDa23e50c",
    amount: 100n,
    hook: "0x10C2c2D7cE63597BC8EAf3Dc75926a73092FeaE2",
    taskSpecHash: hashTaskSpec(SAMPLE_TASK),
    expiresAt: 1_900_000_000n,
    nonce: "0xa12ee9af834a62fde27a154a2802d07e7cfd1800bc152ebfedd0d6d039ec9903",
  };

  test("passes when the body hashes to proposal.taskSpecHash", () => {
    expect(() => assertTaskSpecMatchesProposal(SAMPLE_TASK, proposal)).not.toThrow();
  });

  test("throws when the body has been mutated", () => {
    const tampered: TaskSpec = { ...SAMPLE_TASK, objective: "tampered" };
    expect(() => assertTaskSpecMatchesProposal(tampered, proposal)).toThrow(
      /taskSpec body does not match proposal\.taskSpecHash/,
    );
  });

  test("throws when the proposal hash has been mutated", () => {
    const tampered: JobProposal = {
      ...proposal,
      taskSpecHash: "0x".padEnd(66, "0") as `0x${string}`,
    };
    expect(() => assertTaskSpecMatchesProposal(SAMPLE_TASK, tampered)).toThrow(
      /taskSpec body does not match proposal\.taskSpecHash/,
    );
  });
});

describe("serialize / deserialize JobProposal", () => {
  const proposal: JobProposal = {
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

  test("round-trips bigints through string form", () => {
    const reverted = deserializeJobProposal(serializeJobProposal(proposal));
    expect(reverted).toEqual(proposal);
  });

  test("rejects malformed addresses", () => {
    expect(() =>
      deserializeJobProposal({
        ...serializeJobProposal(proposal),
        client: "not-an-address" as `0x${string}`,
      }),
    ).toThrow();
  });
});

describe("signJobProposal + verifyJobProposalSignature", () => {
  test("signs with a LocalAccount and verifies", async () => {
    const account = privateKeyToAccount(
      "0x40678d56fbebb4b14075ad5e813ee36d017039d041ba25401c8c0be8111cfc90",
    );
    const proposal: JobProposal = {
      client: account.address,
      provider: "0xcC802eCCAaeb58D8Ef00F2aa5A2ABF94B64FC0A3",
      evaluator: "0x120C1fc5B7f357c0254cDC8027970DDD6405e115",
      paymentToken: "0x8Cc99bd97CD8cc7A7da1c9859415773FDa23e50c",
      amount: 1n,
      hook: "0x10C2c2D7cE63597BC8EAf3Dc75926a73092FeaE2",
      taskSpecHash: hashTaskSpec(SAMPLE_TASK),
      expiresAt: 1_900_000_000n,
      nonce: generateNonce(),
    };
    const signature = await signJobProposal(proposal, account, DOMAIN);
    expect(
      await verifyJobProposalSignature({
        proposal,
        signature,
        expected: account.address,
        domain: DOMAIN,
      }),
    ).toBe(true);

    const recovered = await recoverJobProposalSigner({
      proposal,
      signature,
      domain: DOMAIN,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });
});
