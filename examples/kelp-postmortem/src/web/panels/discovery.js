/**
 * Discovery + LLM rank panels — render into evidence-rail sections
 * 01 (discovery) and 02 (rank).
 *
 * The LLM rank output the SDK now emits is `{ rankedEnsNames: string[],
 * rationale: string }` (best-first). We treat `rankedEnsNames[0]` as
 * the picked provider for the diagram, and render the full ordered
 * list in the rank section.
 */

import { fetchReputation } from "../lib/api.js";
import { setEvidencePill, setTradablePulse } from "../lib/diagram.js";
import { formatTokenAmount } from "../lib/format.js";
import { $, escapeHtml, state } from "../lib/state.js";

const _beforeRepCounts = new Map();
let _postSettleRepShown = false;

export function resetPostSettleRep() {
  _postSettleRepShown = false;
  _beforeRepCounts.clear();
}

/* ───────── Section 01 · discovery ───────── */

export function renderDiscoveryStart(query) {
  const body = $("#ev-discovery");
  if (!body) return;
  body.innerHTML = "";

  const queryRow = document.createElement("div");
  queryRow.className = "discovery-query";
  queryRow.innerHTML = `
    <span class="discovery-query-label">gateway</span>
    <span class="discovery-query-value"><code>GET /agents?taskDomain=${escapeHtml(
      query?.taskDomain ?? "any",
    )}</code></span>
  `;
  body.appendChild(queryRow);

  const empty = document.createElement("p");
  empty.className = "ev-empty";
  empty.textContent = "Awaiting candidates…";
  body.appendChild(empty);

  setEvidencePill("discovery", "searching", "busy");
}

export function renderDiscoveryCandidates(payload) {
  state.lastCandidates = payload;
  const body = $("#ev-discovery");
  if (!body) return;
  body.innerHTML = "";

  const queryRow = document.createElement("div");
  queryRow.className = "discovery-query";
  queryRow.innerHTML = `
    <span class="discovery-query-label">gateway</span>
    <span class="discovery-query-value"><code>GET /agents?taskDomain=${escapeHtml(
      payload.query?.taskDomain ?? "any",
    )}</code></span>
  `;
  body.appendChild(queryRow);

  const note = document.createElement("p");
  note.className = "ev-empty";
  note.textContent = `${payload.candidates.length} candidate${payload.candidates.length === 1 ? "" : "s"}. Each row is an ENSIP-25 subname; reputation comes from on-chain ACLReputationRegistry.`;
  body.appendChild(note);

  const list = document.createElement("ul");
  list.className = "candidates-list";
  payload.candidates.forEach((c, i) => {
    const card = document.createElement("li");
    card.className = "candidate-card";
    card.dataset.ens = c.ensName;
    card.dataset.rank = String(i + 1);

    const head = document.createElement("div");
    head.className = "candidate-head";
    head.innerHTML = `
      <span class="candidate-rank">cand ${i + 1}</span>
      <span class="candidate-name">${escapeHtml(c.ensName)}</span>
      <span class="candidate-rep" data-state="loading" data-agent-id="${escapeHtml(String(c.agentId ?? ""))}">reputation · loading…</span>
    `;
    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "candidate-meta";
    if (c.minBudget !== undefined) {
      const span = document.createElement("span");
      span.textContent = `min-budget ${formatTokenAmount(c.minBudget)} testUSDC`;
      meta.appendChild(span);
    }
    if (c.agentId !== undefined) {
      const span = document.createElement("span");
      span.textContent = `agentId #${c.agentId}`;
      meta.appendChild(span);
    }
    if (c.taskDomains?.length) {
      const span = document.createElement("span");
      span.textContent = `domains: ${c.taskDomains.join(", ")}`;
      meta.appendChild(span);
    }
    card.appendChild(meta);

    if (c.capabilities?.length) {
      const caps = document.createElement("div");
      caps.className = "candidate-caps";
      for (const cap of c.capabilities) {
        const chip = document.createElement("span");
        chip.className = "cap-chip";
        chip.dataset.cap = cap;
        chip.textContent = cap;
        caps.appendChild(chip);
      }
      card.appendChild(caps);
    }

    list.appendChild(card);

    if (c.agentId !== undefined) {
      _fetchBeforeRep(card.querySelector(".candidate-rep"), String(c.agentId));
    }
  });
  body.appendChild(list);

  setEvidencePill(
    "discovery",
    `${payload.candidates.length} match${payload.candidates.length === 1 ? "" : "es"}`,
    "done",
  );

  // Mirror provider capability chips onto the provider tiles + check for
  // tradable iNFT capability (drives the tradable-pulse animation).
  _propagateProviderChips(payload.candidates);
}

function _propagateProviderChips(candidates) {
  for (const c of candidates) {
    const role = _roleForEnsName(c.ensName);
    if (!role) continue;
    const wrapId =
      role === "provider-security" ? "security-chips" : "generalist-chips";
    const wrap = document.getElementById(wrapId);
    if (wrap) {
      // Only re-render the cap chips, not the tradable pulse (which is
      // appended separately by setTradablePulse so we don't clobber it).
      for (const oldChip of wrap.querySelectorAll(".cap-chip"))
        oldChip.remove();
      for (const cap of c.capabilities ?? []) {
        const chip = document.createElement("span");
        chip.className = "cap-chip";
        chip.dataset.cap = cap;
        chip.textContent = cap;
        wrap.appendChild(chip);
      }
    }
    // The provider publishes `inft-sale` capability params as dotted
    // keys at the top level of `agentContext` (the raw wire shape SDK
    // preserves verbatim) — e.g.
    //   "acl.cap.inft-sale.token-id":  "12"
    //   "acl.cap.inft-sale.min-price": "25000000"
    // so we read the dotted keys directly.
    const ctx = c.agentContext ?? {};
    const tokenId = ctx["acl.cap.inft-sale.token-id"];
    const minPrice = ctx["acl.cap.inft-sale.min-price"];
    if (tokenId !== undefined && minPrice && BigInt(minPrice) > 0n) {
      setTradablePulse(role, {
        title: `tokenId ${tokenId} · min-price ${minPrice}`,
      });
    }
  }
}

function _roleForEnsName(ensName) {
  if (typeof ensName !== "string") return null;
  // Resolve the active provider tile by matching against the labels
  // the coordinator publishes through `/api/config`. Falls back to a
  // best-effort `kelp-*` heuristic only when the config cache hasn't
  // been populated yet (e.g. during the very first SSE event before
  // `refreshConfig()` resolves).
  const providers = state.configCache?.providers ?? {};
  const lc = ensName.toLowerCase();
  if (
    typeof providers.security === "string" &&
    lc === providers.security.toLowerCase()
  ) {
    return "provider-security";
  }
  if (
    typeof providers.generalist === "string" &&
    lc === providers.generalist.toLowerCase()
  ) {
    return "provider-generalist";
  }
  if (lc.startsWith("kelp-security")) return "provider-security";
  if (lc.startsWith("kelp-generalist")) return "provider-generalist";
  return null;
}

async function _fetchBeforeRep(target, agentId) {
  const result = await fetchReputation(agentId);
  if (!target) return;
  if (!result?.ok) {
    target.textContent = "reputation · err";
    target.dataset.state = "error";
    return;
  }
  if (!result.reputation) {
    target.textContent = "no feedback yet";
    target.dataset.state = "empty";
    return;
  }
  const r = result.reputation;
  const score = (r.normalized ?? 0).toFixed(2);
  target.textContent = `${score} avg · ${r.count} feedback${r.count === "1" ? "" : "s"}`;
  target.dataset.state = "ok";
  _beforeRepCounts.set(agentId, Number(r.count));
}

/* ───────── Section 02 · LLM rank ───────── */

export function renderRank(decision) {
  const body = $("#ev-rank");
  if (!body) return;
  body.innerHTML = "";

  const ranked = Array.isArray(decision?.rankedEnsNames)
    ? decision.rankedEnsNames
    : decision?.pickedEnsName
      ? [decision.pickedEnsName]
      : [];
  state.rankedEnsNames = ranked;

  if (ranked.length > 0) {
    state.chosenEnsName = ranked[0];
    state.chosenProviderRole = _roleForEnsName(ranked[0]);
    const cached = (state.lastCandidates?.candidates ?? []).find(
      (c) => (c.ensName ?? "").toLowerCase() === ranked[0].toLowerCase(),
    );
    if (cached?.agentId !== undefined) {
      state.pickedAgentId = String(cached.agentId);
    }
  }

  const list = document.createElement("ol");
  list.className = "rank-list";
  ranked.forEach((ens, i) => {
    const li = document.createElement("li");
    if (i === 0) li.dataset.pick = "true";
    li.innerHTML = `
      <span class="rank-pos">#${i + 1}</span>
      <span class="rank-ens">${escapeHtml(ens)}</span>
      ${i === 0 ? '<span class="rank-tag">picked</span>' : ""}
    `;
    list.appendChild(li);
  });
  body.appendChild(list);

  if (decision?.rationale || decision?.reason) {
    const q = document.createElement("div");
    q.className = "rationale";
    q.innerHTML = `<span class="rationale-label">LLM rationale</span>${escapeHtml(decision.rationale ?? decision.reason)}`;
    body.appendChild(q);
  }

  // Highlight the picked candidate in the discovery section
  for (const card of document.querySelectorAll(
    "#ev-discovery .candidate-card",
  )) {
    card.dataset.rank = "0";
  }
  const pickedCard = document.querySelector(
    `#ev-discovery .candidate-card[data-ens="${state.chosenEnsName}"]`,
  );
  if (pickedCard) pickedCard.dataset.rank = "1";

  setEvidencePill("rank", "picked", "done");
}

/* ───────── post-settle reputation delta ───────── */

export function renderPostSettleReputation(agentId) {
  if (_postSettleRepShown) return;
  _postSettleRepShown = true;
  const wrap = $("#ev-discovery");
  if (!wrap) return;
  const after = document.createElement("p");
  after.className = "ev-empty";
  after.dataset.role = "post-settle";
  after.textContent = "post-settle reputation · loading…";
  wrap.appendChild(after);
  fetchReputation(String(agentId)).then((result) => {
    if (!result?.ok || !result.reputation) {
      after.textContent = "post-settle reputation · no record";
      return;
    }
    const afterCount = Number(result.reputation.count);
    const beforeCount = _beforeRepCounts.get(String(agentId)) ?? 0;
    const delta = afterCount - beforeCount;
    if (delta > 0) {
      after.textContent = `post-settle reputation · ${result.reputation.normalized?.toFixed?.(2) ?? "—"} avg · +${delta} feedback (after settle)`;
    } else {
      after.textContent = `post-settle reputation · ${result.reputation.normalized?.toFixed?.(2) ?? "—"} avg · no delta`;
    }
  });
}

export function getBeforeRepCount(agentId) {
  return _beforeRepCounts.get(String(agentId)) ?? null;
}
