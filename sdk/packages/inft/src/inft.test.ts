import { describe, expect, test } from "bun:test";
import { type Hex, bytesToHex, encodeAbiParameters, hexToBytes, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  decryptIntelligentData,
  encryptIntelligentData,
  publicKeyFromPrivateKey,
} from "./crypto.js";
import { DEFAULT_INTELLIGENT_DATA_URI_PREFIX, iNftEncryptAndUpdate } from "./encrypt-update.js";
import { inftDeliverableCommitment, inftDeliveryHook } from "./hook.js";
import { defaultOwnershipNonce, randomAccessNonce } from "./proofs.js";

describe("@acl/inft crypto", () => {
  test("encrypt → decrypt round-trips with a generated keypair", async () => {
    const privKey = generatePrivateKey();
    const pubKey = publicKeyFromPrivateKey(privKey);
    const plaintext = new TextEncoder().encode("training corpus blob v1 — the quick brown fox");

    const encrypted = await encryptIntelligentData(plaintext, hexToBytes(pubKey));
    expect(encrypted.dataHash).toBe(keccak256(encrypted.ciphertext));
    expect(encrypted.dataKey.length).toBe(32);

    const decrypted = await decryptIntelligentData(
      encrypted.ciphertext,
      encrypted.sealedKey,
      privKey,
    );
    expect(new TextDecoder().decode(decrypted)).toBe(new TextDecoder().decode(plaintext));
  });

  test("publicKeyFromPrivateKey emits 65-byte SEC1 uncompressed form", () => {
    const sk = generatePrivateKey();
    const pk = publicKeyFromPrivateKey(sk);
    const bytes = hexToBytes(pk);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });
});

describe("@acl/inft proofs", () => {
  test("defaultOwnershipNonce is 32 bytes (abi.encode(uint256))", () => {
    const nonce = defaultOwnershipNonce();
    expect(nonce.length).toBe(2 + 64);
  });

  test("randomAccessNonce is 32 bytes", () => {
    const nonce = randomAccessNonce();
    expect(nonce.length).toBe(2 + 64);
  });

  test("default nonces from back-to-back calls differ (random nonce uniqueness)", () => {
    const a = randomAccessNonce();
    const b = randomAccessNonce();
    expect(a).not.toBe(b);
  });
});

describe("@acl/inft hook factory", () => {
  test("inftDeliverableCommitment matches keccak(abi.encode(nft,tokenId,providerAgentId))", () => {
    const nftContract = `0x${"11".repeat(20)}`;
    const tokenId = 7n;
    const providerAgentId = 42n;
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
        [nftContract as `0x${string}`, tokenId, providerAgentId],
      ),
    );
    const actual = inftDeliverableCommitment({
      nftContract: nftContract as `0x${string}`,
      tokenId,
      providerAgentId,
    });
    expect(actual).toBe(expected);
  });

  test("inftDeliveryHook fills setBudget optParams = abi.encode(nft, tokenId, providerAgentId)", () => {
    const nftContract = `0x${"22".repeat(20)}`;
    const tokenId = 11n;
    const providerAgentId = 99n;
    const cfg = inftDeliveryHook({
      nftContract: nftContract as `0x${string}`,
      tokenId,
      providerAgentId,
      proofs: [],
    });
    const expected = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [nftContract as `0x${string}`, tokenId, providerAgentId],
    );
    expect(cfg.optParams?.setBudget).toBe(expected);
    expect(cfg.address).not.toBe("0x0000000000000000000000000000000000000000");
  });

  test("inftDeliverableCommitment === keccak(setBudget optParams) — SDK invariant", () => {
    const nftContract = `0x${"33".repeat(20)}`;
    const tokenId = 21n;
    const providerAgentId = 5n;
    const cfg = inftDeliveryHook({
      nftContract: nftContract as `0x${string}`,
      tokenId,
      providerAgentId,
      proofs: [],
    });
    const commitment = inftDeliverableCommitment({
      nftContract: nftContract as `0x${string}`,
      tokenId,
      providerAgentId,
    });
    expect(keccak256(cfg.optParams?.setBudget!)).toBe(commitment);
  });
});

describe("@acl/inft iNftEncryptAndUpdate", () => {
  test("encrypts, uploads, fires onEncrypted, then writes update(...)", async () => {
    const ownerKey = generatePrivateKey();
    const ownerPubKey = hexToBytes(publicKeyFromPrivateKey(ownerKey));
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ persona: "demo", refreshedAt: 1n.toString() }),
    );

    let uploadedBytes: Uint8Array | undefined;
    const fakeRoot = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
    const storage = {
      uploadBytes: async (
        bytes: Uint8Array | ArrayLike<number>,
      ): Promise<{ rootHash: Hex; txSeq: number }> => {
        uploadedBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        return { rootHash: fakeRoot, txSeq: 1 };
      },
    } as unknown as import("@acl/storage").AclStorage;

    let updateArgs: { tokenId: bigint; newDatas: unknown; uri: string } | undefined;
    const txHashSentinel =
      "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
    const nft = {
      update: async (a: {
        tokenId: bigint;
        newDatas: unknown;
        newEncryptedStorageURI: string;
      }): Promise<Hex> => {
        updateArgs = {
          tokenId: a.tokenId,
          newDatas: a.newDatas,
          uri: a.newEncryptedStorageURI,
        };
        return txHashSentinel;
      },
    } as unknown as import("./client.js").INftClient;

    let onEncryptedFired = false;
    const result = await iNftEncryptAndUpdate({
      storage,
      nft,
      input: {
        tokenId: 7n,
        plaintext,
        recipientPubKey: ownerPubKey,
        dataDescription: "test agent bundle",
        waitForReceipt: false,
        onEncrypted: ({ tokenId, dataKey, dataHash }) => {
          onEncryptedFired = true;
          expect(tokenId).toBe(7n);
          expect(dataKey.length).toBe(32);
          expect(dataHash.length).toBe(2 + 64);
        },
      },
    });

    expect(onEncryptedFired).toBe(true);
    expect(result.txHash).toBe(txHashSentinel);
    expect(result.rootHash).toBe(fakeRoot);
    expect(result.uri).toBe(`${DEFAULT_INTELLIGENT_DATA_URI_PREFIX}${fakeRoot}`);
    expect(result.dataHash).toBe(keccak256(bytesToHex(uploadedBytes!)));
    expect(updateArgs?.tokenId).toBe(7n);
    expect(updateArgs?.uri).toBe(result.uri);
    expect(updateArgs?.newDatas).toEqual([
      { dataDescription: "test agent bundle", dataHash: result.dataHash },
    ]);

    // Round-trip: the recipient can decrypt the uploaded ciphertext
    // with their private key + the sealedKey (verifies that the
    // helper produced an envelope compatible with the decrypt path).
    const decoded = await decryptIntelligentData(uploadedBytes!, result.sealedKey, ownerKey);
    expect(new TextDecoder().decode(decoded)).toBe(new TextDecoder().decode(plaintext));
  });

  test("preserves additionalSlots verbatim and respects uriPrefix", async () => {
    const ownerKey = generatePrivateKey();
    const ownerPubKey = hexToBytes(publicKeyFromPrivateKey(ownerKey));
    const fakeRoot = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
    const storage = {
      uploadBytes: async (): Promise<{ rootHash: Hex; txSeq: number }> => ({
        rootHash: fakeRoot,
        txSeq: 1,
      }),
    } as unknown as import("@acl/storage").AclStorage;

    let captured: { newDatas: unknown; uri: string } | undefined;
    const nft = {
      update: async (a: {
        tokenId: bigint;
        newDatas: unknown;
        newEncryptedStorageURI: string;
      }): Promise<Hex> => {
        captured = { newDatas: a.newDatas, uri: a.newEncryptedStorageURI };
        return "0x33".padEnd(66, "3") as Hex;
      },
    } as unknown as import("./client.js").INftClient;

    const surviving = {
      dataDescription: "untouched slot",
      dataHash: `0x${"ee".repeat(32)}` as Hex,
    };
    const result = await iNftEncryptAndUpdate({
      storage,
      nft,
      input: {
        tokenId: 1n,
        plaintext: new Uint8Array([1, 2, 3]),
        recipientPubKey: ownerPubKey,
        dataDescription: "fresh slot 0",
        additionalSlots: [surviving],
        uriPrefix: "ipfs://",
        waitForReceipt: false,
      },
    });

    expect(result.uri).toBe(`ipfs://${fakeRoot}`);
    expect(captured?.uri).toBe(result.uri);
    expect(captured?.newDatas).toEqual([
      { dataDescription: "fresh slot 0", dataHash: result.dataHash },
      surviving,
    ]);
  });

  test("aborts before on-chain update if onEncrypted throws", async () => {
    const ownerKey = generatePrivateKey();
    const ownerPubKey = hexToBytes(publicKeyFromPrivateKey(ownerKey));
    const storage = {
      uploadBytes: async (): Promise<{ rootHash: Hex; txSeq: number }> => ({
        rootHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
        txSeq: 1,
      }),
    } as unknown as import("@acl/storage").AclStorage;
    let updateCalled = false;
    const nft = {
      update: async (): Promise<Hex> => {
        updateCalled = true;
        return "0x" as Hex;
      },
    } as unknown as import("./client.js").INftClient;

    await expect(
      iNftEncryptAndUpdate({
        storage,
        nft,
        input: {
          tokenId: 1n,
          plaintext: new Uint8Array([1]),
          recipientPubKey: ownerPubKey,
          dataDescription: "whatever",
          waitForReceipt: false,
          onEncrypted: () => {
            throw new Error("KMS down");
          },
        },
      }),
    ).rejects.toThrow("KMS down");
    expect(updateCalled).toBe(false);
  });
});

void privateKeyToAccount;
