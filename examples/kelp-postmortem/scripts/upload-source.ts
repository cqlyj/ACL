/**
 * One-time setup: upload the Kelp DAO post-mortem source article to
 * 0G Storage. Persists the resulting root hash directly into the
 * example's `.env` (atomic replace-or-append of the
 * `KELP_SOURCE_ROOT=` line) so subsequent `bun run dev` invocations
 * pick it up without any manual shell glue.
 *
 * Why upload a known-text artefact at all? The deliverable evaluation
 * needs to be reproducible: the provider's prompt inlines the article,
 * the evaluator's bundle must reference exactly that copy. Uploading it
 * once keeps the bundle JSON's `extensions.sourceMaterial` field a
 * stable bytes32 reference instead of a 4 KB string blob.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAgentRuntime } from "@acl/agent";
import { config } from "../src/config.js";
import { KELP_SOURCE_PROVENANCE, KELP_SOURCE_TEXT } from "../src/source.js";

const ENV_KEY = "KELP_SOURCE_ROOT";

async function main() {
  const runtime = createAgentRuntime({
    account: config.clientPrivateKey(),
    deployment: config.deployment,
    galileoRpcUrl: config.galileoRpcUrl,
  });
  console.log(
    `[upload-source] uploading ${KELP_SOURCE_TEXT.length} chars from client ${runtime.address}`,
  );
  const upload = await runtime.storage.uploadJson({
    kind: "acl-demo:source-material",
    provenance: KELP_SOURCE_PROVENANCE,
    text: KELP_SOURCE_TEXT,
  });
  console.log(`[upload-source] root: ${upload.rootHash}`);
  if (upload.txHash) {
    console.log(
      `[upload-source] tx:   https://chainscan-galileo.0g.ai/tx/${upload.txHash}`,
    );
  } else {
    console.log(
      "[upload-source] tx:   (none — root already known to the storage indexer)",
    );
  }
  if (upload.txSeq !== undefined) {
    console.log(
      `[upload-source] view: https://storagescan-galileo.0g.ai/submission/${upload.txSeq}`,
    );
  }

  const envPath = resolve(import.meta.dir, "..", ".env");
  const updated = upsertEnvLine(envPath, ENV_KEY, upload.rootHash);
  console.log(
    `[upload-source] ${updated.action} ${ENV_KEY} in ${envPath} — ready for \`bun run dev\`.`,
  );
}

/**
 * Idempotent `.env` mutation: replace an existing `KEY=...` line in
 * place if present, otherwise append it. Writes through a tempfile +
 * `rename(2)` so a crash mid-update never leaves the operator's
 * `.env` truncated. The setup script requires a pre-existing `.env`
 * (the rest of the demo expects every key seeded), so we throw
 * loudly when the file is missing instead of inventing a half-empty
 * one. We deliberately don't load a dotenv parser — every value here
 * is a 0x-prefixed root hash with no quoting concerns, and a
 * hand-rolled regex keeps the script dependency-free.
 */
function upsertEnvLine(
  path: string,
  key: string,
  value: string,
): { action: "updated" | "appended" } {
  if (!existsSync(path)) {
    throw new Error(
      `[upload-source] ${path} not found. Copy .env.example to .env and seed the demo private keys before re-running.`,
    );
  }
  const current = readFileSync(path, "utf8");
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  let next: string;
  let action: "updated" | "appended";
  if (re.test(current)) {
    next = current.replace(re, line);
    action = "updated";
  } else {
    const sep = current.endsWith("\n") || current.length === 0 ? "" : "\n";
    next = `${current}${sep}${line}\n`;
    action = "appended";
  }
  // Atomic write: stage in a sibling tempfile, then `rename(2)` over
  // the original. POSIX rename is atomic within the same filesystem,
  // so a kill -9 during this critical section can never leave a
  // partial `.env` on disk.
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, next);
  renameSync(tmpPath, path);
  return { action };
}

main().catch((err) => {
  console.error(`[upload-source] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
