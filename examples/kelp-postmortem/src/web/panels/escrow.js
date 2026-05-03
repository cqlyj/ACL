/**
 * Escrow transitions panel — renders into evidence-rail section 05.
 *
 * One row per ERC-8183 transition. The set is fixed
 * (createJob → setProvider → setBudget → fund → submit → settle); each
 * row pulls its tx hash from the SDK's `tx.confirmed` / `job.created`
 * / `job.funded` / `job.submitted` / `job.settled` events.
 */

import { setEvidencePill } from "../lib/diagram.js";
import { GALILEO_SCAN_BASE } from "../lib/links.js";
import { $, escapeHtml, shortenHash } from "../lib/state.js";

const ROWS = [
  ["createJob", "createJob(provider, evaluator)", "createJob"],
  ["setProvider", "setProvider(jobId, provider)", "setProvider"],
  ["setBudget", "setBudget(jobId, amount, hookConfig?)", "setBudget"],
  ["fund", "fund(jobId)", "fund"],
  ["submit", "submit(jobId, deliverableRoot, contentType)", "submit"],
  ["settle", "complete(jobId, attestationRoot)", "settle"],
];

let _bound = false;

export function renderEscrowSkeleton() {
  if (_bound) return;
  _bound = true;
  const list = $("#escrow-list");
  if (!list) return;
  list.innerHTML = "";
  ROWS.forEach(([key, args], idx) => {
    const li = document.createElement("li");
    li.dataset.step = key;
    li.dataset.state = "idle";
    li.innerHTML = `
      <span class="escrow-num">${String(idx + 1).padStart(2, "0")}</span>
      <span class="escrow-name">${escapeHtml(_displayName(key))}</span>
      <span class="escrow-args">${escapeHtml(args)}</span>
      <span class="escrow-tx" hidden></span>
    `;
    list.appendChild(li);
  });
}

export function recordEscrowTx(stepKey, txHash) {
  if (!txHash) return;
  renderEscrowSkeleton();
  const li = document.querySelector(`#escrow-list li[data-step="${stepKey}"]`);
  if (!li) return;
  li.dataset.state = "done";
  const tx = li.querySelector(".escrow-tx");
  if (tx) {
    tx.hidden = false;
    tx.innerHTML = `<a href="${GALILEO_SCAN_BASE}/tx/${txHash}" target="_blank" rel="noopener" title="${txHash}">${shortenHash(txHash)}</a>`;
  }
  // Update pill: count completed rows
  const total = ROWS.length;
  const done = document.querySelectorAll(
    "#escrow-list li[data-state='done']",
  ).length;
  setEvidencePill(
    "escrow",
    done === total ? "all 6" : `${done}/${total}`,
    done === total ? "done" : "busy",
  );
}

export function resetEscrow() {
  _bound = false;
  renderEscrowSkeleton();
  setEvidencePill("escrow", "idle", "idle");
}

function _displayName(key) {
  if (key === "settle") return "complete";
  return key;
}
