/**
 * Top-level event router.
 *
 * Receives every coordinator SSE message, projects it into:
 *
 *   - the stage (tiles, AXL edges, packet animations, evaluator
 *     morph, iNFT card flight) via `lib/diagram.js`
 *   - the chain row (step state, jobId swap)
 *   - the 8 evidence-rail sections (panel modules)
 *   - the timeline footer (`panels/timeline.js`)
 *
 * No new event types are added at this layer; we only consume what
 * the SDK + example app already emit (see
 * `sdk/packages/agent/src/events/types.ts` plus `phase2*` from the
 * example).
 */

import { CONFIG_REFRESH_DELAY_MS, connectSse, refreshConfig } from "./lib/api.js";
import {
  KIND_TO_STEP,
  bindLayout,
  chainStepReset,
  chainStepState,
  fireHelloToBoth,
  ghostEdge,
  morphEvaluatorIntoSelf,
  pinEvaluatorDelegate,
  pulseRole,
  setChainStepTx,
  setEdgeState,
  setJobId,
  setPin,
  setPinIdle,
  setTileState,
  spawnPacket,
  updateEdges,
} from "./lib/diagram.js";
import { GALILEO_SCAN_BASE } from "./lib/links.js";
import {
  $,
  TILE_IDS,
  edgeKeyForProviderRole,
  setStatus,
  setTileStateText,
  shorten,
  state,
} from "./lib/state.js";

import { renderDeliverableFromRoot, resetDeliverable } from "./panels/deliverable.js";
import {
  getBeforeRepCount,
  renderDiscoveryCandidates,
  renderDiscoveryStart,
  renderPostSettleReputation,
  renderRank,
  resetPostSettleRep,
} from "./panels/discovery.js";
import { recordEscrowTx, renderEscrowSkeleton, resetEscrow } from "./panels/escrow.js";
import {
  appendPhase2EvaluationMorph,
  renderAttestationBundle,
  renderEvaluationFromEvent,
  setEvaluationBusy,
} from "./panels/evaluation.js";
import {
  markHookFired,
  markHookSkipped,
  rememberSettleTx,
  renderHooksPanel,
} from "./panels/hooks.js";
import {
  appendAttemptFailedRow,
  appendAttemptRow,
  appendCounterDecision,
  appendNegotiationMsg,
} from "./panels/negotiation.js";
import {
  didInftTransfer,
  markPhase2Disabled,
  markPhase2Ready,
  renderPhase2,
  showAcquireBeat,
} from "./panels/phase2.js";
import { renderTaskSpec, renderTaskSpecDrafting } from "./panels/taskspec.js";
import { eventToTimelineRow, isTimelineNoise } from "./panels/timeline.js";

const startBtn = $("#btn-start");
const runBtn = $("#btn-run");
const timelineEl = $("#timeline");

const _INFT_POINTER_CT = "application/vnd.acl.inft-pointer";

function _isInftPointer(contentType) {
  return typeof contentType === "string" && contentType === _INFT_POINTER_CT;
}

function _scanAddress(addr) {
  return `${GALILEO_SCAN_BASE}/address/${addr}`;
}

/**
 * The SDK exposes the picked counterpart as ENS in
 * `negotiation.attempt`, but `negotiation.send/receive` use the
 * peer address (already shortened in the diagram). For client-side
 * AXL events we resolve the active edge from `state.chosenProviderRole`.
 */
function _edgeForCurrentNegotiation(payload) {
  const source = payload.source;
  if (source === "provider-security") return "client-security";
  if (source === "provider-generalist") return "client-generalist";
  if (source === "client" || source === "client-stdout") {
    return edgeKeyForProviderRole(state.chosenProviderRole);
  }
  return null;
}

function applyEvent(rawPayload) {
  let evt = rawPayload.event;
  if (!evt) return;
  let payload = rawPayload;
  // Generic `app.event` carrier from the SDK. The Phase-2 buyer-flow
  // emits its three outcomes (`phase2.completed/skipped/failed`)
  // through this carrier; reshape into the legacy `phase2` envelope
  // so the existing UI handlers (renderPhase2, timeline, hooks) keep
  // matching unchanged.
  if (
    evt.type === "app.event" &&
    typeof evt.name === "string" &&
    evt.name.startsWith("phase2.")
  ) {
    const inner = { type: evt.name, at: evt.at, ...(evt.payload ?? {}) };
    payload = { ...rawPayload, event: { type: "phase2", event: inner } };
    evt = payload.event;
  }
  const source = payload.source ?? evt.agentRole ?? "coordinator";

  switch (evt.type) {
    case "agent.boot": {
      const tileId = TILE_IDS[source] ?? TILE_IDS[evt.agentRole];
      if (tileId) setTileState(tileId, "is-online", true);
      _onAgentBoot(source, evt);
      break;
    }

    case "log": {
      // Most logs are noise; ignore here. The timeline panel will
      // surface warn/error.
      break;
    }

    case "llm.thinking": {
      const tileId = TILE_IDS[source] ?? TILE_IDS[evt.agentRole];
      if (tileId) setTileState(tileId, "is-active", true);
      if (source === "client") {
        if (evt.purpose === "author-taskspec") renderTaskSpecDrafting();
        if (evt.purpose === "phase2-decide") {
          showAcquireBeat("thinking · phase2-decide");
        }
      } else if (source === "evaluator") {
        if (!state.evaluatorModelId && evt.modelId) state.evaluatorModelId = evt.modelId;
        setEvaluationBusy();
        setTileStateText("evaluator", "evaluating in TEE");
      }
      break;
    }

    case "llm.decided": {
      const tileId = TILE_IDS[source] ?? TILE_IDS[evt.agentRole];
      if (tileId) setTileState(tileId, "is-active", false);
      if (source === "client" && evt.purpose === "rank-providers") {
        renderRank(evt.output);
        // After the LLM has both candidates in view, fire HELLO down
        // both edges and ghost the unpicked one.
        fireHelloToBoth();
        setTimeout(() => {
          const picked = edgeKeyForProviderRole(state.chosenProviderRole);
          const other = picked === "client-security" ? "client-generalist" : "client-security";
          if (picked) setEdgeState(picked, "active");
          if (other) ghostEdge(other);
          if (other) setPinIdle(other, "HELLO + idle");
        }, 1200);
      } else if (source === "client" && evt.purpose === "author-taskspec") {
        renderTaskSpec(evt.output);
      } else if (source === "client" && evt.purpose === "evaluate-counter") {
        appendCounterDecision(evt.output);
      } else if (source === "client" && evt.purpose === "phase2-decide") {
        const decision = evt.output?.decision ?? "?";
        const reason = evt.output?.reason ?? "";
        showAcquireBeat(`${decision} · ${reason}`);
        if (decision === "ACQUIRE") {
          // Reset the picked provider's tile so the new createJob
          // animates the SAME tile from active→done, not stuck-done.
          if (state.chosenProviderRole) {
            const tid = TILE_IDS[state.chosenProviderRole];
            setTileState(tid, "is-done", false);
            setTileStateText(state.chosenProviderRole, "ready · iNFT");
          }
          setTileState(TILE_IDS.client, "is-done", false);
          setTileState(TILE_IDS.evaluator, "is-done", false);
          // Keep the picked edge active; the SDK's re-run will spawn
          // its own PROPOSE / COUNTER / ACCEPT packets along it.
          const picked = edgeKeyForProviderRole(state.chosenProviderRole);
          if (picked) setEdgeState(picked, "active");
        }
      }
      break;
    }

    case "discovery.search": {
      setTileStateText("client", `searching · ${evt.query?.taskDomain ?? "any"}`);
      renderDiscoveryStart(evt.query);
      break;
    }

    case "discovery.candidates": {
      renderDiscoveryCandidates(evt);
      break;
    }

    case "negotiation.attempt": {
      appendAttemptRow(evt);
      break;
    }

    case "negotiation.failed": {
      appendAttemptFailedRow(evt);
      // If this attempt rejected on the picked edge, mark REJECT briefly.
      const edgeKey = edgeKeyForProviderRole(state.chosenProviderRole);
      if (edgeKey && !evt.willRetry) {
        setEdgeState(edgeKey, "ghosted");
        setPin(edgeKey, "REJECT");
      }
      break;
    }

    case "negotiation.send": {
      const role = source;
      const edgeKey = _edgeForCurrentNegotiation(payload);
      if (edgeKey) {
        if (evt.verb === "ACCEPT") {
          setEdgeState(edgeKey, "locked");
        } else {
          setEdgeState(edgeKey, "active");
        }
        spawnPacket(edgeKey, evt.verb, {
          direction: role === "client" ? "fwd" : "back",
        });
      }
      pulseRole(role);
      appendNegotiationMsg("send", role, evt);
      break;
    }

    case "negotiation.receive": {
      const role = source;
      const edgeKey = _edgeForCurrentNegotiation(payload);
      if (edgeKey) {
        if (evt.verb === "ACCEPT") {
          setEdgeState(edgeKey, "locked");
        } else if (evt.verb === "REJECT") {
          setEdgeState(edgeKey, "ghosted");
        } else {
          setEdgeState(edgeKey, "active");
        }
        spawnPacket(edgeKey, evt.verb, {
          direction: role === "client" ? "back" : "fwd",
        });
      }
      appendNegotiationMsg("recv", role, evt);
      // First ACCEPT received by the client carries the evaluator
      // address — pin the evaluator tile to delegate mode on receive
      // OR send.
      if (evt.verb === "ACCEPT") _pinEvaluatorOnAccept();
      break;
    }

    case "tx.sent": {
      const step = KIND_TO_STEP[evt.label];
      if (step) chainStepState(step, "active");
      pulseRole(source);
      break;
    }

    case "tx.confirmed": {
      const step = KIND_TO_STEP[evt.label];
      if (step) {
        chainStepState(step, "done");
        setChainStepTx(step, evt.txHash, shorten(evt.txHash));
        recordEscrowTx(step, evt.txHash);
      }
      break;
    }

    case "job.created": {
      chainStepState("createJob", "done");
      // jobId display + Phase tracking
      const phase = state.currentPhase === "phase2" ? "phase2" : "phase1";
      setJobId(evt.jobId, phase);
      state.currentJobId = evt.jobId;
      setChainStepTx("createJob", evt.txHash, shorten(evt.txHash));
      recordEscrowTx("createJob", evt.txHash);
      _pinEvaluatorOnAccept();
      break;
    }

    case "job.funded":
      chainStepState("fund", "done");
      setChainStepTx("fund", evt.txHash, shorten(evt.txHash));
      recordEscrowTx("fund", evt.txHash);
      if (state.chosenProviderRole) {
        setTileState(TILE_IDS[state.chosenProviderRole], "is-active", true);
        setTileStateText(state.chosenProviderRole, "drafting");
      }
      break;

    case "job.submitted":
      chainStepState("submit", "done");
      setChainStepTx("submit", evt.txHash, shorten(evt.txHash));
      recordEscrowTx("submit", evt.txHash);
      if (state.chosenProviderRole) {
        setTileState(TILE_IDS[state.chosenProviderRole], "is-active", false);
        setTileState(TILE_IDS[state.chosenProviderRole], "is-done", true);
        setTileStateText(state.chosenProviderRole, "delivered");
      }
      // Evaluator only animates picking up work when JobSubmitted fires.
      setTileState(TILE_IDS.evaluator, "is-active", true);
      setTileStateText("evaluator", "downloading deliverable");
      if (evt.deliverableRoot && !_isInftPointer(evt.contentType)) {
        renderDeliverableFromRoot(evt.deliverableRoot);
      }
      break;

    case "evaluator.evaluated":
      setTileStateText(
        "evaluator",
        `verdict ${evt.score?.toFixed?.(2) ?? evt.score} · ${evt.approved ? "approved" : "rejected"}`,
      );
      if (evt.modelId) state.evaluatorModelId = evt.modelId;
      renderEvaluationFromEvent(evt);
      break;

    case "job.settled":
      chainStepState("settle", "done");
      setChainStepTx("settle", evt.txHash, shorten(evt.txHash));
      recordEscrowTx("settle", evt.txHash);
      setTileState(TILE_IDS.evaluator, "is-active", false);
      setTileState(TILE_IDS.evaluator, "is-done", true);
      setTileState(TILE_IDS.client, "is-active", false);
      setTileState(TILE_IDS.client, "is-done", true);
      setTileStateText("client", evt.approved ? "settled" : "rejected");
      setTileStateText("evaluator", evt.approved ? "settled" : "rejected");
      setStatus(
        `settled · job ${evt.jobId} · approved=${evt.approved}`,
        evt.approved ? "ok" : "error",
      );
      rememberSettleTx(evt.txHash ?? null, evt.approved ?? null, state.currentPhase);
      renderHooksPanel();
      if (state.pickedAgentId) {
        setTimeout(() => {
          renderPostSettleReputation(state.pickedAgentId);
          _checkReputationHook(state.pickedAgentId);
        }, 1500);
      }
      break;

    case "job.settled.client-side":
      // selfComplete (Phase 2) settles via the client agent itself —
      // there's no settleViaEvaluator tx.sent event, so close the
      // chain row's settle step here.
      if (evt.selfComplete && evt.txHash) {
        chainStepState("settle", "done");
        setChainStepTx("settle", evt.txHash, shorten(evt.txHash));
        recordEscrowTx("settle", evt.txHash);
        rememberSettleTx(evt.txHash, evt.approved, "phase2");
        setTileState(TILE_IDS.client, "is-active", false);
        setTileState(TILE_IDS.client, "is-done", true);
        setTileState(TILE_IDS.evaluator, "is-active", false);
        setTileState(TILE_IDS.evaluator, "is-done", true);
        setTileStateText("client", evt.approved ? "settled · self" : "rejected · self");
        setTileStateText("evaluator", evt.approved ? "settled · self" : "rejected · self");
        setStatus(
          `phase 2 settled · job ${evt.jobId} · approved=${evt.approved}`,
          evt.approved ? "ok" : "error",
        );
      }
      if (evt.attestationRoot && !evt.selfComplete) {
        state.attestationRoot = evt.attestationRoot;
        renderAttestationBundle(evt.attestationRoot);
      }
      // Phase 2's deliverable is always an iNFT pointer commitment
      // (32-byte tuple — not stored in 0G). selfComplete is the
      // canonical Phase 2 marker; skip the deliverable fetch.
      if (evt.deliverableRoot && !evt.selfComplete && !_isInftPointer(evt.contentType)) {
        renderDeliverableFromRoot(evt.deliverableRoot);
      }
      break;

    case "job.delivered.provider-side":
      if (evt.deliverableRoot && !_isInftPointer(evt.contentType)) {
        renderDeliverableFromRoot(evt.deliverableRoot);
      }
      break;

    case "phase2-ready":
      markPhase2Ready();
      // From this point on, treat the next createJob as Phase-2.
      // We flip currentPhase only when the buyer-flow actually decides
      // ACQUIRE (see llm.decided phase2-decide).
      break;

    case "phase2-disabled":
      markPhase2Disabled(evt.reason);
      break;

    case "phase2": {
      const e = payload.event?.event ?? payload.event ?? {};
      // When phase2.completed lands AND iNFT actually transferred, fire
      // INFTDeliveryHook hook row + iNFT card flight.
      renderPhase2(payload);
      if (didInftTransfer(payload)) {
        const txHash =
          payload.event?.event?.result?.transferTxHash ??
          payload.event?.event?.result?.updateTxHash ??
          null;
        markHookFired("inft", { label: "iTransfer settled", txHash });
      } else if (e.type === "phase2.skipped") {
        markHookSkipped("inft", "skipped (no qualifying iNFT)");
      } else if (e.type === "phase2.failed") {
        markHookSkipped("inft", "failed");
      }
      break;
    }

    case "agent.error":
      setStatus(`agent error · ${evt.message?.slice(0, 60) ?? ""}`, "error");
      break;
  }

  // Phase-2 createJob detection: when ACQUIRE has fired and a new
  // job.created event arrives, swap the chain row jobId and phase.
}

/**
 * Phase-2 entry detector. Called when the picked provider sends or
 * receives an ACCEPT — at this point Job.evaluator carries either the
 * delegate (Phase 1) or the client itself (Phase 2). We run this on
 * every ACCEPT and `job.created`; the morph-into-self path triggers
 * automatically when state.currentPhase === 'phase2'.
 */
function _pinEvaluatorOnAccept() {
  if (state.currentPhase === "phase2") {
    morphEvaluatorIntoSelf({
      clientAddress: state.clientAddress,
      scanUrlForAddress: _scanAddress,
      scanUrlForJobEvaluator: () => {
        const cm = state.configCache?.deployment?.galileo?.agenticCommerce;
        return cm ? `${GALILEO_SCAN_BASE}/address/${cm}` : "#";
      },
    });
    return;
  }
  // Phase 1 — pin to ACLEvaluator delegate
  const aclEvaluator = state.configCache?.deployment?.galileo?.aclEvaluator;
  if (!aclEvaluator) return;
  pinEvaluatorDelegate({
    address: aclEvaluator,
    modelId: state.evaluatorModelId ?? "Qwen-2.5-7b-instruct",
    computeProvider: state.attestationBundle?.computeProvider,
    teeSignerAddress: state.attestationBundle?.teeSignerAddress,
    setOperatorTxHash: null,
    setOperatorScanUrl: `${GALILEO_SCAN_BASE}/address/${aclEvaluator}`,
    scanUrlForAddress: _scanAddress,
  });
}

function _onAgentBoot(source, evt) {
  if (source === "client" || evt.agentRole === "client") {
    state.clientAddress = evt.address;
    const addrEl = $("#client-addr");
    if (addrEl) {
      addrEl.textContent = shorten(evt.address);
      addrEl.href = _scanAddress(evt.address);
      addrEl.title = evt.address;
    }
    const ensEl = $("#client-ens");
    if (ensEl && evt.ensName) ensEl.textContent = evt.ensName;
    setTileStateText("client", "ready");
  } else if (source === "evaluator" || evt.agentRole === "evaluator") {
    state.evaluatorAddress = evt.address;
    const addrEl = $("#evaluator-addr");
    if (addrEl) {
      addrEl.textContent = shorten(evt.address);
      addrEl.href = _scanAddress(evt.address);
      addrEl.title = evt.address;
    }
    setTileStateText("evaluator", "tbd · negotiating");
  } else if (source === "provider-security") {
    setTileStateText("provider-security", "ready");
    const addrEl = $("#security-addr");
    if (addrEl) {
      addrEl.textContent = shorten(evt.address);
      addrEl.href = _scanAddress(evt.address);
      addrEl.title = evt.address;
    }
    if (evt.ensName) {
      const ensEl = $("#security-ens");
      if (ensEl) ensEl.textContent = evt.ensName;
    }
  } else if (source === "provider-generalist") {
    setTileStateText("provider-generalist", "ready");
    const addrEl = $("#generalist-addr");
    if (addrEl) {
      addrEl.textContent = shorten(evt.address);
      addrEl.href = _scanAddress(evt.address);
      addrEl.title = evt.address;
    }
    if (evt.ensName) {
      const ensEl = $("#generalist-ens");
      if (ensEl) ensEl.textContent = evt.ensName;
    }
  }
  updateEdges();
}

async function _checkReputationHook(agentId) {
  try {
    const res = await fetch(`/api/reputation/${agentId}`);
    const body = await res.json();
    if (!body?.ok || !body.reputation) return;
    const afterCount = Number(body.reputation.count);
    const beforeCount = getBeforeRepCount(agentId) ?? 0;
    const delta = afterCount - beforeCount;
    if (delta > 0) {
      markHookFired("reputation", { label: `+${delta} feedback` });
    } else {
      markHookSkipped("reputation", "no feedback delta");
    }
  } catch {
    // best effort
  }
}

function appendEvent(payload) {
  // Detect Phase-2 lifecycle entry: the buyer-flow LLM `phase2-decide`
  // ACQUIRE decision precedes the next job.created. Flip currentPhase
  // here so the next createJob is correctly tagged as Phase-2.
  const evt = payload?.event;
  if (
    evt?.type === "llm.decided" &&
    evt?.purpose === "phase2-decide" &&
    evt?.output?.decision === "ACQUIRE"
  ) {
    state.currentPhase = "phase2";
    // Reset chain row + escrow rows so Phase-2's lifecycle lands in the
    // same single chain row (per the locked `chain_one_row_jobid_swap`
    // design). Evaluation is NOT reset — Phase 1's TEE attestation
    // evidence is preserved and a Phase 2 "morph strip" is appended in
    // place, signalling that ACLEvaluator was bypassed and the buyer
    // self-completes (per `elig_p2_morph_strip` + `compute_eval_inline_
    // attestation_in_evidence_rail`).
    chainStepReset();
    resetEscrow();
    appendPhase2EvaluationMorph(state.clientAddress ?? null);
  }

  applyEvent(payload);
  if (isTimelineNoise(payload)) return;
  const row = eventToTimelineRow(payload);
  if (row && timelineEl) {
    timelineEl.appendChild(row);
    while (timelineEl.children.length > 220) timelineEl.removeChild(timelineEl.firstChild);
    timelineEl.scrollTop = timelineEl.scrollHeight;
  }
}

// ───────── Buttons ─────────

startBtn?.addEventListener("click", async () => {
  startBtn.disabled = true;
  setStatus("starting agents…", "busy");
  try {
    const res = await fetch("/api/start", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus("agents booting", "busy");
    runBtn.disabled = false;
    setTimeout(refreshConfig, CONFIG_REFRESH_DELAY_MS);
  } catch (err) {
    setStatus(`start failed: ${err.message}`, "error");
    startBtn.disabled = false;
  }
});

runBtn?.addEventListener("click", async () => {
  runBtn.disabled = true;
  setStatus("dispatching job…", "busy");
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brief:
          "Write a 600-word post-mortem of the April 2026 Kelp DAO bridge exploit. The deliverable must mention: 116,500 rsETH drained, $292 million stolen, more than 20 chains affected, the LayerZero cross-chain message bypass, and the protocols (Aave, SparkLend, Fluid, Lido, Ethena) that paused or froze in response.",
        maxBudget: "100000000",
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus("job dispatched", "busy");
  } catch (err) {
    setStatus(`run failed: ${err.message}`, "error");
  } finally {
    setTimeout(() => {
      runBtn.disabled = false;
    }, 2000);
  }
});

// ───────── Boot ─────────

(async () => {
  await refreshConfig();
  renderHooksPanel();
  renderEscrowSkeleton();
  resetPostSettleRep();
  bindLayout();
  updateEdges();
  connectSse(appendEvent);
})();
