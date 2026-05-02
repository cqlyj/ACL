import { describe, expect, test } from "bun:test";
import { type Address, type Hex, hexToBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  prepareInftAcquisition,
  repointInftAfterAcquisition,
} from "./acquisition.js";
import { encryptIntelligentData, publicKeyFromPrivateKey } from "./crypto.js";
import { DEFAULT_INTELLIGENT_DATA_URI_PREFIX } from "./encrypt-update.js";
import {
  type ReencryptionOracle,
  type ReencryptionRequest,
  type ReencryptionResult,
} from "./oracle.js";
import { defaultOwnershipNonce } from "./proofs.js";

const VERIFIER_ADDR = "0x000000000000000000000000000000000000dEaD" as Address;
const CHAIN_ID = 16602n;

function makeOracle(): ReencryptionOracle {
  // Tiny in-process oracle: re-encrypts a fresh ciphertext under the
  // recipient's pubkey and returns a stub `OwnershipProof`. Identical
  // to `createDemoLocalReencryptionOracle` minus the side-channel
  // dataKey lookup we don't need in unit tests.
  return {
    chainId: CHAIN_ID,
    verifierAddress: VERIFIER_ADDR,
    async reencryptForRecipient(
      req: ReencryptionRequest,
    ): Promise<ReencryptionResult> {
      const recipientCipher = await encryptIntelligentData(
        new TextEncoder().encode("acquired bundle"),
        req.recipientPubKey,
      );
      return {
        newCiphertext: recipientCipher.ciphertext,
        newDataHash: recipientCipher.dataHash,
        sealedKey:
          `0x${Buffer.from(recipientCipher.sealedKey).toString("hex")}` as Hex,
        ownershipProof: {
          oracleType: 0,
          oldDataHash: req.oldDataHash,
          newDataHash: recipientCipher.dataHash,
          sealedKey:
            `0x${Buffer.from(recipientCipher.sealedKey).toString("hex")}` as Hex,
          encryptedPubKey: ("0x" +
            Buffer.from(req.recipientPubKey).toString("hex")) as Hex,
          nonce: defaultOwnershipNonce(),
          signature: ("0x" + "00".repeat(65)) as Hex,
        },
      };
    },
  };
}

describe("@acl/inft prepareInftAcquisition", () => {
  test("downloads seller ciphertext, runs oracle, uploads buyer ciphertext, decrypts plaintext", async () => {
    const buyerKey = generatePrivateKey();
    const buyer = privateKeyToAccount(buyerKey);
    const sellerKey = generatePrivateKey();
    const sellerPubKey = hexToBytes(publicKeyFromPrivateKey(sellerKey));

    // Seed an on-chain slot keyed off a fresh seller-side encryption.
    const sellerEncrypted = await encryptIntelligentData(
      new TextEncoder().encode("seller bundle plaintext"),
      sellerPubKey,
    );
    const sellerRoot =
      "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;

    let downloadedRoot: Hex | null = null;
    let uploadedBytes: Uint8Array | null = null;
    const newRoot =
      "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
    const storage = {
      downloadBytes: async (root: Hex): Promise<Uint8Array> => {
        downloadedRoot = root;
        return sellerEncrypted.ciphertext;
      },
      uploadBytes: async (
        bytes: Uint8Array | ArrayLike<number>,
      ): Promise<{ rootHash: Hex; txSeq: number }> => {
        uploadedBytes =
          bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        return { rootHash: newRoot, txSeq: 42 };
      },
    } as unknown as import("@acl/storage").AclStorage;

    const nft = {
      contract: "0x000000000000000000000000000000000000ACL1" as Address,
      getIntelligentData: async (
        _tokenId: bigint,
      ): Promise<Array<{ dataDescription: string; dataHash: Hex }>> => [
        { dataDescription: "seller", dataHash: sellerEncrypted.dataHash },
      ],
      getEncryptedStorageURI: async (_tokenId: bigint): Promise<string> =>
        `${DEFAULT_INTELLIGENT_DATA_URI_PREFIX}${sellerRoot}`,
    } as unknown as import("./client.js").INftClient;

    void sellerKey;
    const oracle = makeOracle();
    const prep = await prepareInftAcquisition({
      nft,
      storage,
      oracle,
      tokenId: 7n,
      buyer,
      buyerPrivateKey: buyerKey,
    });

    expect(downloadedRoot).toBe(sellerRoot);
    expect(uploadedBytes).not.toBeNull();
    expect(prep.cipherRoot).toBe(newRoot);
    expect(prep.newEncryptedStorageURI).toBe(
      `${DEFAULT_INTELLIGENT_DATA_URI_PREFIX}${newRoot}`,
    );
    expect(prep.oldDataHash).toBe(sellerEncrypted.dataHash);
    expect(prep.proof.accessProof.oldDataHash).toBe(sellerEncrypted.dataHash);
    expect(prep.proof.accessProof.newDataHash).toBe(
      prep.reencryption.newDataHash,
    );
    expect(prep.plaintext).toBeDefined();
    expect(new TextDecoder().decode(prep.plaintext!)).toBe("acquired bundle");
  });

  test("throws when the on-chain URI prefix is wrong", async () => {
    const buyerKey = generatePrivateKey();
    const buyer = privateKeyToAccount(buyerKey);
    const nft = {
      contract: "0x000000000000000000000000000000000000ACL1" as Address,
      getIntelligentData: async (): Promise<
        Array<{ dataDescription: string; dataHash: Hex }>
      > => [
        {
          dataDescription: "seller",
          dataHash: ("0x" + "ab".repeat(32)) as Hex,
        },
      ],
      getEncryptedStorageURI: async (): Promise<string> => "ipfs://wrong",
    } as unknown as import("./client.js").INftClient;
    const oracle = makeOracle();
    const storage = {} as unknown as import("@acl/storage").AclStorage;

    await expect(
      prepareInftAcquisition({
        nft,
        storage,
        oracle,
        tokenId: 1n,
        buyer,
        buyerPrivateKey: buyerKey,
      }),
    ).rejects.toThrow(/does not use the expected prefix/);
  });

  test("throws when slotIndex is out of bounds", async () => {
    const buyerKey = generatePrivateKey();
    const buyer = privateKeyToAccount(buyerKey);
    const nft = {
      contract: "0x000000000000000000000000000000000000ACL1" as Address,
      getIntelligentData: async (): Promise<
        Array<{ dataDescription: string; dataHash: Hex }>
      > => [
        {
          dataDescription: "only one",
          dataHash: ("0x" + "cd".repeat(32)) as Hex,
        },
      ],
      getEncryptedStorageURI: async (): Promise<string> =>
        `${DEFAULT_INTELLIGENT_DATA_URI_PREFIX}root`,
    } as unknown as import("./client.js").INftClient;
    const oracle = makeOracle();
    const storage = {} as unknown as import("@acl/storage").AclStorage;

    await expect(
      prepareInftAcquisition({
        nft,
        storage,
        oracle,
        tokenId: 1n,
        buyer,
        buyerPrivateKey: buyerKey,
        slotIndex: 5,
      }),
    ).rejects.toThrow(/slotIndex=5 out of bounds/);
  });
});

describe("@acl/inft repointInftAfterAcquisition", () => {
  test("calls update(...) with the new dataHash + URI and returns the new owner", async () => {
    let updateArgs: {
      tokenId: bigint;
      newDatas: unknown;
      uri: string;
    } | null = null;
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
        return "0xabc" as Hex;
      },
      ownerOf: async (): Promise<Address> =>
        "0x1234567890123456789012345678901234567890" as Address,
    } as unknown as import("./client.js").INftClient;

    const result = await repointInftAfterAcquisition({
      nft,
      tokenId: 9n,
      newDataHash: ("0x" + "ff".repeat(32)) as Hex,
      newEncryptedStorageURI: "0g://newroot",
      dataDescription: "buyer bundle",
      waitForReceipt: false,
    });

    expect(updateArgs).not.toBeNull();
    expect(updateArgs!.tokenId).toBe(9n);
    expect(updateArgs!.uri).toBe("0g://newroot");
    expect(updateArgs!.newDatas).toEqual([
      {
        dataDescription: "buyer bundle",
        dataHash: ("0x" + "ff".repeat(32)) as Hex,
      },
    ]);
    expect(result.updateTxHash).toBe("0xabc");
    expect(result.newOwner).toBe(
      "0x1234567890123456789012345678901234567890" as Address,
    );
  });

  test("throws when waitForReceipt is requested but publicClient is missing", async () => {
    const nft = {
      update: async (): Promise<Hex> => "0xdeadbeef" as Hex,
      ownerOf: async (): Promise<Address> =>
        "0x0000000000000000000000000000000000000001" as Address,
    } as unknown as import("./client.js").INftClient;
    await expect(
      repointInftAfterAcquisition({
        nft,
        tokenId: 1n,
        newDataHash: ("0x" + "00".repeat(32)) as Hex,
        newEncryptedStorageURI: "0g://x",
        dataDescription: "x",
      }),
    ).rejects.toThrow(/requires `publicClient`/);
  });
});
