import { describe, expect, test } from "bun:test";
import { ENSIP25_ATTESTATION_VALUE, buildAgentRegistrationKey, encodeErc7930 } from "./ensip25.js";

describe("encodeErc7930", () => {
  test("matches the ENSIP-25 reference vector for ERC-8004 on mainnet", () => {
    // From https://docs.ens.domains/ensip/25 section "Ethereum Example":
    //   ERC-8004 on mainnet (chainId 1) registry 0x8004A169...
    //   →  0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432
    expect(
      encodeErc7930({
        chainId: 1,
        address: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      }),
    ).toBe("0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432");
  });

  test("encodes 0G Galileo (chainId 16602) with a 2-byte chain reference", () => {
    // 16602 == 0x40DA, so the chain reference is "40da" (2 bytes), prefixed
    // by length byte 0x02. Address bytes are lower-cased per CAIP-350.
    expect(
      encodeErc7930({
        chainId: 16_602,
        address: "0x301c4b1Acf4f043ff4aE0907C938062792f5435E",
      }),
    ).toBe("0x000100000240da14301c4b1acf4f043ff4ae0907c938062792f5435e");
  });

  test("strips leading zero bytes from chain reference but keeps a single byte minimum", () => {
    // chainId 256 = 0x0100 → chain ref "0100" (2 bytes), no leading zero.
    expect(
      encodeErc7930({
        chainId: 256,
        address: "0x0000000000000000000000000000000000000000",
      }),
    ).toBe("0x00010000020100140000000000000000000000000000000000000000");
  });

  test("rejects malformed addresses", () => {
    expect(() => encodeErc7930({ chainId: 1, address: "0xnotanaddress" as never })).toThrow();
  });

  test("rejects negative chain ids", () => {
    expect(() =>
      encodeErc7930({
        chainId: -1n,
        address: "0x0000000000000000000000000000000000000000",
      }),
    ).toThrow();
  });
});

describe("buildAgentRegistrationKey", () => {
  test("builds the canonical key form documented in ENSIP-25", () => {
    expect(
      buildAgentRegistrationKey({
        chainId: 1,
        registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
        agentId: 167n,
      }),
    ).toBe("agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][167]");
  });

  test("accepts the agentId as number, bigint, or string", () => {
    const args = {
      chainId: 1,
      registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const,
    };
    expect(buildAgentRegistrationKey({ ...args, agentId: 1 })).toBe(
      buildAgentRegistrationKey({ ...args, agentId: 1n }),
    );
    expect(buildAgentRegistrationKey({ ...args, agentId: "1" })).toBe(
      buildAgentRegistrationKey({ ...args, agentId: 1n }),
    );
  });

  test("rejects agentIds that contain reserved key delimiters", () => {
    // ENSIP-25 forbids `[` / `]` in the agentId so the key is unambiguous.
    expect(() =>
      buildAgentRegistrationKey({
        chainId: 1,
        registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
        agentId: "foo[1]",
      }),
    ).toThrow();
  });
});

describe("ENSIP25_ATTESTATION_VALUE", () => {
  test('is the recommended canonical "1"', () => {
    // The spec says any non-empty value MUST verify; consumers SHOULD set
    // the canonical value when writing the record.
    expect(ENSIP25_ATTESTATION_VALUE).toBe("1");
  });
});
