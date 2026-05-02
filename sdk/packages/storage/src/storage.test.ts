import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@acl/core";
import { createAclStorage } from "./storage.js";

// We deliberately do NOT spin up a live indexer here — the upload path
// is exercised by the example app under `examples/`. Instead we cover the
// bits that can fail offline: factory ergonomics and canonical-encoding
// contract.

const FAKE_PRIVATE_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";

describe("createAclStorage", () => {
  test("accepts a privateKey and returns an AclStorage instance", () => {
    const storage = createAclStorage({ privateKey: FAKE_PRIVATE_KEY });
    expect(storage).toBeDefined();
    expect(typeof storage.uploadJson).toBe("function");
    expect(typeof storage.downloadJson).toBe("function");
  });

  test("refuses configs without a signer, privateKey, or readOnly", () => {
    // The factory throws synchronously — no need for `await expect`.
    // Casting to `never` is the cleanest way to feed an invalid shape.
    expect(() => createAclStorage({} as never)).toThrow(/signer.*privateKey.*readOnly|readOnly/);
  });

  test("readOnly: true returns a download-only AclStorage", async () => {
    const storage = createAclStorage({ readOnly: true });
    expect(storage.canUpload).toBe(false);
    // Upload methods MUST throw eagerly — surfacing the misuse rather
    // than letting the call dive into the indexer with an undefined
    // signer.
    await expect(storage.uploadString("hello")).rejects.toThrow(/upload-capable signer/);
  });
});

describe("upload payload encoding", () => {
  test("uploadJson canonicalises before encoding (sorted keys)", () => {
    // We can't exercise the network, but we can check that the
    // canonicaliser the SDK uses produces the expected bytes — this is
    // what guarantees byte-stable rootHashes across runs.
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    expect(a).toBe(b);
  });
});
