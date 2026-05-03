/**
 * One-time setup: mint two provider agents in `ACLIdentityRegistry`
 * and write the canonical ACL metadata. The gateway's indexer picks
 * them up automatically; the ACL offchain resolver then surfaces
 * `kelp-security.acl.eth` and `kelp-generalist.acl.eth` over CCIP-Read.
 *
 * Usage:
 *   bun run scripts/register-providers.ts
 *
 * Idempotent in spirit: re-running with the same env re-mints. Track
 * the resulting agent ids in your provider.env if you want to reuse
 * them via `existingAgentId` in a future call.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAgentRuntime, registerAclAgent, spawnAxlBridge } from "@acl/agent";
import {
  INFT_SALE_CAPABILITY_KEYS,
  createINftClient,
  encryptIntelligentData,
  publicKeyFromPrivateKey,
} from "@acl/inft";
import { hexToBytes, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PROVIDER_SPECS, type ProviderSpec, config } from "../src/config.js";

/**
 * Provider registration plans are derived from `PROVIDER_SPECS` so the
 * persona / min-price / task-domains shape stays in lock-step with the
 * runtime provider process (`src/agents/provider-process.ts`). The
 * iNFT corpus seed is `{ persona, modelId, axlPeer, note }` encrypted
 * under a fresh AES-GCM key sealed to the provider's *own* secp256k1
 * pubkey, so the provider can refresh it via `INftClient.update(...)`
 * (Op A) after each Flow-1 delivery.
 */
const PLANS: readonly ProviderSpec[] = Object.values(PROVIDER_SPECS);

async function main() {
  const axlDir = resolve(import.meta.dir, "..", ".axl");
  mkdirSync(axlDir, { recursive: true });

  // Idempotency: cache resolved agentIds in `.axl/<label>.agent-id` so
  // re-runs reuse the prior on-chain identity instead of minting a new
  // NFT every time the developer runs the script.
  for (const plan of PLANS) {
    const peerId = await ensureBridgeAndPeerId(plan, axlDir);
    const runtime = createAgentRuntime({
      account: plan.privateKey(),
      deployment: config.deployment,
      galileoRpcUrl: config.galileoRpcUrl,
    });
    console.log(`\n[register] ${plan.ensLabel} (${runtime.address})`);

    const idCachePath = resolve(axlDir, `${plan.ensLabel}.agent-id`);
    const existingAgentId = existsSync(idCachePath)
      ? BigInt(readFileSync(idCachePath, "utf8").trim())
      : undefined;

    // Mint (or recover) the provider's iNFT BEFORE we publish
    // `agent-context`, so the on-chain `acl.cap.inft-sale.token-id`
    // pointer is always backed by a real token.
    const tokenIdCachePath = resolve(axlDir, `${plan.ensLabel}.token-id`);
    const tokenId = await ensureProviderInft({
      plan,
      runtime,
      tokenIdCachePath,
    });

    const agentContextExtra = {
      [INFT_SALE_CAPABILITY_KEYS.contract]: runtime.deployment.galileo.aclAgentNFT,
      [INFT_SALE_CAPABILITY_KEYS.tokenId]: tokenId.toString(),
      [INFT_SALE_CAPABILITY_KEYS.minPrice]: plan.iNftSalePrice.toString(),
      [INFT_SALE_CAPABILITY_KEYS.paymentToken]: config.paymentToken,
      [INFT_SALE_CAPABILITY_KEYS.verifier]: runtime.deployment.galileo.trustedPartyVerifier,
    };

    const result = await registerAclAgent({
      publicClient: runtime.publicClient,
      walletClient: runtime.walletClient,
      identityRegistry: runtime.deployment.galileo.identityRegistry,
      ...(existingAgentId !== undefined ? { existingAgentId } : {}),
      ensLabel: plan.ensLabel,
      agentAddress: runtime.address,
      evaluatorAddress: runtime.deployment.galileo.aclEvaluator,
      axlPeerId: peerId,
      taskDomains: [...plan.taskDomains],
      paymentTokens: [config.paymentToken],
      minBudget: plan.minBudget,
      chainId: runtime.deployment.galileo.chainId,
      capabilities: ["commission", "inft-sale"],
      agentContextExtra,
    });
    if (result.minted) {
      writeFileSync(idCachePath, result.agentId.toString());
    }
    console.log(
      `[register] ${plan.ensLabel} → agentId=${result.agentId} minted=${result.minted} tokenId=${tokenId}`,
    );
    for (const tx of result.txHashes) {
      console.log(`  tx: https://chainscan-galileo.0g.ai/tx/${tx}`);
    }
  }
}

/**
 * Mint (or recover) the provider's iNFT. The seed `IntelligentData`
 * carries a small JSON envelope the provider will refresh via
 * `INftClient.update(...)` after every Flow-1 delivery (Op A in §3.11).
 *
 * Idempotent: if `<label>.token-id` exists, we read it and skip the
 * mint. If the cache is missing we mint a fresh token under the
 * provider's own EOA and persist the new `tokenId`.
 */
async function ensureProviderInft(args: {
  plan: ProviderSpec;
  runtime: ReturnType<typeof createAgentRuntime>;
  tokenIdCachePath: string;
}): Promise<bigint> {
  const { plan, runtime, tokenIdCachePath } = args;
  const providerKey = plan.privateKey();
  const providerAccount = privateKeyToAccount(providerKey);
  const providerPubKey = publicKeyFromPrivateKey(providerKey);

  const nftClient = createINftClient({
    publicClient: runtime.publicClient,
    walletClient: runtime.walletClient,
    deployment: runtime.deployment,
  });

  // Reuse the cached tokenId only if the provider still owns it.
  // After a successful Phase-2 acquisition the iNFT belongs to the
  // buyer; re-running setup with a stale cache would surface a
  // `transferFrom`-time `NotProvider()` revert during the next demo
  // session. Detect the transfer and re-mint a fresh token instead.
  if (existsSync(tokenIdCachePath)) {
    const cached = BigInt(readFileSync(tokenIdCachePath, "utf8").trim());
    let owner: `0x${string}` | null;
    try {
      owner = await nftClient.ownerOf(cached);
    } catch (err) {
      console.warn(
        `[register] ${plan.ensLabel} → cached tokenId=${cached} ownerOf() failed (${(err as Error).message}); re-minting`,
      );
      owner = null;
    }
    if (owner && owner.toLowerCase() === providerAccount.address.toLowerCase()) {
      console.log(`[register] ${plan.ensLabel} → reusing cached iNFT tokenId=${cached}`);
      return cached;
    }
    if (owner) {
      console.log(
        `[register] ${plan.ensLabel} → cached tokenId=${cached} now owned by ${owner} (transferred); minting a fresh iNFT`,
      );
    }
  }

  const seedCorpus = {
    persona: plan.persona,
    modelId: config.zgRouterModel,
    axlPeer: providerAccount.address,
    note: "seed corpus; refreshed by ProviderAgent Op A after each Flow-1 delivery",
  };
  const plaintext = stringToBytes(JSON.stringify(seedCorpus));
  const encrypted = await encryptIntelligentData(plaintext, hexToBytes(providerPubKey));

  // Seed `encryptedStorageURI` is a deterministic placeholder; Op A
  // overwrites it with the real `0g://<root>` after the first delivery.
  const seedURI = `seed://${plan.ensLabel}`;
  const { txHash, tokenId } = await nftClient.mint({
    to: providerAccount.address,
    intelligentData: [
      {
        dataDescription: `${plan.ensLabel} agent corpus`,
        dataHash: encrypted.dataHash,
      },
    ],
    encryptedStorageURI: seedURI,
  });
  writeFileSync(tokenIdCachePath, tokenId.toString());
  console.log(`[register] ${plan.ensLabel} → minted iNFT tokenId=${tokenId} tx=${txHash}`);
  return tokenId;
}

/**
 * Spin up the AXL bridge for the duration of the registration so we can
 * read the actual peer id straight off `/topology`. We don't keep the
 * bridge running — the demo coordinator restarts it later with the same
 * peer key, which keeps the peer id stable across runs.
 *
 * Uses {@link spawnAxlBridge} for the bridge lifecycle so the SDK
 * helper is the single source of truth (peer-key generation,
 * config write, peer-id poll). The script just throws the bridge
 * away after one read.
 */
async function ensureBridgeAndPeerId(plan: ProviderSpec, axlDir: string): Promise<string> {
  const cfgPath = resolve(axlDir, `${plan.ensLabel}.config.json`);
  const keyPath = resolve(axlDir, `${plan.ensLabel}.pem`);
  const { child, peerId } = await spawnAxlBridge({
    axlBin: config.axlBin,
    apiPort: plan.axl.apiPort,
    tcpPort: plan.axl.tcpPort,
    listenPort: plan.axl.listenPort,
    apiHost: "127.0.0.1",
    peers: [],
    peerKeyPath: keyPath,
    configPath: cfgPath,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    return peerId;
  } finally {
    child.kill("SIGINT");
  }
}

main().catch((err) => {
  console.error(`[register] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
