/**
 * Provider process. Two flavours, picked by the first CLI arg:
 *
 *   - `security`: the security-specialist agent
 *       (advertises taskDomains: "security,research", min budget 50 USDC).
 *   - `generalist`: the generalist agent
 *       (advertises taskDomains: "general,research", min budget 30 USDC).
 *
 * Both run the same code path; only the persona, ENS label, accept
 * policy, and AXL port differ.
 *
 * Flow-2 (iNFT) extension. When a TaskSpec arrives with
 * `deliveryType === 'iNFT'`, the SDK's new `produceDeliverable`
 * strategy hook returns a canonical pointer commitment instead of a
 * 0G-Storage upload. The hook side then pulls the iNFT into escrow
 * via `transferFrom` inside `_onBeforeSubmit`, so we need to run the
 * provider's `INftClient.approve(hookAddress, tokenId)` once per
 * (tokenId, hook) pair. We also subscribe to our own
 * `job.delivered.provider-side` events so we can autonomously refresh
 * the iNFT corpus (Op A) after every Flow-1 delivery.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INFT_POINTER_CONTENT_TYPE,
  ProviderAgent,
  type ProviderAgentConfig,
  createZGRouterBackend,
  inftSaleDeliverableStrategy,
} from "@acl/agent";
import { createINftClient, iNftEncryptAndUpdate, publicKeyFromPrivateKey } from "@acl/inft";
import { type Hex, bytesToHex, hexToBytes, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { COORDINATOR_URL, PROVIDER_SPECS, type ProviderFlavour, config } from "../config.js";
import { forwardEventsToCoordinator } from "../event-forwarder.js";
import { exitWhenOrphaned } from "../parent-watchdog.js";

async function main() {
  exitWhenOrphaned();
  const flavour = process.argv[2] as ProviderFlavour | undefined;
  if (!flavour || !(flavour in PROVIDER_SPECS)) {
    throw new Error("usage: bun run provider-process.ts (security|generalist)");
  }
  const spec = PROVIDER_SPECS[flavour];

  const llm = createZGRouterBackend({
    apiKey: config.zgRouterApiKey(),
    model: config.zgRouterModel,
    ...(config.zgRouterBaseUrl ? { baseUrl: config.zgRouterBaseUrl } : {}),
  });

  // Idempotently look up the provider's iNFT and ERC-8004 agent id
  // (both written by `scripts/register-providers.ts`). Either cache
  // missing = no Flow-2; we just stay Flow-1-only and log the absence.
  const tokenId = _readBigIntCache(spec.ensLabel, "token-id");
  const providerAgentId = _readBigIntCache(spec.ensLabel, "agent-id");

  const providerKey = spec.privateKey();
  const providerAccount = privateKeyToAccount(providerKey);

  const coordinatorUrl = COORDINATOR_URL;

  // Forward-declare so the iNFT-sale strategy below can close over
  // the runtime that's created INSIDE the constructor. The provider
  // agent reads `produceDeliverable` lazily (only when a job's
  // TaskSpec lands), so this lazily-bound capture is safe — the
  // strategy never runs before construction completes.
  let agent: ProviderAgent;

  const agentConfig: ProviderAgentConfig = {
    account: providerKey,
    galileoRpcUrl: config.galileoRpcUrl,
    ...(config.sepoliaRpcUrl ? { sepoliaRpcUrl: config.sepoliaRpcUrl } : {}),
    llm,
    axlApiUrl: `http://127.0.0.1:${spec.axl.apiPort}`,
    ensName: `${spec.ensLabel}.${config.deployment.ens.parentName}`,
    persona: spec.persona,
    acceptPolicy: {
      minBudget: spec.minBudget,
      iNftSalePrice: spec.iNftSalePrice,
      taskDomains: [...spec.taskDomains],
      paymentTokens: [config.paymentToken],
      maxConcurrentJobs: 1,
    },
    // Vertical strategy: when the TaskSpec asks for an iNFT
    // deliveryType, the SDK factory returns the pointer commitment
    // instead of a 0G-storage upload AND wires the idempotent
    // ERC-721 approval the INFTDeliveryHook needs at submit-time.
    // Returning `null` for non-iNFT deliveryTypes keeps Flow-1
    // jobs on the SDK's default LLM-text path.
    ...(tokenId !== null && providerAgentId !== null
      ? {
          produceDeliverable: (input) =>
            inftSaleDeliverableStrategy({
              publicClient: agent.runtime.publicClient,
              walletClient: agent.runtime.walletClient,
              deployment: config.deployment,
              tokenId,
              providerAgentId,
              onApprovalMined: ({ txHash }) =>
                console.log(`[provider:${flavour}] approved iNFT to hook tx=${txHash}`),
            })(input),
        }
      : {}),
  };
  agent = new ProviderAgent(agentConfig);

  const off = forwardEventsToCoordinator({
    events: agent.events,
    coordinatorUrl,
    source: spec.source,
  });

  // Op A: refresh the iNFT corpus after each Flow-1 delivery. We
  // listen on our own event bus, NOT the chain — the SDK already
  // emits `job.delivered.provider-side` immediately after `submit`,
  // and we don't want to double-fire on a chain re-org.
  //
  // Real-corpus pipeline:
  //   1. Build the agent bundle: persona + LLM model id + AXL peer
  //      address + ENS metadata + the latest Flow-1 deliverable's
  //      storage root (downloaded so the buyer gets the actual
  //      content, not just a pointer).
  //   2. Encrypt under a fresh AES-GCM key, sealed to the provider's
  //      own SEC1 pubkey (so the provider can still decrypt locally).
  //   3. Upload the ciphertext to 0G Storage; the on-chain URI is
  //      `0g://<rootHash>` so the buyer flow can download it.
  //   4. Hand the raw `dataKey` to the coordinator's in-process key
  //      registry — that's our demo "oracle custody" surface. The
  //      buyer flow fetches the key from the same registry to
  //      decrypt and re-seal under its own pubkey.
  //   5. Update the iNFT on-chain (`update(tokenId, [...], uri)`).
  if (tokenId !== null) {
    agent.events.on(async (ev) => {
      if (ev.type !== "job.delivered.provider-side") return;
      if (ev.contentType === INFT_POINTER_CONTENT_TYPE) return;
      try {
        const nft = createINftClient({
          publicClient: agent.runtime.publicClient,
          walletClient: agent.runtime.walletClient,
          deployment: config.deployment,
        });
        // Replay safety: if the iNFT has been sold (tokenId 0 owner
        // is no longer us), Op A `update()` would revert with
        // `NotTokenOwnerOrApproved`. Skip cleanly so the provider
        // can keep delivering Flow-1 jobs without polluting the
        // event stream with redundant errors.
        const owner = await nft.ownerOf(tokenId);
        if (owner.toLowerCase() !== providerAccount.address.toLowerCase()) {
          console.log(
            `[provider:${flavour}] Op A skipped (iNFT tokenId=${tokenId} owned by ${owner}, not us)`,
          );
          return;
        }
        // (1) Build the bundle. The example pulls the latest
        //     deliverable content into the corpus so the buyer
        //     receives more than just a pointer; production
        //     consumers can decide what to publish.
        let lastDeliverableContent: unknown = null;
        try {
          lastDeliverableContent = await agent.runtime.storage.downloadJson(ev.deliverableRoot);
        } catch {
          lastDeliverableContent = { rootHash: ev.deliverableRoot };
        }
        const bundle = {
          persona: spec.persona,
          modelId: config.zgRouterModel,
          axlPeer: providerAccount.address,
          ensName: agentConfig.ensName,
          lastJobId: ev.jobId,
          lastDeliverable: ev.deliverableRoot,
          lastDeliverableContent,
          refreshedAt: new Date().toISOString(),
        };
        // (2-5) Encrypt + upload + publish key + on-chain update —
        //       all driven by `iNftEncryptAndUpdate`. The demo's
        //       "oracle custody surface" is the coordinator's
        //       in-process key registry, plumbed through the
        //       `onEncrypted` callback so the dataKey is published
        //       BEFORE the chain advertises the new dataHash. Real
        //       deployments would replace this with a 0G TeeML
        //       enclave or a KMS.
        const result = await iNftEncryptAndUpdate({
          storage: agent.runtime.storage,
          nft,
          publicClient: agent.runtime.publicClient,
          input: {
            tokenId,
            plaintext: stringToBytes(JSON.stringify(bundle)),
            recipientPubKey: hexToBytes(publicKeyFromPrivateKey(providerKey)),
            dataDescription: `${spec.ensLabel} agent bundle`,
            onEncrypted: ({ dataKey, rootHash, dataHash }) =>
              _postKeyToCoordinator(coordinatorUrl, {
                tokenId,
                dataKey: bytesToHex(dataKey),
                rootHash,
                dataHash,
                ensLabel: spec.ensLabel,
              }),
          },
        });
        console.log(
          `[provider:${flavour}] Op A refreshed iNFT corpus tokenId=${tokenId} root=${result.rootHash.slice(0, 12)}... tx=${result.txHash}`,
        );
      } catch (err) {
        console.error(`[provider:${flavour}] Op A failed: ${(err as Error).message}`);
      }
    });
  }

  console.log(
    `[provider:${flavour}] starting (ens=${agentConfig.ensName}${tokenId !== null ? `, tokenId=${tokenId}` : ", no-iNFT"})`,
  );
  await agent.start();
  console.log(`[provider:${flavour}] live (peer=${agent.peerId.slice(0, 12)}...)`);

  const shutdown = async () => {
    off();
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * POST the freshly-derived AES `dataKey` (and its companion 0G
 * Storage root) to the coordinator's in-process key registry. The
 * registry is intentionally trusted-by-construction: the coordinator,
 * provider processes, client process, and demo oracle all live in
 * the same demo machine. In production this surface would be the
 * 0G TeeML enclave that signs `OwnershipProof`s.
 */
async function _postKeyToCoordinator(
  coordinatorUrl: string,
  payload: {
    tokenId: bigint;
    dataKey: Hex;
    rootHash: Hex;
    dataHash: Hex;
    ensLabel: string;
  },
): Promise<void> {
  const url = `${coordinatorUrl}/api/inft-keys/${payload.tokenId.toString()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dataKey: payload.dataKey,
      rootHash: payload.rootHash,
      dataHash: payload.dataHash,
      ensLabel: payload.ensLabel,
    }),
  });
  if (!res.ok) {
    throw new Error(`coordinator key registry POST failed: ${res.status} ${res.statusText}`);
  }
}

/**
 * Read a `<label>.<suffix>` BigInt cache file written by
 * `register-providers.ts` (e.g. `token-id`, `agent-id`). Returns
 * `null` when the file is missing or unparseable — the caller treats
 * a `null` token-id or agent-id as "skip Flow-2 wiring".
 */
function _readBigIntCache(ensLabel: string, suffix: "token-id" | "agent-id"): bigint | null {
  const path = resolve(
    new URL("..", import.meta.url).pathname,
    "..",
    ".axl",
    `${ensLabel}.${suffix}`,
  );
  if (!existsSync(path)) return null;
  try {
    return BigInt(readFileSync(path, "utf8").trim());
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(`[provider] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
