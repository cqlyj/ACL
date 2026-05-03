/**
 * Evaluation (TEE proof) panel — renders into evidence-rail section
 * 07.
 *
 * The 0G Compute attestation bundle is stored in 0G Storage at the
 * `attestationRoot` carried on `job.settled.client-side`. We lazy-fetch
 * it via `/api/storage/attestation/<root>` and render the 7 fields the
 * brief calls out (model, computeProvider, promptHash, responseId,
 * responseVerification, teeSignerAddress, signedText, teeSignature)
 * plus a green "on-chain settle enforces ecrecover(...) == teeSigner"
 * line. Click-throughs link to the storage scanner / chain.
 */

import { fetchAttestation } from "../lib/api.js";
import {
  buildVerifyLine,
  setEvaluatorEvaluating,
  setEvidencePill,
} from "../lib/diagram.js";
import { GALILEO_SCAN_BASE } from "../lib/links.js";
import { $, shortenHash, state } from "../lib/state.js";
import { buildStorageChip } from "./storage-modal.js";

let _renderedRoot = null;
let _phase2Morphed = false;

export function setEvaluationBusy() {
  setEvidencePill("evaluation", "evaluating", "busy");
  setEvaluatorEvaluating(true);
}

export function renderEvaluationFromEvent(evt) {
  const body = $("#ev-evaluation");
  if (!body) return;
  setEvaluatorEvaluating(false);

  // Pre-fetch placeholder while attestationRoot is unknown.
  body.innerHTML = "";
  const headRow = document.createElement("div");
  headRow.className = "tee-grid";
  const rows = [
    ["jobId", evt.jobId],
    ["model", evt.modelId],
    ["approved", String(evt.approved)],
    ["score", typeof evt.score === "number" ? evt.score.toFixed(3) : evt.score],
    [
      "TEE verified",
      evt.teeVerified === true
        ? "true"
        : evt.teeVerified === false
          ? "false"
          : "n/a",
    ],
  ];
  for (const [k, v] of rows) {
    if (v === undefined || v === null) continue;
    const lab = document.createElement("span");
    lab.className = "tee-label";
    lab.textContent = k;
    const val = document.createElement("span");
    val.className = "tee-value";
    val.textContent = String(v);
    headRow.appendChild(lab);
    headRow.appendChild(val);
  }
  body.appendChild(headRow);

  const note = document.createElement("p");
  note.className = "ev-empty";
  note.textContent =
    "Full attestation bundle (computeProvider · promptHash · responseId · signedText · teeSignature · teeSignerAddress) loads after settlement.";
  body.appendChild(note);

  setEvidencePill("evaluation", "verdict in", "done");
}

/**
 * Pull the attestation bundle from 0G Storage and render the 7 TEE
 * fields + verification strip. Called once `job.settled.client-side`
 * delivers the `attestationRoot`.
 */
export async function renderAttestationBundle(rootHash) {
  if (rootHash === _renderedRoot) return;
  const body = $("#ev-evaluation");
  if (!body) return;

  const result = await fetchAttestation(rootHash);
  if (!result?.ok) {
    const note = document.createElement("p");
    note.className = "ev-empty";
    note.style.color = "var(--error)";
    note.textContent = `0G Storage attestation fetch failed: ${result?.error ?? "unknown"}`;
    body.appendChild(note);
    return;
  }
  _renderedRoot = rootHash;
  state.attestationBundle = result.attestation;

  // Capture any Phase 2 morph strip already appended above; we re-clear
  // the body to render the bundle, then re-append the morph so the
  // narrative ordering (Phase 1 attestation → Phase 2 morph) is
  // preserved when the async fetch resolves out-of-order with the
  // synchronous morph append.
  const existingMorph = body.querySelector('[data-phase2-morph="true"]');
  body.innerHTML = "";

  // Storage chip + bundle storage handle
  const actions = document.createElement("div");
  actions.className = "deliverable-actions";
  actions.appendChild(
    buildStorageChip({
      rootHash,
      kind: "attestation",
      label: "View full attestation bundle",
      title: "0G Storage · attestation",
      modalTitle: "Attestation bundle",
      modalTag: "0G Storage · attestation",
    }),
  );
  body.appendChild(actions);

  const a = result.attestation ?? {};
  const grid = document.createElement("div");
  grid.className = "tee-grid";
  const rows = [
    ["jobId", a.jobId, null],
    ["model", a.modelId ?? a.model, null],
    [
      "computeProvider",
      a.computeProvider,
      a.computeProvider
        ? `${GALILEO_SCAN_BASE}/address/${a.computeProvider}`
        : null,
    ],
    [
      "promptHash",
      a.promptHash ? shortenHash(a.promptHash, 10, 8) : null,
      null,
    ],
    ["responseId", a.responseId, null],
    ["responseVerification", String(a.responseVerification), null],
    [
      "teeSignerAddress",
      a.teeSignerAddress,
      a.teeSignerAddress
        ? `${GALILEO_SCAN_BASE}/address/${a.teeSignerAddress}`
        : null,
    ],
    [
      "teeSignature",
      a.teeSignature ? shortenHash(a.teeSignature, 10, 8) : null,
      null,
    ],
    ["score", a.normalizedVerdict?.score, null],
    ["approved", String(a.normalizedVerdict?.approved), null],
    ["sealed at", a.createdAt, null],
  ];
  for (const [k, v, href] of rows) {
    if (v === undefined || v === null) continue;
    const lab = document.createElement("span");
    lab.className = "tee-label";
    lab.textContent = k;
    const val = document.createElement("span");
    val.className = "tee-value";
    if (href) {
      val.innerHTML = `<a href="${href}" target="_blank" rel="noopener">${String(v)}</a>`;
    } else {
      val.textContent = String(v);
    }
    grid.appendChild(lab);
    grid.appendChild(val);
  }
  body.appendChild(grid);

  if (typeof a.signedText === "string" && a.signedText.length > 0) {
    const lab = document.createElement("div");
    lab.className = "deliverable-heading";
    lab.textContent = "TEE signed payload (raw)";
    body.appendChild(lab);
    const block = document.createElement("pre");
    block.className = "tee-signed-block";
    block.textContent = a.signedText;
    body.appendChild(block);
  }

  // Verify strip: ecrecover(...) == teeSigner is a chain-enforced rule;
  // we surface it as a green claim with the contract link.
  const verify = document.createElement("div");
  verify.className = "verify-strip";
  verify.appendChild(
    buildVerifyLine({
      claim:
        "on-chain settle enforces ecrecover(signedText, teeSignature) == teeSigner",
      proofLabel: "rule",
      proofTitle: "ACLEvaluator.complete verifies the signature on chain",
      onClick: () => {
        const aclEval = state.configCache?.deployment?.galileo?.aclEvaluator;
        if (aclEval)
          window.open(`${GALILEO_SCAN_BASE}/address/${aclEval}`, "_blank");
      },
      state: "ok",
    }),
  );
  if (a.responseVerification === true) {
    verify.appendChild(
      buildVerifyLine({
        claim: "0G Compute broker.inference.processResponse(...) verified",
        proofLabel: "responseVerification",
        proofTitle: "set by SDK after broker confirmation",
        state: "ok",
      }),
    );
  }
  body.appendChild(verify);

  if (existingMorph || _phase2Morphed) {
    if (existingMorph) body.appendChild(existingMorph);
    setEvidencePill("evaluation", "phase 2 · self-evaluator", "done");
  } else {
    setEvidencePill("evaluation", "tee proof", "done");
  }
}

/**
 * Append a Phase 2 "morph strip" beneath Phase 1's attestation evidence.
 * Phase 2 bypasses the third-party ACLEvaluator (the buyer self-completes
 * by signing a JobProposal naming themselves as evaluator); the on-chain
 * `complete()` is gated by `msg.sender == job.evaluator`. Surfacing this
 * inline in the evidence rail is the locked `elig_p2_morph_strip` choice.
 */
export function appendPhase2EvaluationMorph(clientAddress) {
  const body = $("#ev-evaluation");
  if (!body) return;
  _phase2Morphed = true;
  if (body.querySelector('[data-phase2-morph="true"]')) {
    setEvidencePill("evaluation", "phase 2 · self-evaluator", "done");
    return;
  }

  const morph = document.createElement("div");
  morph.className = "verify-strip phase2-morph-strip";
  morph.setAttribute("data-phase2-morph", "true");

  const heading = document.createElement("div");
  heading.className = "phase2-morph-heading";
  heading.textContent = "phase 2 · evaluator morph";
  morph.appendChild(heading);

  morph.appendChild(
    buildVerifyLine({
      claim: "ACLEvaluator bypassed — buyer self-completes",
      proofLabel: "rule",
      proofTitle:
        "Phase 2 JobProposal names client.address as Job.evaluator; AgenticCommerce.complete() is gated by msg.sender == job.evaluator",
      state: "ok",
    }),
  );
  if (clientAddress) {
    morph.appendChild(
      buildVerifyLine({
        claim: `Job.evaluator == client.address (${clientAddress.slice(0, 6)}…${clientAddress.slice(-4)})`,
        proofLabel: "match",
        proofTitle: clientAddress,
        state: "ok",
      }),
    );
  }
  body.appendChild(morph);

  setEvidencePill("evaluation", "phase 2 · self-evaluator", "done");
}
