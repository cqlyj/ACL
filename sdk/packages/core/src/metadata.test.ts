import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, getAddress, stringToHex, toHex } from "viem";

import { decodeMetadata, decodeMetadataAsText } from "./metadata.js";
import { ACL_METADATA_KEYS } from "./types.js";

const SAMPLE_AGENT = "0xB83D2DA48D6b3D40ddEf0Da6c14E95EB02F8a8FB";

describe("decodeMetadataAsText", () => {
  test("returns checksummed address for the agentAddress key (ABI-encoded address)", () => {
    const raw = encodeAbiParameters([{ type: "address" }], [SAMPLE_AGENT]);
    expect(decodeMetadataAsText(ACL_METADATA_KEYS.agentAddress, raw)).toBe(
      getAddress(SAMPLE_AGENT),
    );
  });

  test("returns checksummed address for evaluatorAddress (ABI-encoded address)", () => {
    const raw = encodeAbiParameters([{ type: "address" }], [SAMPLE_AGENT]);
    expect(decodeMetadataAsText(ACL_METADATA_KEYS.evaluatorAddress, raw)).toBe(
      getAddress(SAMPLE_AGENT),
    );
  });

  test("returns comma-joined addresses for paymentTokens (ABI-encoded address[])", () => {
    const raw = encodeAbiParameters(
      [{ type: "address[]" }],
      [[SAMPLE_AGENT, "0x8Cc99bd97CD8cc7A7da1c9859415773FDa23e50c"]],
    );
    const out = decodeMetadataAsText(ACL_METADATA_KEYS.paymentTokens, raw);
    expect(out.split(",").length).toBe(2);
    expect(out.split(",")[0]).toBe(getAddress(SAMPLE_AGENT));
  });

  test("returns decimal string for uint256 keys", () => {
    const raw = encodeAbiParameters([{ type: "uint256" }], [100_000_000n]);
    expect(decodeMetadataAsText(ACL_METADATA_KEYS.minBudget, raw)).toBe(
      "100000000",
    );
    expect(decodeMetadataAsText(ACL_METADATA_KEYS.chainId, raw)).toBe(
      "100000000",
    );
  });

  test("returns the raw UTF-8 for string-bytes keys", () => {
    const raw = stringToHex("research,security");
    expect(decodeMetadataAsText(ACL_METADATA_KEYS.taskDomains, raw)).toBe(
      "research,security",
    );
  });

  test("returns empty string for the synthetic agentId key (gateway-only)", () => {
    expect(decodeMetadataAsText(ACL_METADATA_KEYS.agentId, "0x" as const)).toBe(
      "",
    );
  });

  test("returns empty string for `0x` (no record set on chain)", () => {
    expect(decodeMetadataAsText(ACL_METADATA_KEYS.agentAddress, "0x")).toBe("");
  });
});

describe("decodeMetadata.asString", () => {
  test("decodes valid UTF-8 hex bytes", () => {
    expect(decodeMetadata.asString(toHex("hello"))).toBe("hello");
  });

  test("returns empty string for `0x`", () => {
    expect(decodeMetadata.asString("0x" as const)).toBe("");
  });
});
