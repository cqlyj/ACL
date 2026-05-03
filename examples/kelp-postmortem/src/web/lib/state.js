/**
 * Shared mutable demo state + tiny DOM helpers.
 *
 * Kept deliberately small. The view layer (`app.js`, `panels/*`,
 * `diagram.js`) owns rendering; this module owns the values they
 * coordinate over.
 */

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => Array.from(document.querySelectorAll(sel));

export const state = {
  configCache: null,
  /** "provider-security" | "provider-generalist" | null */
  chosenProviderRole: null,
  chosenEnsName: null,
  pickedAgentId: null,
  /** Most recent discovery rollup (raw event payload). */
  lastCandidates: null,
  /** LLM rank output: ordered ENS names (best-first). */
  rankedEnsNames: [],
  /** "phase1" | "phase2" */
  currentPhase: "phase1",
  /** Latest (live) jobId. Replaced when Phase-2 createJob lands. */
  currentJobId: null,
  /** Latest attestation root from `job.settled.client-side`. */
  attestationRoot: null,
  /** Cached attestation bundle JSON (lazy-loaded). */
  attestationBundle: null,
  /** Evaluator address from boot event. */
  evaluatorAddress: null,
  /** Client address from boot event. */
  clientAddress: null,
  /** modelId reported by evaluator's first llm.thinking. */
  evaluatorModelId: null,
};

export function shorten(addr) {
  if (typeof addr !== "string") return "";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function shortenHash(hash, lead = 6, tail = 4) {
  if (typeof hash !== "string") return "";
  if (hash.length <= lead + tail + 1) return hash;
  return `${hash.slice(0, lead)}…${hash.slice(-tail)}`;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function setStatus(text, statusState) {
  const el = $("#status");
  if (!el) return;
  el.textContent = text;
  if (statusState) el.dataset.state = statusState;
  else delete el.dataset.state;
}

export function setTileState(tileId, klass, on) {
  const el = document.getElementById(tileId);
  if (!el) return;
  if (on) el.classList.add(klass);
  else el.classList.remove(klass);
}

export function setTileStateText(role, text) {
  const map = {
    client: "#client-state",
    "provider-security": "#security-state",
    "provider-generalist": "#generalist-state",
    evaluator: "#evaluator-state",
  };
  const sel = map[role];
  if (!sel) return;
  const el = $(sel);
  if (el) el.textContent = text;
}

export function pulseTile(tileId, durationMs = 1_400) {
  setTileState(tileId, "is-active", true);
  setTimeout(() => setTileState(tileId, "is-active", false), durationMs);
}

/** Centralised role → tile id mapping. */
export const TILE_IDS = {
  client: "tile-client",
  "provider-security": "tile-provider-security",
  "provider-generalist": "tile-provider-generalist",
  evaluator: "tile-evaluator",
  // SDK roles
  provider: null, // disambiguated via source string
};

export function tileForSource(source) {
  if (TILE_IDS[source]) return TILE_IDS[source];
  if (source === "client" || source === "client-stdout") return TILE_IDS.client;
  if (source === "evaluator") return TILE_IDS.evaluator;
  if (source === "provider-security") return TILE_IDS["provider-security"];
  if (source === "provider-generalist") return TILE_IDS["provider-generalist"];
  return null;
}

/** Provider role → AXL edge key. */
export function edgeKeyForProviderRole(role) {
  if (role === "provider-security") return "client-security";
  if (role === "provider-generalist") return "client-generalist";
  return null;
}
