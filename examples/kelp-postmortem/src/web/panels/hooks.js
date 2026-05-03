/**
 * Hooks panel — renders into evidence-rail section 08 (settlement &
 * hooks).
 *
 * The SDK doesn't surface hook execution as its own event (each hook
 * fires inside the same on-chain transaction as `settle`), so we bind
 * them to the operator-observable outcomes:
 *
 *   - ReputationHook fires when settle() lands AND the picked agent's
 *     ReputationRegistry feedback count incremented (we sample
 *     `/api/reputation/<agentId>` before vs after).
 *   - INFTDeliveryHook fires when the iNFT actually changed owners
 *     after Phase-2 (we sample `/api/inft/owner/<contract>/<tokenId>`).
 *
 * Each row shows the hook's deployed bytecode address as a chainscan
 * link plus the on-chain settle tx hash so the operator can replay the
 * trace.
 */

import { setEvidencePill } from "../lib/diagram.js";
import { GALILEO_SCAN_BASE } from "../lib/links.js";
import { $, shorten, state } from "../lib/state.js";

let _settleTxHash = null;
let _settleTxHashPhase2 = null;

const ROWS = [
  {
    id: "reputation",
    name: "ReputationHook",
    detail:
      "ReputationRegistry.giveFeedback(jobId, score) — increments the picked agent's feedback count.",
    addressKey: "reputationHook",
    icon: "R",
  },
  {
    id: "inft",
    name: "INFTDeliveryHook",
    detail:
      "Validates application/vnd.acl.inft-pointer deliverables; runs iTransfer from seller to buyer.",
    addressKey: "inftDeliveryHook",
    icon: "i",
  },
];

let _bound = false;

export function renderHooksPanel() {
  if (_bound) return;
  _bound = true;
  const body = $("#ev-hooks");
  if (!body) return;
  body.innerHTML = "";

  const settleHead = document.createElement("p");
  settleHead.className = "ev-empty";
  settleHead.dataset.role = "settle-head";
  settleHead.textContent = "settle tx not yet on chain.";
  body.appendChild(settleHead);

  const list = document.createElement("ul");
  list.className = "hooks-list";
  for (const r of ROWS) {
    const row = document.createElement("li");
    row.className = "hooks-row";
    row.dataset.state = "armed";
    row.dataset.hook = r.id;
    row.innerHTML = `
      <span class="hooks-row-icon" aria-hidden="true">${r.icon}</span>
      <div class="hooks-row-meta">
        <span class="hooks-row-name">${r.name}</span>
        <span class="hooks-row-detail">${r.detail}</span>
      </div>
      <div class="hooks-row-action">
        <span class="hooks-row-status">armed</span>
      </div>
    `;
    const action = row.querySelector(".hooks-row-action");
    const galileo = state.configCache?.deployment?.galileo;
    const addr = galileo ? galileo[r.addressKey] : null;
    if (addr && action) {
      const link = document.createElement("a");
      link.href = `${GALILEO_SCAN_BASE}/address/${addr}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = shorten(addr);
      link.title = addr;
      action.prepend(link);
    }
    list.appendChild(row);
  }
  body.appendChild(list);
  setEvidencePill("hooks", "awaiting settle", "idle");
}

export function rememberSettleTx(txHash, approved, phase) {
  if (phase === "phase2") _settleTxHashPhase2 = txHash ?? null;
  else _settleTxHash = txHash ?? null;
  renderHooksPanel();
  const head = document.querySelector("#ev-hooks p.ev-empty[data-role='settle-head']");
  if (head && txHash) {
    head.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = "settle tx · ";
    head.appendChild(span);
    const a = document.createElement("a");
    a.href = `${GALILEO_SCAN_BASE}/tx/${txHash}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = shorten(txHash);
    a.title = txHash;
    a.style.color = "var(--accent)";
    head.appendChild(a);
    head.appendChild(
      document.createTextNode(
        ` · approved=${approved} · ${phase === "phase2" ? "phase 2" : "phase 1"}`,
      ),
    );
    head.style.fontStyle = "normal";
    head.style.color = "var(--ink-2)";
  }
}

export function markHookFired(hookId, info) {
  renderHooksPanel();
  const row = document.querySelector(`.hooks-row[data-hook='${hookId}']`);
  if (!row) return;
  row.dataset.state = info.state ?? "fired";
  const status = row.querySelector(".hooks-row-status");
  if (status) status.textContent = info.label ?? "fired";

  const action = row.querySelector(".hooks-row-action");
  if (action) {
    for (const el of action.querySelectorAll("a[data-tx]")) el.remove();
    const tx = info.txHash ?? (hookId === "inft" ? _settleTxHashPhase2 : _settleTxHash);
    if (tx) {
      const a = document.createElement("a");
      a.dataset.tx = "1";
      a.href = `${GALILEO_SCAN_BASE}/tx/${tx}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = `${hookId === "inft" ? "iTransfer" : "settle"} · ${shorten(tx)}`;
      a.title = tx;
      action.appendChild(a);
    }
  }

  _refreshTag();
}

export function markHookSkipped(hookId, label) {
  renderHooksPanel();
  const row = document.querySelector(`.hooks-row[data-hook='${hookId}']`);
  if (!row) return;
  row.dataset.state = "armed";
  const status = row.querySelector(".hooks-row-status");
  if (status) status.textContent = label ?? "no-op";
  _refreshTag();
}

function _refreshTag() {
  const rows = document.querySelectorAll(".hooks-row");
  let fired = 0;
  for (const r of rows) if (r.dataset.state === "fired") fired += 1;
  if (rows.length === 0) {
    setEvidencePill("hooks", "awaiting settle", "idle");
    return;
  }
  if (fired === 0) {
    setEvidencePill("hooks", "armed", "busy");
    return;
  }
  setEvidencePill(
    "hooks",
    fired === rows.length ? "all hooks fired" : `${fired}/${rows.length} fired`,
    "done",
  );
}
