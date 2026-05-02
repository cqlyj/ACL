import { JsonRpcProvider, Wallet } from "ethers";
import type { Hex } from "viem";

/**
 * Build an ethers `Wallet` connected to a JSON-RPC provider from a
 * raw private key + RPC URL. The 0G SDKs (storage indexer / compute
 * broker / token approvals) all want an ethers `Signer`, but most of
 * the ACL SDK signs through viem — so several places have to bridge
 * a private key into ethers verbatim.
 *
 * Centralised here so every bridge site uses the exact same provider
 * + wallet wiring (and so dep-bumping ethers only touches one file).
 */
export function createEthersSignerFromPrivateKey(privateKey: Hex, rpcUrl: string): Wallet {
  const provider = new JsonRpcProvider(rpcUrl);
  return new Wallet(privateKey, provider);
}
