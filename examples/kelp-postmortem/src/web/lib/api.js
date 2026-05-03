import { GALILEO_SCAN_BASE } from "./links.js";
import { $, setStatus, shorten, state } from "./state.js";

const SSE_RECONNECT_MS = 2_000;
export const CONFIG_REFRESH_DELAY_MS = 1_500;

export async function refreshConfig() {
  try {
    const res = await fetch("/api/config");
    state.configCache = await res.json();
    renderConfig(state.configCache);
    // The coordinator spawns 7 children for a healthy session:
    //   3 AXL bridges (client + 2 providers) +
    //   4 agent processes (client + 2 providers + evaluator).
    // Re-enable the [Run job] button only once they're all live.
    const EXPECTED_CHILD_COUNT = 7;
    const childCount = Array.isArray(state.configCache.children)
      ? state.configCache.children.length
      : 0;
    if (childCount >= EXPECTED_CHILD_COUNT) {
      const startBtn = $("#btn-start");
      const runBtn = $("#btn-run");
      if (startBtn) startBtn.disabled = true;
      if (runBtn) runBtn.disabled = false;
    }
    return state.configCache;
  } catch (err) {
    console.warn("config refresh failed", err);
    return null;
  }
}

function renderConfig(cfg) {
  const deploymentList = $("#deployment-list");
  const agentRoster = $("#agent-roster");

  if (deploymentList) {
    deploymentList.innerHTML = "";
    const galileo = cfg.deployment.galileo;
    const rows = [
      ["AgenticCommerce", galileo.agenticCommerce],
      ["ACLEvaluator", galileo.aclEvaluator],
      ["IdentityRegistry", galileo.identityRegistry],
      ["ReputationRegistry", galileo.reputationRegistry],
      ["testUSDC", galileo.testUSDC],
      ["ACLAgentNFT", galileo.aclAgentNFT],
      ["TrustedPartyVerifier", galileo.trustedPartyVerifier],
      ["ReputationHook", galileo.reputationHook],
      ["INFTDeliveryHook", galileo.inftDeliveryHook],
    ];
    for (const [k, v] of rows) {
      if (!v) continue;
      const li = document.createElement("li");
      const href = `${GALILEO_SCAN_BASE}/address/${v}`;
      li.innerHTML = `<span>${k}</span><a target="_blank" rel="noopener" href="${href}" title="${v}">${shorten(v)}</a>`;
      deploymentList.appendChild(li);
    }
  }

  if (agentRoster) {
    agentRoster.innerHTML = "";
    const roster = [
      ["Client", "agent-client"],
      ["Provider · security", cfg.providers.security],
      ["Provider · generalist", cfg.providers.generalist],
      ["Evaluator", "agent-evaluator"],
    ];
    for (const [label, value] of roster) {
      const li = document.createElement("li");
      if (typeof value === "string" && value.endsWith(".eth")) {
        li.innerHTML = `<span>${label}</span><a target="_blank" rel="noopener" href="https://app.ens.domains/${value}">${value}</a>`;
      } else {
        li.innerHTML = `<span>${label}</span><span>${value}</span>`;
      }
      agentRoster.appendChild(li);
    }
  }

  // Provider tile ENS lines
  const securityEns = $("#security-ens");
  const generalistEns = $("#generalist-ens");
  if (securityEns) securityEns.textContent = cfg.providers.security;
  if (generalistEns) generalistEns.textContent = cfg.providers.generalist;
}

export async function fetchReputation(agentId) {
  try {
    const res = await fetch(`/api/reputation/${agentId}`);
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

export async function fetchInftOwner(contract, tokenId) {
  try {
    const res = await fetch(`/api/inft/owner/${contract}/${tokenId}`);
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

export async function fetchAttestation(rootHash) {
  try {
    const res = await fetch(`/api/storage/attestation/${rootHash}`);
    const json = await res.json();
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? `HTTP ${res.status}` };
    }
    return json;
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

export function connectSse(onMessage) {
  const es = new EventSource("/events");
  es.onmessage = (msg) => {
    try {
      onMessage(JSON.parse(msg.data));
    } catch (e) {
      console.warn("bad SSE payload", e);
    }
  };
  es.onerror = () => {
    setStatus("reconnecting…", "busy");
    es.close();
    setTimeout(() => connectSse(onMessage), SSE_RECONNECT_MS);
  };
}
