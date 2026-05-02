/**
 * Thin viem wrapper around `ACLAgentNFT`. Mirrors the surface of
 * `JobOrchestrator` from `@acl/settlement` so callers can spin one up
 * with the same `{ publicClient, walletClient, deployment }` object.
 *
 * Only the methods we exercise from the agents / examples are
 * surfaced. Lower-level callers that need an unwrapped binding can
 * still use the raw `aclAgentNFTAbi` from `@acl/core`.
 */
import {
  ACL_TESTNET,
  type AclDeployment,
  abis,
  requireWalletAccount,
  waitForReceiptResilient,
} from "@acl/core";
import {
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  decodeEventLog,
} from "viem";

import type { TransferValidityProof } from "./proofs.js";

/** Mirror of the on-chain `IntelligentData` struct. */
export type IntelligentData = {
  dataDescription: string;
  dataHash: Hex;
};

/** Constructor inputs for {@link INftClient}. */
export type INftClientConfig = {
  publicClient: PublicClient;
  /**
   * WalletClient bound to a local account. Required for any write
   * call (`mint` / `update` / `iTransfer` / `iClone` / `approve` /
   * `authorizeUsage` / `revokeAuthorization` / `delegateAccess`).
   * Read-only consumers (e.g. an HTTP route surfacing
   * `ownerOf(tokenId)`) can omit it; write methods throw a clear
   * error if invoked without one.
   */
  walletClient?: WalletClient;
  /**
   * Full deployment object — `deployment.galileo.aclAgentNFT` is the
   * default contract address. Falls back to `defaultDeployment` when
   * omitted.
   */
  deployment?: AclDeployment;
  /**
   * Optional one-off contract address override (e.g. a freshly
   * deployed `MockTrustedPartyVerifier`-paired NFT in tests). Wins
   * over `deployment.galileo.aclAgentNFT` when both are supplied.
   */
  contractAddress?: Address;
};

/** Sentinel for `update()`: leave the on-chain `encryptedStorageURIs` untouched. */
export const KEEP_URI_SENTINEL = "";

/**
 * High-level binding for `ACLAgentNFT`. Stays small on purpose — the
 * orchestrator-equivalent shape lets the example app and tests
 * drop-in replace one with the other.
 */
export class INftClient {
  readonly contract: Address;
  private readonly _publicClient: PublicClient;
  private readonly _walletClient: WalletClient | undefined;

  constructor(config: INftClientConfig) {
    const dep = config.deployment ?? ACL_TESTNET;
    this.contract = config.contractAddress ?? dep.galileo.aclAgentNFT;
    this._publicClient = config.publicClient;
    this._walletClient = config.walletClient;
  }

  private _requireWalletClient(): WalletClient {
    if (!this._walletClient) {
      throw new Error(
        "@acl/inft: this INftClient was created without a walletClient; pass one to call write methods",
      );
    }
    return this._walletClient;
  }

  private _requireAccount(): Account {
    return requireWalletAccount(this._requireWalletClient(), "@acl/inft");
  }

  /**
   * Tiny `writeContract` helper that pins `address` / `abi` /
   * `account` / `chain` for every call. Centralising the boilerplate
   * is a DRY win — the per-method wrappers focus on the function
   * name + args instead of repeating the same five fields.
   */
  private _write<F extends string>(
    functionName: F,
    args: readonly unknown[],
  ): Promise<Hex> {
    const account = this._requireAccount();
    const wallet = this._requireWalletClient();
    // The function name comes from a finite, hand-curated set of ABI
    // methods below; `as never` keeps viem's strict generic
    // inference happy without forcing the caller to thread the
    // function-name literal through.
    return wallet.writeContract({
      account,
      chain: wallet.chain,
      address: this.contract,
      abi: abis.aclAgentNFTAbi,
      functionName: functionName as never,
      args: args as never,
    });
  }

  /** Tiny read helper symmetric with {@link _write}. */
  private _read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    return this._publicClient.readContract({
      address: this.contract,
      abi: abis.aclAgentNFTAbi,
      functionName: functionName as never,
      args: args as never,
    }) as Promise<T>;
  }

  /**
   * Mint a new iNFT. The minted token is owned by `to` and seeded with
   * `intelligentData[]` plus `encryptedStorageURI`. Returns
   * `{ txHash, tokenId }` after the receipt is decoded.
   */
  async mint(args: {
    to: Address;
    intelligentData: ReadonlyArray<IntelligentData>;
    encryptedStorageURI: string;
  }): Promise<{ txHash: Hex; tokenId: bigint }> {
    const txHash = await this._write("mint", [
      args.to,
      args.intelligentData,
      args.encryptedStorageURI,
    ]);
    const receipt = await waitForReceiptResilient(this._publicClient, txHash);
    const tokenId = this._extractMintedTokenId(receipt.logs);
    return { txHash, tokenId };
  }

  /**
   * Refresh the on-chain `IntelligentData` (and optionally the
   * `encryptedStorageURI`) for `tokenId`. Pass `newEncryptedStorageURI
   * = ''` (or just omit it; the wrapper does that for you) to leave
   * the on-chain URI untouched per the contract sentinel.
   */
  async update(args: {
    tokenId: bigint;
    newDatas: ReadonlyArray<IntelligentData>;
    newEncryptedStorageURI?: string;
  }): Promise<Hex> {
    return this._write("update", [
      args.tokenId,
      args.newDatas,
      args.newEncryptedStorageURI ?? KEEP_URI_SENTINEL,
    ]);
  }

  /** Standard ERC-721 `approve(operator, tokenId)`. */
  approve(args: { to: Address; tokenId: bigint }): Promise<Hex> {
    return this._write("approve", [args.to, args.tokenId]);
  }

  /** ERC-7857 `iTransfer(_to, _tokenId, _proofs)`. */
  iTransfer(args: {
    to: Address;
    tokenId: bigint;
    proofs: ReadonlyArray<TransferValidityProof>;
  }): Promise<Hex> {
    return this._write("iTransfer", [args.to, args.tokenId, args.proofs]);
  }

  /**
   * ERC-7857 `iClone(_to, _tokenId, _proofs)` — clones the iNFT to
   * `to` while keeping the seller as the owner of the original. The
   * contract emits a `Cloned(_originalTokenId, _newTokenId, _to)`
   * event; we decode it from the receipt and surface the freshly
   * minted `newTokenId` so callers don't have to re-scan logs.
   */
  async iClone(args: {
    to: Address;
    tokenId: bigint;
    proofs: ReadonlyArray<TransferValidityProof>;
  }): Promise<{ txHash: Hex; newTokenId: bigint }> {
    const txHash = await this._write("iClone", [
      args.to,
      args.tokenId,
      args.proofs,
    ]);
    const receipt = await waitForReceiptResilient(this._publicClient, txHash);
    const newTokenId = this._extractClonedTokenId(receipt.logs, args.tokenId);
    return { txHash, newTokenId };
  }

  /**
   * ERC-7857 `authorizeUsage(_tokenId, _user)` — allow `user` to read
   * the iNFT's intelligent data via the contract's authorized-users
   * mapping. The caller must be the token owner (or a delegated
   * assistant via {@link delegateAccess}); the contract's
   * `onlyAccessAssistant` modifier enforces this.
   *
   * Use this when the owner wants to grant read access without
   * transferring ownership (e.g. a one-off API consumer of the iNFT's
   * persona).
   */
  authorizeUsage(args: { tokenId: bigint; user: Address }): Promise<Hex> {
    return this._write("authorizeUsage", [args.tokenId, args.user]);
  }

  /**
   * ERC-7857 `revokeAuthorization(_tokenId, _user)` — revoke a previous
   * {@link authorizeUsage} grant. Same caller constraints as
   * {@link authorizeUsage}.
   */
  revokeAuthorization(args: { tokenId: bigint; user: Address }): Promise<Hex> {
    return this._write("revokeAuthorization", [args.tokenId, args.user]);
  }

  /**
   * ERC-7857 `delegateAccess(_assistant)` — delegate the caller's
   * authorize/revoke rights to `assistant`. After this call,
   * `assistant` may invoke {@link authorizeUsage}/{@link revokeAuthorization}
   * on tokens owned by the caller. Pass the zero address to clear an
   * existing delegation.
   */
  delegateAccess(args: { assistant: Address }): Promise<Hex> {
    return this._write("delegateAccess", [args.assistant]);
  }

  /**
   * Read the list of addresses currently authorised to use `tokenId`.
   * Mirrors `authorizedUsersOf(_tokenId)`.
   */
  authorizedUsersOf(tokenId: bigint): Promise<readonly Address[]> {
    return this._read<readonly Address[]>("authorizedUsersOf", [tokenId]);
  }

  /**
   * Read the current delegated-access assistant for `user`. Returns the
   * zero address when no delegation is in place. Mirrors
   * `getDelegateAccess(_user)`.
   */
  getDelegateAccess(user: Address): Promise<Address> {
    return this._read<Address>("getDelegateAccess", [user]);
  }

  /** Read the current `IntelligentData[]` for `tokenId`. */
  getIntelligentData(tokenId: bigint): Promise<IntelligentData[]> {
    return this._read<IntelligentData[]>("intelligentDataOf", [tokenId]);
  }

  /** Standard ERC-721 owner read. */
  ownerOf(tokenId: bigint): Promise<Address> {
    return this._read<Address>("ownerOf", [tokenId]);
  }

  /**
   * Standard ERC-721 `getApproved(tokenId)`. Returns the current single
   * approved operator (zero address when none). Used by Flow-2
   * provider-side flows to skip a redundant `approve(...)` write when
   * the `INFTDeliveryHook` is already authorised for the token.
   */
  getApproved(tokenId: bigint): Promise<Address> {
    return this._read<Address>("getApproved", [tokenId]);
  }

  /**
   * Read the on-chain `encryptedStorageURIs(tokenId)` mapping. Returns
   * the storage URI the contract advertises for `tokenId` (typically
   * `0g://<root>` when a provider's `update(...)` has populated it,
   * or the seed/placeholder value otherwise).
   */
  getEncryptedStorageURI(tokenId: bigint): Promise<string> {
    return this._read<string>("encryptedStorageURIs", [tokenId]);
  }

  /**
   * Recover the freshly-minted `tokenId` from a `Transfer(0x0, to, id)`
   * log. Returns the FIRST mint event's tokenId — `mint()` only emits
   * one Transfer per call.
   */
  private _extractMintedTokenId(
    logs: ReadonlyArray<{
      address: Address;
      topics: readonly Hex[];
      data: Hex;
    }>,
  ): bigint {
    for (const log of logs) {
      if (log.address.toLowerCase() !== this.contract.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: abis.aclAgentNFTAbi,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
          strict: true,
        });
        if (decoded.eventName !== "Transfer") continue;
        const a = decoded.args as unknown as { from: Address; tokenId: bigint };
        if (a.from === "0x0000000000000000000000000000000000000000") {
          return a.tokenId;
        }
      } catch {
        // Not a `Transfer` log on this contract — skip.
      }
    }
    throw new Error("@acl/inft: mint receipt did not contain a Transfer log");
  }

  /**
   * Recover the freshly cloned `_newTokenId` from a `Cloned` event.
   * Filters by `_originalTokenId == originalTokenId` so a receipt
   * containing multiple clone events (unusual, but legal) still
   * returns the right child token.
   */
  private _extractClonedTokenId(
    logs: ReadonlyArray<{
      address: Address;
      topics: readonly Hex[];
      data: Hex;
    }>,
    originalTokenId: bigint,
  ): bigint {
    for (const log of logs) {
      if (log.address.toLowerCase() !== this.contract.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: abis.aclAgentNFTAbi,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
          strict: true,
        });
        if (decoded.eventName !== "Cloned") continue;
        const a = decoded.args as unknown as {
          _tokenId: bigint;
          _newTokenId: bigint;
        };
        if (a._tokenId === originalTokenId) return a._newTokenId;
      } catch {
        // Not a `Cloned` log on this contract — skip.
      }
    }
    throw new Error(
      `@acl/inft: iClone receipt did not contain a Cloned log for tokenId=${originalTokenId}`,
    );
  }
}

/** Sugar factory — mirrors `createJobOrchestrator` shape. */
export function createINftClient(config: INftClientConfig): INftClient {
  return new INftClient(config);
}
