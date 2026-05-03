import { displayBudget, formatTokenAmount } from "../lib/format.js";
import {
  GALILEO_SCAN_BASE,
  SEPOLIA_SCAN_BASE,
  storageSubmissionLink,
  txLink,
} from "../lib/links.js";
import { shorten } from "../lib/state.js";
import { buildStorageChip } from "./storage-modal.js";

export function isTimelineNoise(payload) {
  const evt = payload.event;
  if (!evt) return false;
  // info-level logs are noisy; keep warn/error and the explicit
  // "agent online" signal that tracks readiness.
  if (evt.type === "log" && evt.level !== "warn" && evt.level !== "error") {
    return true;
  }
  if (payload.source === "client-stdout" && evt.type === "log") return true;
  if (
    payload.source?.startsWith("provider-") &&
    evt.type === "log" &&
    evt.kind === "stdout"
  )
    return true;
  if (evt.type === "log" && typeof evt.message === "string") {
    if (/refreshed iNFT corpus|Op [A-Z] refreshed/i.test(evt.message))
      return true;
    if (/^\[provider:.*\] Op [A-Z]/i.test(evt.message)) return true;
  }
  // discovery.match per-candidate row is redundant with the
  // discovery.candidates rollup (which the rail renders inline).
  if (evt.type === "discovery.match") return true;
  return false;
}

function normaliseRole(raw) {
  if (!raw) return "coordinator";
  if (raw === "provider-security" || raw === "provider-generalist")
    return "provider";
  if (
    raw === "client" ||
    raw === "provider" ||
    raw === "evaluator" ||
    raw === "coordinator"
  )
    return raw;
  if (raw === "client-stdout") return "client";
  return "coordinator";
}

export function eventToTimelineRow(payload) {
  const evt = payload.event;
  if (!evt) return null;
  const role = normaliseRole(evt.agentRole ?? payload.source ?? "coordinator");
  const tsCandidate = evt.at ?? payload.ts ?? null;
  const parsed = tsCandidate ? new Date(tsCandidate) : null;
  const time =
    parsed && !Number.isNaN(parsed.getTime())
      ? parsed.toLocaleTimeString()
      : new Date().toLocaleTimeString();

  const li = document.createElement("li");
  li.classList.add("event");
  if (evt.level === "warn") li.classList.add("event-warn");
  if (evt.type === "agent.error" || evt.level === "error")
    li.classList.add("event-error");

  const t = document.createElement("span");
  t.classList.add("event-time");
  t.textContent = time;
  li.appendChild(t);

  const r = document.createElement("span");
  r.classList.add("role", `role-${role}`);
  r.textContent = role;
  li.appendChild(r);

  const body = document.createElement("div");
  body.classList.add("event-body");
  const title = document.createElement("div");
  title.classList.add("event-title");
  title.textContent = describeEvent(evt);
  body.appendChild(title);

  const detail = detailFor(evt);
  if (detail) {
    const detailEl = document.createElement("div");
    detailEl.classList.add("event-detail");
    detailEl.textContent = detail;
    body.appendChild(detailEl);
  }

  const links = linksFor(evt);
  if (links.length > 0) {
    const linksEl = document.createElement("div");
    linksEl.classList.add("event-links");
    for (const link of links) {
      const a = document.createElement("a");
      a.href = link.url;
      a.target = "_blank";
      a.textContent = link.label;
      linksEl.appendChild(a);
    }
    body.appendChild(linksEl);
  }

  const storageChip = _storageChipFor(evt);
  if (storageChip) {
    const wrap = document.createElement("div");
    wrap.classList.add("event-links");
    wrap.appendChild(storageChip);
    body.appendChild(wrap);
  }
  li.appendChild(body);

  return li;
}

function _storageChipFor(evt) {
  if (evt.type !== "storage.upload" && evt.type !== "storage.download")
    return null;
  if (typeof evt.rootHash !== "string" || evt.rootHash.length === 0)
    return null;
  const kind = _storageModalKindFor(evt);
  return buildStorageChip({
    rootHash: evt.rootHash,
    txSeq: evt.txSeq,
    txHash: evt.txHash,
    label: shorten(evt.rootHash),
    kind,
    title: `0G Storage · ${evt.kind ?? "payload"} · ${evt.rootHash}`,
    modalTag: `0G Storage · ${evt.kind ?? "payload"}`,
    modalTitle: _storageModalTitle(evt),
  });
}

function _storageModalTitle(evt) {
  if (evt.kind === "deliverable") return "Deliverable payload";
  if (evt.kind === "attestation") return "Attestation bundle";
  // SDK emits `storage.upload` events with `kind: 'taskSpec'`
  // (camelCase) for TaskSpec uploads — see @acl/agent/events/types.ts.
  if (evt.kind === "taskSpec") return "TaskSpec payload";
  if (evt.kind === "source") return "Source-material payload";
  if (evt.kind === "inft-pointer") return "iNFT pointer";
  return `0G Storage · ${evt.kind ?? "payload"}`;
}

function _storageModalKindFor(evt) {
  if (evt.kind === "deliverable") return "deliverable";
  if (evt.kind === "attestation") return "attestation";
  // TaskSpec / source / iNFT-pointer payloads are plain JSON — render
  // them raw instead of letting the modal probe the deliverable endpoint
  // (which JSON-parses anything and shows a near-empty header panel).
  if (evt.kind === "taskSpec") return "json";
  if (evt.kind === "source") return "json";
  if (evt.kind === "inft-pointer") return "json";
  return "auto";
}

export function describeEvent(evt) {
  switch (evt.type) {
    case "agent.boot":
      return `agent online (${evt.ensName ?? evt.address})`;
    case "agent.shutdown":
      return "agent offline";
    case "discovery.search":
      return `searching providers · GET /agents?taskDomain=${evt.query?.taskDomain ?? "any"}`;
    case "discovery.match":
      return `candidate · ${evt.ensName} · min ${formatTokenAmount(evt.minBudget)} testUSDC`;
    case "discovery.candidates":
      return `discovery roll-up · ${evt.candidates?.length ?? 0} match${evt.candidates?.length === 1 ? "" : "es"}`;
    case "llm.thinking":
      return `thinking · ${evt.purpose}`;
    case "llm.decided":
      return `decided · ${evt.purpose}`;
    case "storage.upload":
      return `0G Storage upload · ${evt.kind}`;
    case "storage.download":
      return `0G Storage download · ${evt.kind}`;
    case "tx.sent":
      return `tx sent · ${evt.label}`;
    case "tx.confirmed":
      return `tx confirmed · ${evt.label}`;
    case "negotiation.send":
      return `→ ${evt.verb}${evt.amount ? ` · ${displayBudget(evt.amount, evt.paymentToken)}` : ""}`;
    case "negotiation.receive":
      return `← ${evt.verb}${evt.amount ? ` · ${displayBudget(evt.amount, evt.paymentToken)}` : ""}`;
    case "job.created":
      return `job created · id=${evt.jobId}`;
    case "job.funded":
      return `job funded · id=${evt.jobId} · ${formatTokenAmount(evt.budget)} testUSDC`;
    case "job.submitted":
      return `deliverable submitted · id=${evt.jobId}`;
    case "job.settled":
      return `job settled · id=${evt.jobId} · approved=${evt.approved}`;
    case "evaluator.evaluated":
      return `verdict · approved=${evt.approved} · score=${evt.score} · tee=${evt.teeVerified}`;
    case "agent.error":
      return `error · ${evt.message?.split("\n")[0] ?? ""}`;
    case "log":
      return evt.message ?? "log";
    case "phase2-ready":
      return "phase 2 buyer flow armed";
    case "phase2-disabled":
      return `phase 2 disabled · ${evt.reason ?? "missing config"}`;
    case "phase2": {
      const e = evt.event ?? {};
      switch (e.type) {
        case "phase2.skipped":
          return `phase 2 skipped · ${e.reason ?? ""}`;
        case "phase2.completed":
          return `phase 2 ${e.result?.decision ?? "?"} · ${e.result?.reason ?? ""}`;
        case "phase2.failed":
          return `phase 2 failed · ${e.error ?? ""}`;
        default:
          return e.type ?? "phase2 event";
      }
    }
    default:
      return evt.type ?? "event";
  }
}

export function detailFor(evt) {
  if (evt.type === "llm.decided" && evt.output) {
    if (evt.purpose === "rank-providers") {
      const rationale = evt.output.rationale ?? evt.output.reason;
      const ranked = Array.isArray(evt.output.rankedEnsNames)
        ? evt.output.rankedEnsNames
        : evt.output.pickedEnsName
          ? [evt.output.pickedEnsName]
          : [];
      const pickStr = ranked.length > 0 ? `pick=${ranked[0]}` : "";
      if (rationale) return `${pickStr}${pickStr ? " · " : ""}${rationale}`;
      if (pickStr) return pickStr;
    }
    if (evt.purpose === "decide" && evt.output.reason) {
      return `${evt.output.decision ?? "?"} · ${evt.output.reason}`;
    }
    if (evt.purpose === "evaluate-counter" && evt.output.reason) {
      return `${evt.output.decision ?? "?"} · ${evt.output.reason}`;
    }
    if (evt.purpose === "author-taskspec" && evt.output.title) {
      return `title="${evt.output.title}"`;
    }
    if (evt.purpose === "phase2-decide" && evt.output.reason) {
      return `${evt.output.decision ?? "?"} · ${evt.output.reason}`;
    }
    const s = JSON.stringify(evt.output);
    return s.length > 220 ? `${s.slice(0, 220)}…` : s;
  }
  if (evt.type === "negotiation.send" || evt.type === "negotiation.receive") {
    const parts = [];
    if (evt.counterpart) parts.push(`peer=${shorten(evt.counterpart)}`);
    if (evt.reason) parts.push(`reason="${evt.reason}"`);
    return parts.join(" · ");
  }
  if (evt.type === "discovery.match")
    return `domains: ${evt.taskDomains ?? "(unknown)"}`;
  if (evt.type === "discovery.candidates" && evt.candidates) {
    return evt.candidates
      .map(
        (c) => `${c.ensName} (caps=${(c.capabilities ?? []).join(",") || "—"})`,
      )
      .join(" · ");
  }
  if (evt.type === "storage.upload" || evt.type === "storage.download") {
    return `root=${shorten(evt.rootHash)}`;
  }
  if (evt.type === "agent.error" && evt.message?.includes("\n"))
    return evt.message.split("\n").slice(0, 4).join(" · ");
  return "";
}

export function linksFor(evt) {
  const links = [];
  if (evt.txHash && evt.chainId) {
    links.push(txLink(evt.chainId, evt.txHash));
  }
  if (typeof evt.txSeq === "number") {
    links.push({ label: "0G storage", url: storageSubmissionLink(evt.txSeq) });
  }
  if (evt.type === "phase2") {
    const r = evt.event?.result ?? {};
    if (r.transferTxHash) {
      links.push({
        label: "iTransfer tx",
        url: `${GALILEO_SCAN_BASE}/tx/${r.transferTxHash}`,
      });
    }
    if (r.updateTxHash) {
      links.push({
        label: "update tx",
        url: `${GALILEO_SCAN_BASE}/tx/${r.updateTxHash}`,
      });
    }
  }
  return links;
}
