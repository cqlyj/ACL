import { describe, expect, test } from "bun:test";
import { toHex } from "viem";
import { packetToBytes } from "viem/ens";
import { decodeDnsName, isSingleLabel, subLabelUnder } from "./dns-name.js";

describe("decodeDnsName", () => {
  test("round-trips with viem packetToBytes for a typical *.acl.eth name", () => {
    const dns = toHex(packetToBytes("researcher.acl.eth"));
    expect(decodeDnsName(dns)).toEqual({
      labels: ["researcher", "acl", "eth"],
      name: "researcher.acl.eth",
    });
  });

  test("decodes the parent name itself", () => {
    const dns = toHex(packetToBytes("acl.eth"));
    expect(decodeDnsName(dns)).toEqual({
      labels: ["acl", "eth"],
      name: "acl.eth",
    });
  });

  test("decodes a deep subname", () => {
    const dns = toHex(packetToBytes("alpha.beta.acl.eth"));
    expect(decodeDnsName(dns)).toEqual({
      labels: ["alpha", "beta", "acl", "eth"],
      name: "alpha.beta.acl.eth",
    });
  });

  test("rejects truncated DNS encodings", () => {
    // Length byte says 5 but only 3 chars follow.
    expect(() => decodeDnsName("0x05666f6f" as const)).toThrow();
  });
});

describe("subLabelUnder", () => {
  test("returns the leading sublabel for a *.acl.eth name", () => {
    expect(subLabelUnder("researcher.acl.eth", "acl.eth")).toBe("researcher");
  });

  test("case-insensitive on parent + name", () => {
    expect(subLabelUnder("Researcher.ACL.eth", "acl.eth")).toBe("researcher");
  });

  test("returns null when the name IS the parent", () => {
    expect(subLabelUnder("acl.eth", "acl.eth")).toBeNull();
  });

  test("throws when the name is not under the parent", () => {
    expect(() => subLabelUnder("foo.example", "acl.eth")).toThrow();
  });

  test("returns multi-label sublabels verbatim (caller decides what to do)", () => {
    // Useful so deep sub-names like `alpha.beta.acl.eth` end up as `alpha.beta`,
    // and the caller can decide to reject or to look up by label index.
    expect(subLabelUnder("alpha.beta.acl.eth", "acl.eth")).toBe("alpha.beta");
  });
});

describe("isSingleLabel", () => {
  test("accepts a registry-style single label", () => {
    expect(isSingleLabel("researcher")).toBe(true);
  });

  test("rejects multi-label sub-portions", () => {
    expect(isSingleLabel("alpha.beta")).toBe(false);
  });

  test("rejects the empty string", () => {
    expect(isSingleLabel("")).toBe(false);
  });
});
