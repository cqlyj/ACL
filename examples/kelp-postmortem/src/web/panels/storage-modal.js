/**
 * Floating "0G Storage payload viewer" modal.
 *
 * The in-place panels (deliverable, taskspec, attestation) intentionally
 * stay compact so the page reads as a one-glance lifecycle. When the
 * operator wants to verify the actual bytes, they click any storage
 * chip — this opens the modal, which downloads the payload through the
 * coordinator's read-only `AclStorage` proxy and renders the full body.
 *
 * The modal is content-type aware:
 *   - Deliverables / attestation bundles render the structured fields
 *     up top and the raw `content` (or full bundle JSON) below.
 *   - JSON / text payloads pretty-print or render verbatim.
 *
 * All event listeners are scoped to `#storage-modal` so this module is
 * safe to import multiple times.
 */

import { GALILEO_SCAN_BASE, STORAGE_SCAN_BASE, storageSubmissionLink } from "../lib/links.js";
import { $, shorten } from "../lib/state.js";

const MAX_PAYLOAD_PREVIEW = 32_000;

let _wired = false;

function _root() {
  return $("#storage-modal");
}

function _wireOnce() {
  if (_wired) return;
  _wired = true;
  const root = _root();
  if (!root) return;
  for (const el of root.querySelectorAll("[data-action='close']")) {
    el.addEventListener("click", closeStorageModal);
  }
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !root.hidden) closeStorageModal();
  });
}

export function closeStorageModal() {
  const root = _root();
  if (!root) return;
  root.hidden = true;
}

/**
 * Open the modal for a specific 0G Storage handle.
 *
 * @param {{
 *   rootHash: string,
 *   txSeq?: number | string,
 *   txHash?: string,
 *   kind?: 'deliverable'|'attestation'|'json'|'text'|'auto',
 *   title?: string,
 *   tag?: string,
 * }} input
 */
export async function openStorageModal(input) {
  _wireOnce();
  const root = _root();
  if (!root) return;

  const titleEl = $("#storage-modal-title");
  const tagEl = $("#storage-modal-tag");
  const metaEl = $("#storage-modal-meta");
  const bodyEl = $("#storage-modal-body");
  if (!titleEl || !tagEl || !metaEl || !bodyEl) return;

  titleEl.textContent = input.title ?? "0G Storage";
  tagEl.textContent = input.tag ?? "storage payload";
  metaEl.innerHTML = "";
  bodyEl.innerHTML = "";
  const loading = document.createElement("p");
  loading.className = "ev-empty";
  loading.textContent = "Loading from 0G Storage…";
  bodyEl.appendChild(loading);

  // Render meta header (root hash, txSeq, link).
  if (input.rootHash) {
    _appendMeta(metaEl, "root", _codeMono(shorten(input.rootHash), input.rootHash));
  }
  if (input.txSeq !== undefined && input.txSeq !== null) {
    const a = document.createElement("a");
    a.href = storageSubmissionLink(input.txSeq);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `#${input.txSeq}`;
    a.title = `${STORAGE_SCAN_BASE}/submission/${input.txSeq}`;
    _appendMeta(metaEl, "txSeq", a);
  }
  if (input.txHash) {
    const a = document.createElement("a");
    a.href = `${GALILEO_SCAN_BASE}/tx/${input.txHash}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = shorten(input.txHash);
    a.title = input.txHash;
    _appendMeta(metaEl, "tx", a);
  }

  root.hidden = false;

  // Try the requested kind first; on a 404 fall back through the
  // remaining kinds so the operator can see *something* even when the
  // SDK didn't tag the payload precisely.
  const kindOrder = _kindOrder(input.kind ?? "auto");
  let payload = null;
  let usedKind = null;
  let lastError = null;
  for (const kind of kindOrder) {
    try {
      const res = await fetch(`/api/storage/${kind}/${input.rootHash}`);
      const json = await res.json();
      if (res.ok && json?.ok) {
        payload = json;
        usedKind = kind;
        break;
      }
      lastError = json?.error ?? `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message ?? String(err);
    }
  }

  bodyEl.innerHTML = "";
  if (!payload) {
    const err = document.createElement("p");
    err.className = "ev-empty";
    err.style.color = "var(--error)";
    err.textContent = `0G Storage fetch failed: ${lastError ?? "unknown error"}`;
    bodyEl.appendChild(err);
    return;
  }

  _renderPayload(bodyEl, usedKind, payload);
  if (typeof payload.elapsedMs === "number") {
    _appendMeta(metaEl, "fetched", _codeMono(`${payload.elapsedMs} ms`));
  }
}

function _kindOrder(kind) {
  if (kind === "auto") return ["deliverable", "attestation", "json", "text"];
  return [kind, "json", "text"];
}

function _appendMeta(parent, label, valueNode) {
  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "8px";
  row.style.alignItems = "baseline";
  row.style.justifyContent = "flex-end";
  const lab = document.createElement("span");
  lab.className = "label";
  lab.textContent = label;
  row.appendChild(lab);
  row.appendChild(valueNode);
  parent.appendChild(row);
}

function _codeMono(text, title) {
  const c = document.createElement("code");
  c.textContent = text;
  if (title) c.title = title;
  return c;
}

function _renderPayload(body, kind, payload) {
  if (kind === "deliverable") {
    _renderDeliverable(body, payload);
    return;
  }
  if (kind === "attestation") {
    _renderAttestation(body, payload);
    return;
  }
  if (kind === "json") {
    _renderJson(body, payload);
    return;
  }
  if (kind === "text") {
    _renderText(body, payload);
    return;
  }
  _renderText(body, payload);
}

function _renderDeliverable(body, payload) {
  const d = payload.deliverable ?? {};
  const fields = [
    ["jobId", d.jobId],
    ["provider", d.provider],
    ["taskSpec root", d.taskSpecRoot],
    ["content type", d.contentType],
    ["sealed at", d.createdAt],
  ];
  body.appendChild(_keyList("Deliverable header", fields));

  const md = d.content;
  if (typeof md === "string" && md.length > 0) {
    body.appendChild(_section(`Deliverable.content (${d.contentType ?? "text"})`, md));
  }
}

function _renderAttestation(body, payload) {
  const a = payload.attestation ?? {};
  const fields = [
    ["jobId", a.jobId],
    ["evaluator", a.evaluator],
    ["taskSpec root", a.taskSpecRoot],
    ["deliverable root", a.deliverableRoot],
    ["evaluator agentId", a.evaluatorAgentId],
    ["score", a.normalizedScore],
    ["approved", String(a.approved)],
    ["model", a.modelId ?? a.model],
    ["sealed at", a.createdAt],
  ];
  body.appendChild(_keyList("Attestation bundle header", fields));

  if (a.signedText) {
    body.appendChild(_section("TEE-signed verdict (raw)", a.signedText));
  }
  body.appendChild(_section("Bundle JSON", JSON.stringify(a, null, 2)));
}

function _renderJson(body, payload) {
  const value = payload.json ?? payload.value ?? payload;
  body.appendChild(_section("JSON", JSON.stringify(value, null, 2)));
}

function _renderText(body, payload) {
  const t = payload.text ?? payload.content ?? JSON.stringify(payload, null, 2);
  body.appendChild(_section("Raw bytes (UTF-8)", String(t)));
}

function _section(label, text) {
  const wrap = document.createElement("section");
  wrap.className = "storage-modal-section";
  const lab = document.createElement("span");
  lab.className = "storage-modal-section-label";
  lab.textContent = label;
  wrap.appendChild(lab);
  const pre = document.createElement("pre");
  pre.className = "storage-modal-pre";
  pre.textContent =
    text.length > MAX_PAYLOAD_PREVIEW
      ? `${text.slice(0, MAX_PAYLOAD_PREVIEW)}\n\n…[truncated ${text.length - MAX_PAYLOAD_PREVIEW} bytes]…`
      : text;
  wrap.appendChild(pre);
  return wrap;
}

function _keyList(label, rows) {
  const wrap = document.createElement("section");
  wrap.className = "storage-modal-section";
  const lab = document.createElement("span");
  lab.className = "storage-modal-section-label";
  lab.textContent = label;
  wrap.appendChild(lab);
  const ul = document.createElement("ul");
  ul.className = "storage-modal-keylist";
  for (const [k, v] of rows) {
    if (v === undefined || v === null || v === "") continue;
    const li = document.createElement("li");
    const lk = document.createElement("span");
    lk.textContent = k;
    const lv = document.createElement("span");
    lv.textContent = String(v);
    li.appendChild(lk);
    li.appendChild(lv);
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

/**
 * Build a clickable storage chip. Use everywhere in the panels where a
 * storage Merkle root or txSeq surfaces — clicking the chip opens the
 * modal viewer.
 */
export function buildStorageChip(input) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "storage-chip";
  // `chipVariant` is purely cosmetic (CSS hook for icon colour). Keep
  // it separate from `kind` (which steers `/api/storage/<kind>/<root>`).
  const variant = input.chipVariant ?? input.kind;
  if (variant === "inft-pointer") chip.dataset.kind = "inft-pointer";
  const icon = document.createElement("span");
  icon.className = "storage-chip-icon";
  icon.textContent = "⊞";
  chip.appendChild(icon);
  const label = document.createElement("span");
  label.textContent = input.label ?? shorten(input.rootHash ?? "");
  chip.appendChild(label);
  chip.title =
    input.title ??
    (input.txSeq !== undefined
      ? `txSeq=${input.txSeq} · root=${input.rootHash}`
      : (input.rootHash ?? ""));
  chip.addEventListener("click", () => {
    openStorageModal({
      rootHash: input.rootHash,
      txSeq: input.txSeq,
      txHash: input.txHash,
      kind: input.kind ?? "auto",
      title: input.modalTitle ?? input.title,
      tag: input.modalTag ?? input.tag,
    });
  });
  return chip;
}
