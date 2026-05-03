/**
 * Phase 2 — buyer-as-evaluator iNFT acquisition.
 *
 * UI surface:
 *   - inline preview block inside the client tile (acquired persona,
 *     modelId, axlPeer, lastJobId, plus expand-to-full-JSON)
 *   - verification strip directly under the preview
 *     (dataHash matches keccak(buyer-uploaded ciphertext) ✓,
 *      ownerOf(tokenId) = client.address ✓,
 *      encryptedStorageURIs(tokenId) = 0g://<root> ✓)
 *   - iNFT card flight from provider tile to client tile (driven by
 *     `flyInftCard` in diagram.js)
 *   - evidence-rail section 08 hooks row updates (INFTDeliveryHook
 *     fired) handled in `hooks.js`
 */

import { fetchInftOwner } from "../lib/api.js";
import {
  buildVerifyLine,
  flyInftCard,
  setEvidencePill,
} from "../lib/diagram.js";
import { GALILEO_SCAN_BASE } from "../lib/links.js";
import { $, escapeHtml, shorten, shortenHash, state } from "../lib/state.js";
import { buildStorageChip } from "./storage-modal.js";

let _phase2Started = false;

export function markPhase2Ready() {
  setEvidencePill("hooks", "phase 2 armed", "idle");
}

export function markPhase2Disabled(reason) {
  setEvidencePill("hooks", "phase 2 disabled", "skipped");
  if (reason) console.info(`[phase2] disabled · ${reason}`);
}

export function showAcquireBeat(decisionLabel) {
  // Show "LLM thinking → ACQUIRE/SKIP" beat inline in the client tile.
  // The decision label includes a free-text rationale that can run long;
  // it gets its own row beneath the "phase 2 · client decides" header so
  // the flex `space-between` of `.tile-extra-head` doesn't interleave
  // the two strings when the rationale wraps.
  const extra = $("#client-extra");
  if (!extra) return;
  extra.hidden = false;

  let head = extra.querySelector("[data-role='phase2-beat']");
  if (!head) {
    head = document.createElement("div");
    head.className = "tile-extra-head";
    head.dataset.role = "phase2-beat";
    head.innerHTML =
      '<span class="phase2-beat-label">phase 2 · client decides</span><span class="phase2-beat-decision">thinking</span>';
    extra.appendChild(head);
  }

  // The decisionLabel format is `<DECISION> · <reason>`. Split so the
  // bold short verdict pill stays on the header row, and the long-form
  // rationale flows as a soft body row beneath.
  const raw = decisionLabel ?? "thinking";
  const sep = " · ";
  const idx = raw.indexOf(sep);
  const verdict = idx >= 0 ? raw.slice(0, idx) : raw;
  const rationale = idx >= 0 ? raw.slice(idx + sep.length) : "";

  const verdictEl = head.querySelector(".phase2-beat-decision");
  if (verdictEl) verdictEl.textContent = verdict;

  let rationaleEl = extra.querySelector("[data-role='phase2-beat-reason']");
  if (rationale) {
    if (!rationaleEl) {
      rationaleEl = document.createElement("p");
      rationaleEl.className = "phase2-beat-reason";
      rationaleEl.dataset.role = "phase2-beat-reason";
      head.insertAdjacentElement("afterend", rationaleEl);
    }
    rationaleEl.textContent = rationale;
  } else if (rationaleEl) {
    rationaleEl.remove();
  }

  if (!_phase2Started) {
    _phase2Started = true;
  }
}

export function renderPhase2(payloadEvent) {
  const outer = payloadEvent.event ?? {};
  const e = outer.event ?? outer;
  const r = e.result ?? {};
  if (e.type === "phase2.skipped") {
    showAcquireBeat(`SKIP · ${escapeHtml(e.reason ?? "")}`);
    return;
  }
  if (e.type === "phase2.failed") {
    showAcquireBeat("FAILED");
    return;
  }
  if (e.type !== "phase2.completed") return;

  showAcquireBeat(`${escapeHtml(r.decision ?? "DONE")}`);

  if (r.decision !== "ACQUIRE") return;

  // Kick the iNFT card flight from the seller to the client.
  const sellerRole = state.chosenProviderRole;
  if (sellerRole) {
    flyInftCard({ tokenId: r.tokenId, fromRole: sellerRole });
  }

  // Render the inline preview + verification strip in the client tile.
  _renderClientTilePreview(r);
}

function _renderClientTilePreview(r) {
  const extra = $("#client-extra");
  if (!extra) return;
  extra.hidden = false;

  // Remove an existing preview block if we're re-rendering.
  for (const el of extra.querySelectorAll("[data-role='phase2-preview']"))
    el.remove();
  for (const el of extra.querySelectorAll("[data-role='phase2-verify']"))
    el.remove();

  const head = document.createElement("div");
  head.className = "tile-extra-head";
  head.dataset.role = "phase2-preview";
  head.innerHTML = `<span>acquired persona</span><span>tokenId ${escapeHtml(r.tokenId ?? "?")}</span>`;
  extra.appendChild(head);

  const personaList = document.createElement("ul");
  personaList.className = "persona-list";
  personaList.dataset.role = "phase2-preview";

  const bundle = r.bundle ?? null;
  const summary = _bundleSummary(bundle);
  const rows = [
    ["modelId", summary.modelId ?? r.sellerEns ?? "—"],
    ["axlPeer", summary.axlPeer ?? "—"],
    ["lastJobId", summary.lastJobId ?? r.jobId ?? "—"],
    ["ensName", r.sellerEns ?? "—"],
  ];
  for (const [k, v] of rows) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${k}</span><span>${escapeHtml(String(v))}</span>`;
    personaList.appendChild(li);
  }
  extra.appendChild(personaList);

  // "Show full" button — opens the storage modal with the new
  // ciphertext root (the corpus the buyer just uploaded), or, when
  // the bundle is present in JSON, shows it inline.
  if (bundle !== null && bundle !== undefined) {
    const showFull = document.createElement("button");
    showFull.type = "button";
    showFull.className = "persona-show-full";
    showFull.textContent = "show full bundle";
    showFull.dataset.role = "phase2-preview";
    showFull.addEventListener("click", () => {
      _openBundleInline(extra, bundle);
    });
    extra.appendChild(showFull);
  }

  // Verification strip
  const verify = document.createElement("div");
  verify.className = "verify-strip";
  verify.dataset.role = "phase2-verify";
  if (r.newDataHash) {
    verify.appendChild(
      buildVerifyLine({
        claim: "dataHash matches keccak(buyer-uploaded ciphertext)",
        proofLabel: shortenHash(r.newDataHash),
        proofTitle: r.newDataHash,
        state: "ok",
      }),
    );
  }
  if (r.newEncryptedStorageURI?.startsWith("0g://")) {
    verify.appendChild(
      buildVerifyLine({
        claim: `encryptedStorageURIs(tokenId) = ${r.newEncryptedStorageURI}`,
        proofLabel: "0G storage",
        proofTitle: r.newEncryptedStorageURI,
        onClick: () => {
          const root = r.newEncryptedStorageURI.slice("0g://".length);
          if (root.startsWith("0x")) {
            // Open the storage modal with the ciphertext root
            import("./storage-modal.js").then((m) =>
              m.openStorageModal({
                rootHash: root,
                kind: "json",
                title: "Buyer-encrypted bundle",
                tag: "0G Storage · iNFT bundle",
              }),
            );
          }
        },
        state: "ok",
      }),
    );
  }
  if (r.nftContract && r.tokenId) {
    const node = buildVerifyLine({
      claim: "ownerOf(tokenId) = client.address",
      proofLabel: "checking…",
      proofTitle: `ownerOf(${r.tokenId})`,
      state: "pending",
    });
    verify.appendChild(node);
    fetchInftOwner(r.nftContract, r.tokenId).then((res) => {
      if (!res?.ok) {
        node.dataset.state = "fail";
        node.querySelector(".verify-proof").textContent = "fetch failed";
        return;
      }
      const isClient =
        res.owner?.toLowerCase() === state.clientAddress?.toLowerCase();
      node.dataset.state = isClient ? "ok" : "fail";
      const proof = node.querySelector(".verify-proof");
      proof.textContent = shorten(res.owner);
      proof.title = res.owner;
      proof.addEventListener("click", () => {
        window.open(`${GALILEO_SCAN_BASE}/address/${res.owner}`, "_blank");
      });
    });
  }
  extra.appendChild(verify);

  // Update section 06 (deliverable) note: Phase-2 deliverable was an
  // iNFT pointer commitment (intentionally not stored in 0G).
  const dBody = $("#ev-deliverable");
  if (dBody && !dBody.querySelector("[data-role='phase2-pointer']")) {
    const note = document.createElement("p");
    note.className = "ev-empty";
    note.dataset.role = "phase2-pointer";
    note.textContent =
      "phase 2 deliverable was an iNFT pointer commitment (application/vnd.acl.inft-pointer; 32-byte tuple, not stored in 0G).";
    dBody.appendChild(note);
  }
}

function _bundleSummary(bundle) {
  if (!bundle) return {};
  let value = bundle;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof value !== "object" || value === null) return {};
  return {
    modelId: value.modelId ?? value.persona?.modelId ?? null,
    axlPeer: value.axlPeer ?? value.persona?.axlPeer ?? null,
    lastJobId: value.lastJobId ?? null,
  };
}

function _openBundleInline(parent, bundle) {
  let pre = parent.querySelector("pre[data-role='phase2-full']");
  if (pre) {
    pre.remove();
    return;
  }
  pre = document.createElement("pre");
  pre.dataset.role = "phase2-full";
  pre.className = "deliverable-text";
  pre.style.fontSize = "11px";
  pre.style.maxHeight = "240px";
  try {
    pre.textContent =
      typeof bundle === "string" ? bundle : JSON.stringify(bundle, null, 2);
  } catch {
    pre.textContent = String(bundle);
  }
  parent.appendChild(pre);
}

export function didInftTransfer(payloadEvent) {
  const outer = payloadEvent.event ?? {};
  const e = outer.event ?? outer;
  if (e.type !== "phase2.completed") return false;
  const r = e.result ?? {};
  if (!r.previousOwner || !r.newOwner) return false;
  return (
    String(r.previousOwner).toLowerCase() !== String(r.newOwner).toLowerCase()
  );
}
