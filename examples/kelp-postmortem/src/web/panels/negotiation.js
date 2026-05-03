/**
 * Negotiation transcript — renders into evidence-rail section 04.
 *
 * One row per `negotiation.send` / `negotiation.receive` event from
 * the SDK, plus optional "attempt N" rows from `negotiation.attempt`
 * / `negotiation.failed` so the LLM walking the ranked candidate list
 * stays visible.
 */

import { setEvidencePill } from "../lib/diagram.js";
import { displayBudget } from "../lib/format.js";
import { $, escapeHtml, shorten } from "../lib/state.js";

export function appendNegotiationMsg(direction, role, evt) {
  const log = $("#negotiation-log");
  if (!log) return;

  const li = document.createElement("li");
  li.className = `negotiation-msg verb-${evt.verb}`;
  const time = evt.at ? new Date(evt.at).toLocaleTimeString() : new Date().toLocaleTimeString();

  const fromLabel = direction === "send" ? `${role} → counterpart` : `${role} ← counterpart`;

  li.innerHTML = `
    <span class="nm-verb">${evt.verb}</span>
    <span class="nm-from">${escapeHtml(fromLabel)}</span>
    <span class="nm-time">${time}</span>
  `;

  const detail = document.createElement("div");
  detail.className = "nm-detail";
  if (evt.amount !== undefined) {
    const b = document.createElement("span");
    b.className = "nm-budget";
    b.textContent = `budget · ${displayBudget(evt.amount, evt.paymentToken)}`;
    detail.appendChild(b);
  }
  if (evt.reason) {
    const r = document.createElement("span");
    r.className = "nm-reason";
    r.textContent = `reason · ${evt.reason}`;
    detail.appendChild(r);
  }
  if (evt.counterpart) {
    const c = document.createElement("span");
    c.textContent = `peer · ${shorten(evt.counterpart)}`;
    detail.appendChild(c);
  }
  if (detail.children.length > 0) li.appendChild(detail);

  log.appendChild(li);
  while (log.children.length > 80) log.removeChild(log.firstChild);

  setEvidencePill(
    "negotiation",
    evt.verb === "ACCEPT" ? "settled" : evt.verb === "REJECT" ? "rejected" : "live",
    evt.verb === "ACCEPT" ? "done" : evt.verb === "REJECT" ? "error" : "busy",
  );
}

export function appendAttemptRow(evt) {
  const log = $("#negotiation-log");
  if (!log) return;
  const li = document.createElement("li");
  li.className = "attempt-row";
  li.textContent = `attempt ${evt.attempt + 1}/${evt.maxAttempts} · ${evt.counterpartEnsName ?? "—"}`;
  log.appendChild(li);
  setEvidencePill("negotiation", "negotiating", "busy");
}

export function appendAttemptFailedRow(evt) {
  const log = $("#negotiation-log");
  if (!log) return;
  const li = document.createElement("li");
  li.className = "attempt-row";
  li.dataset.state = "failed";
  li.textContent = `attempt ${evt.attempt + 1}/${evt.maxAttempts} · ${evt.counterpartEnsName ?? "—"} · ${evt.reason ?? "failed"}${evt.willRetry ? " · will retry" : ""}`;
  log.appendChild(li);
  if (!evt.willRetry) setEvidencePill("negotiation", "failed", "error");
}

export function appendCounterDecision(decision) {
  const log = $("#negotiation-log");
  if (!log) return;
  const last = log.lastElementChild;
  if (!last?.classList?.contains("negotiation-msg")) return;
  const detail =
    last.querySelector(".nm-detail") ??
    (() => {
      const d = document.createElement("div");
      d.className = "nm-detail";
      last.appendChild(d);
      return d;
    })();
  const span = document.createElement("span");
  span.className = "nm-reason";
  span.textContent = `client → ${decision?.decision ?? "?"} (${decision?.reason ?? ""})`;
  detail.appendChild(span);
}
