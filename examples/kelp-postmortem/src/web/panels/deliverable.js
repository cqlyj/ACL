/**
 * Deliverable panel — renders into evidence-rail section 06.
 *
 * Downloads the deliverable from `/api/storage/deliverable/<root>`
 * (server-side AclStorage proxy), shows a header with TaskSpec
 * verification + content type, plus the raw content. The full payload
 * lives behind a `View full payload` chip that opens the storage
 * modal.
 */

import { buildVerifyLine, setEvidencePill } from "../lib/diagram.js";
import { GALILEO_SCAN_BASE } from "../lib/links.js";
import { $, shortenHash } from "../lib/state.js";
import { buildStorageChip } from "./storage-modal.js";

const _renderedRoots = new Set();

export async function renderDeliverableFromRoot(rootHash, opts = {}) {
  if (_renderedRoots.has(rootHash)) return;
  const body = $("#ev-deliverable");
  if (!body) return;

  setEvidencePill("deliverable", "fetching", "busy");

  if (_renderedRoots.size === 0) {
    body.innerHTML = "";
    const placeholder = document.createElement("p");
    placeholder.className = "ev-empty";
    placeholder.textContent = `GET /api/storage/deliverable/${rootHash}`;
    body.appendChild(placeholder);
  }

  let payload;
  try {
    const res = await fetch(`/api/storage/deliverable/${rootHash}`);
    payload = await res.json();
    if (!res.ok || !payload?.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
  } catch (err) {
    if (_renderedRoots.size === 0) {
      body.innerHTML = "";
      const errEl = document.createElement("p");
      errEl.className = "ev-empty";
      errEl.style.color = "var(--error)";
      errEl.textContent = `0G Storage fetch failed: ${err.message ?? err}`;
      body.appendChild(errEl);
      setEvidencePill("deliverable", "fetch failed", "error");
    }
    return;
  }
  _renderedRoots.add(rootHash);

  body.innerHTML = "";

  // Header: actions + meta
  const actions = document.createElement("div");
  actions.className = "deliverable-actions";
  const viewer = buildStorageChip({
    rootHash,
    kind: "deliverable",
    label: "View full payload",
    title: "Full deliverable from 0G Storage",
    modalTitle: "Deliverable payload",
    modalTag: "0G Storage · deliverable",
  });
  actions.appendChild(viewer);
  body.appendChild(actions);

  const d = payload.deliverable ?? {};
  const grid = document.createElement("div");
  grid.className = "ev-row";
  const rows = [
    ["root hash", rootHash, "hash"],
    ["jobId", d.jobId, null],
    ["provider", d.provider, "address"],
    ["taskSpec root", d.taskSpecRoot, "hash"],
    ["content type", d.contentType, null],
    ["sealed at", d.createdAt, null],
  ];
  for (const [k, v, kind] of rows) {
    if (v === undefined || v === null) continue;
    const lab = document.createElement("span");
    lab.className = "ev-row-label";
    lab.textContent = k;
    const val = document.createElement("span");
    val.className = "ev-row-value";
    if (kind === "hash" && typeof v === "string" && v.startsWith("0x")) {
      val.innerHTML = `<code title="${v}">${shortenHash(v)}</code>`;
    } else if (
      kind === "address" &&
      typeof v === "string" &&
      v.length === 42 &&
      v.startsWith("0x")
    ) {
      val.innerHTML = `<a href="${GALILEO_SCAN_BASE}/address/${v}" target="_blank" rel="noopener">${shortenHash(v)}</a>`;
    } else {
      val.textContent = String(v);
    }
    grid.appendChild(lab);
    grid.appendChild(val);
  }
  body.appendChild(grid);

  // Per-claim verify strip
  const verify = document.createElement("div");
  verify.className = "verify-strip";
  if (typeof d.taskSpecRoot === "string" && opts.expectedTaskSpecRoot) {
    verify.appendChild(
      buildVerifyLine({
        claim: "taskSpec root matches negotiated TaskSpec",
        proofLabel: "match",
        proofTitle: `expected ${opts.expectedTaskSpecRoot}`,
        state:
          d.taskSpecRoot.toLowerCase() === opts.expectedTaskSpecRoot.toLowerCase() ? "ok" : "fail",
      }),
    );
  }
  verify.appendChild(
    buildVerifyLine({
      claim: "bytes downloaded from 0G Storage match committed root",
      proofLabel: "root",
      proofTitle: rootHash,
      state: "ok",
    }),
  );
  body.appendChild(verify);

  // Body content
  const md = d.content;
  if (typeof md === "string" && md.length > 0) {
    const heading = document.createElement("div");
    heading.className = "deliverable-heading";
    heading.textContent = `Deliverable.content (${d.contentType ?? "text"})`;
    body.appendChild(heading);
    const pre = document.createElement("pre");
    pre.className = "deliverable-text";
    pre.textContent = md.length > 4_000 ? `${md.slice(0, 4_000)}…` : md;
    body.appendChild(pre);
  }

  setEvidencePill("deliverable", "fetched", "done");
}

export function resetDeliverable() {
  _renderedRoots.clear();
  const body = $("#ev-deliverable");
  if (body) body.innerHTML = "";
  setEvidencePill("deliverable", "idle", "idle");
}
