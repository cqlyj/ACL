import { describe, expect, test } from "bun:test";
import {
  JOB_DESCRIPTION_HEX_LENGTH,
  decodeJobDescription,
  encodeJobDescription,
} from "./description.js";

describe("encodeJobDescription / decodeJobDescription", () => {
  const sampleHash = "0xABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789" as const;

  test("encode lowercases and round-trips back", () => {
    const encoded = encodeJobDescription(sampleHash);
    expect(encoded).toBe(sampleHash.toLowerCase());
    expect(encoded.length).toBe(JOB_DESCRIPTION_HEX_LENGTH);
    expect(decodeJobDescription(encoded)).toBe(encoded as `0x${string}`);
  });

  test("decode returns null for plain-text from non-ACL clients", () => {
    expect(decodeJobDescription("write a research report")).toBeNull();
    expect(decodeJobDescription("")).toBeNull();
    expect(decodeJobDescription(null)).toBeNull();
    expect(decodeJobDescription(undefined)).toBeNull();
  });

  test("decode rejects malformed hex", () => {
    // 0x prefix but non-hex char inside
    expect(
      decodeJobDescription("0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"),
    ).toBeNull();
    // wrong length
    expect(decodeJobDescription("0xabcd")).toBeNull();
    // missing 0x prefix
    expect(decodeJobDescription(sampleHash.slice(2))).toBeNull();
  });

  test("encode throws on malformed input", () => {
    expect(() => encodeJobDescription("not-hex" as `0x${string}`)).toThrow();
    expect(() => encodeJobDescription("0xshort" as `0x${string}`)).toThrow();
  });
});
