import { describe, expect, test } from "bun:test";
import { Wallet } from "ethers";

import { createEthersSignerFromPrivateKey } from "./ethers-signer.js";

// We don't want a live RPC connection in unit tests, so the rpcUrl
// passed in is intentionally bogus — `JsonRpcProvider` constructs
// lazily and only resolves the network on first call. The wallet's
// public address is derivable from the key alone, so that's what
// we assert.
const PRIVATE_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const EXPECTED_ADDRESS = new Wallet(PRIVATE_KEY).address;

describe("createEthersSignerFromPrivateKey", () => {
  test("returns a Wallet whose address matches the expected derivation", () => {
    const wallet = createEthersSignerFromPrivateKey(
      PRIVATE_KEY,
      "http://127.0.0.1:0", // never actually called in this test
    );
    expect(wallet.address).toBe(EXPECTED_ADDRESS);
  });

  test("attaches a JsonRpcProvider so the wallet can sign tx envelopes", () => {
    const wallet = createEthersSignerFromPrivateKey(PRIVATE_KEY, "http://127.0.0.1:0");
    expect(wallet.provider).toBeDefined();
  });
});
