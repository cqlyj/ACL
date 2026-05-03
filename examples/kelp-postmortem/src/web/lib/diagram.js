/**
 * Stage diagram engine.
 *
 * Owns: AXL edge geometry + packet/pin animations between client and
 * the two providers, chain-step + jobId state, evaluator-tile pinning
 * + morph-into-self, evidence-rail section pills, and the iNFT card
 * flight from provider to client on Phase-2 transfer.
 *
 * Geometry is recomputed from `getBoundingClientRect()` on boot,
 * resize, and immediately before each packet spawn — so the layout
 * stays correct when the page reflows (e.g. when an evidence section
 * opens).
 */

import { $, TILE_IDS, pulseTile, setTileState } from "./state.js";

/* ───────── chain-step state ───────── */

export const KIND_TO_STEP = {
  createJob: "createJob",
  setProvider: "setProvider",
  setBudget: "setBudget",
  fund: "fund",
  submit: "submit",
  settleViaEvaluator: "settle",
  settle: "settle",
};

export function chainStepState(stepKey, stepState) {
  const el = document.querySelector(`.chain-step[data-step="${stepKey}"]`);
  if (!el) return;
  el.dataset.state = stepState;
}

export function chainStepReset() {
  for (const el of document.querySelectorAll(".chain-step")) {
    delete el.dataset.state;
    const tx = el.querySelector(".chain-step-tx");
    if (tx) {
      tx.textContent = "";
      tx.classList.remove("is-set");
      tx.removeAttribute("data-tx-hash");
    }
  }
}

export function setChainStepTx(stepKey, txHash, label) {
  const el = document.querySelector(
    `.chain-step[data-step="${stepKey}"] .chain-step-tx`,
  );
  if (!el) return;
  el.textContent = label ?? "tx";
  el.classList.add("is-set");
  el.dataset.txHash = txHash;
}

/** Legacy hook used by older callers. Kept as a no-op so app.js can
    call it without breaking; the chain row no longer renders pills. */
export function setChainStepPill(_stepKey, _text, _state) {
  // Intentional no-op — the new design renders hook results inside
  // the evidence rail (section 8), not as floating pills on chain
  // steps.
}

/* ───────── jobId display + Phase-2 swap ───────── */

export function setJobId(jobId, phase) {
  const valueEl = $("#chain-jobid-value");
  const phaseEl = $("#chain-jobid-phase");
  if (!valueEl || !phaseEl) return;
  if (valueEl.textContent === String(jobId)) return;
  valueEl.classList.add("is-swapping");
  setTimeout(() => {
    valueEl.textContent = String(jobId);
    if (phase === "phase2") {
      phaseEl.textContent = "phase 2";
    } else {
      phaseEl.textContent = "phase 1";
    }
    setTimeout(() => valueEl.classList.remove("is-swapping"), 220);
  }, 160);
}

/* ───────── AXL edge geometry ───────── */

const EDGES = ["client-security", "client-generalist"];

const PIN_OFFSET = 0.62; // pin sits 62% along the edge (closer to provider)

function _stageRect() {
  const stage = $("#stage-grid") ?? $(".stage-grid");
  return stage?.getBoundingClientRect() ?? null;
}

function _tileCenter(id, side) {
  const el = document.getElementById(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (side === "right") return { x: r.right, y: r.top + r.height / 2 };
  if (side === "left") return { x: r.left, y: r.top + r.height / 2 };
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function _edgeEndpoints(edgeKey, stageRect) {
  if (!stageRect) return null;
  const client = _tileCenter("tile-client", "right");
  const target =
    edgeKey === "client-security"
      ? _tileCenter("tile-provider-security", "left")
      : _tileCenter("tile-provider-generalist", "left");
  if (!client || !target) return null;
  return {
    x1: client.x - stageRect.left,
    y1: client.y - stageRect.top,
    x2: target.x - stageRect.left,
    y2: target.y - stageRect.top,
  };
}

let _layoutBound = false;

export function bindLayout() {
  if (_layoutBound) return;
  _layoutBound = true;
  window.addEventListener("resize", () => updateEdges());
  // After font loads, geometry shifts; re-measure once.
  setTimeout(() => updateEdges(), 200);
  setTimeout(() => updateEdges(), 600);
}

export function updateEdges() {
  const stage = $(".stage-grid");
  if (!stage) return;
  const stageRect = stage.getBoundingClientRect();
  // Size the SVG to the stage.
  const svg = $("#axl-edges");
  if (svg) {
    svg.setAttribute("width", String(stageRect.width));
    svg.setAttribute("height", String(stageRect.height));
    svg.setAttribute("viewBox", `0 0 ${stageRect.width} ${stageRect.height}`);
  }
  for (const edge of EDGES) {
    const ep = _edgeEndpoints(edge, stageRect);
    if (!ep) continue;
    const line = document.querySelector(`.axl-line[data-edge="${edge}"]`);
    if (line) {
      line.setAttribute("x1", ep.x1);
      line.setAttribute("y1", ep.y1);
      line.setAttribute("x2", ep.x2);
      line.setAttribute("y2", ep.y2);
    }
    const anchor = document.getElementById(`anchor-${edge}`);
    if (anchor) {
      // Place the anchor at the edge midpoint (the pin uses this as origin)
      anchor.style.left = `${ep.x1 + (ep.x2 - ep.x1) * PIN_OFFSET}px`;
      anchor.style.top = `${ep.y1 + (ep.y2 - ep.y1) * PIN_OFFSET}px`;
    }
  }
}

/* ───────── edge state ───────── */

export function setEdgeState(edgeKey, edgeState) {
  const line = document.querySelector(`.axl-line[data-edge="${edgeKey}"]`);
  if (line) line.dataset.state = edgeState;
}

/** Convenience: reveal all edges as hairlines (used at HELLO time). */
export function revealEdges() {
  for (const edge of EDGES) setEdgeState(edge, "hairline");
}

/** Mark the unpicked edge as a ghosted hairline. */
export function ghostEdge(edgeKey) {
  setEdgeState(edgeKey, "ghosted");
}

/* ───────── packet animations ───────── */

const PACKET_DURATION_MS = 1100;

export function spawnPacket(edgeKey, verb, opts = {}) {
  updateEdges();
  const stage = $(".stage-grid");
  if (!stage) return;
  const stageRect = stage.getBoundingClientRect();
  const ep = _edgeEndpoints(edgeKey, stageRect);
  if (!ep) return;
  const overlay = $("#axl-overlay");
  if (!overlay) return;

  const reverse = opts.direction === "back";
  const sx = reverse ? ep.x2 : ep.x1;
  const sy = reverse ? ep.y2 : ep.y1;
  const tx = reverse ? ep.x1 : ep.x2;
  const ty = reverse ? ep.y1 : ep.y2;

  const packet = document.createElement("div");
  packet.className = "axl-packet";
  packet.dataset.verb = verb;
  packet.style.left = `${sx}px`;
  packet.style.top = `${sy}px`;
  packet.style.setProperty("--dx", `${tx - sx}px`);
  packet.style.setProperty("--dy", `${ty - sy}px`);
  packet.textContent = opts.label ?? verb;
  overlay.appendChild(packet);

  // After the glide completes, replace the pin's text with this verb
  // so the most recent verb persists at the destination end.
  setTimeout(() => {
    packet.remove();
    setPin(edgeKey, verb, opts.label);
  }, PACKET_DURATION_MS);
}

export function setPin(edgeKey, verb, label) {
  const pin = document.querySelector(`.axl-pin[data-edge="${edgeKey}"]`);
  if (!pin) return;
  pin.textContent = label ?? verb;
  pin.dataset.active = "true";
  pin.dataset.state = String(verb).toLowerCase();
}

export function setPinIdle(edgeKey, label) {
  const pin = document.querySelector(`.axl-pin[data-edge="${edgeKey}"]`);
  if (!pin) return;
  pin.textContent = label ?? "idle";
  pin.dataset.active = "true";
  pin.dataset.state = "idle";
}

export function clearPin(edgeKey) {
  const pin = document.querySelector(`.axl-pin[data-edge="${edgeKey}"]`);
  if (!pin) return;
  pin.removeAttribute("data-active");
  delete pin.dataset.state;
  pin.textContent = "";
}

/* ───────── HELLO to both ───────── */

export function fireHelloToBoth() {
  revealEdges();
  for (const edge of EDGES) {
    spawnPacket(edge, "HELLO");
  }
}

/* ───────── tile pulse ───────── */

export function pulseRole(role) {
  const id = TILE_IDS[role];
  if (id) pulseTile(id);
}

/* ───────── evaluator pin / morph ───────── */

export function pinEvaluatorDelegate({
  address,
  modelId,
  computeProvider,
  teeSignerAddress,
  setOperatorTxHash,
  setOperatorScanUrl,
  scanUrlForAddress,
}) {
  const tile = $("#tile-evaluator");
  if (!tile) return;
  tile.dataset.mode = "delegate";
  const stateEl = $("#evaluator-state");
  if (stateEl) stateEl.textContent = "delegate";
  const modeEl = $("#evaluator-mode");
  if (modeEl) modeEl.textContent = "delegate · ACLEvaluator";
  const addrEl = $("#evaluator-addr");
  if (addrEl && address) {
    addrEl.textContent = _shortFmt(address);
    if (scanUrlForAddress) {
      addrEl.href = scanUrlForAddress(address);
      addrEl.title = address;
    }
  }
  _renderEvalComputeChip({
    modelId,
    computeProvider,
    teeSignerAddress,
  });
  _renderEvalDelegateVerify({
    setOperatorTxHash,
    setOperatorScanUrl,
  });
}

export function morphEvaluatorIntoSelf({
  clientAddress,
  scanUrlForAddress,
  scanUrlForJobEvaluator,
}) {
  const tile = $("#tile-evaluator");
  if (!tile) return;
  tile.dataset.mode = "self";
  const stateEl = $("#evaluator-state");
  if (stateEl) stateEl.textContent = "self · client = evaluator";
  const modeEl = $("#evaluator-mode");
  if (modeEl) modeEl.textContent = "self-evaluator";
  const addrEl = $("#evaluator-addr");
  if (addrEl && clientAddress) {
    addrEl.textContent = _shortFmt(clientAddress);
    if (scanUrlForAddress) {
      addrEl.href = scanUrlForAddress(clientAddress);
      addrEl.title = clientAddress;
    }
  }
  // The previous build painted a floating "same agent" badge on the
  // evaluator tile's left edge. Visually that line landed against the
  // provider-generalist tile (its desktop left neighbour), implying
  // a provider↔evaluator relationship. The semantic is the opposite:
  // in Phase-2 self-mode the *client* doubles as the evaluator. We now
  // mirror the relationship as in-tile chips on both the client and the
  // evaluator, sharing a `data-pair="self-evaluator"` marker so they
  // render with the same accent style.
  _renderSelfEvaluatorChips({ clientAddress });
  // Verify strip: Job.evaluator == client.address ✓
  const verify = $("#evaluator-verify");
  if (verify) {
    verify.hidden = false;
    verify.innerHTML = "";
    verify.appendChild(
      buildVerifyLine({
        claim: "Job.evaluator == client.address",
        proofLabel: "rule",
        proofTitle:
          "AgenticCommerce.complete enforces msg.sender == job.evaluator",
        onClick: () => {
          if (scanUrlForJobEvaluator)
            window.open(scanUrlForJobEvaluator(), "_blank");
        },
        state: "ok",
      }),
    );
  }
}

/**
 * Mirrors the "client = evaluator" relationship as paired chips inside
 * both the client tile and the evaluator tile. Clicking either chip
 * scrolls the partner tile into view and briefly pulses it. Replaces
 * the old left-edge "same agent" badge whose absolute position made
 * it look like a connector to the (unrelated) provider tile next door.
 */
function _renderSelfEvaluatorChips({ clientAddress }) {
  const tooltip = clientAddress
    ? `Phase 2 self-mode: client (${clientAddress}) is the on-chain Job.evaluator. AgenticCommerce.complete enforces msg.sender == job.evaluator.`
    : "Phase 2 self-mode: client doubles as Job.evaluator.";
  _ensureSelfEvaluatorChip({
    wrap: $("#evaluator-chips"),
    label: "↔ same EOA · client",
    tooltip,
    partnerTileId: "tile-client",
  });
  _ensureSelfEvaluatorChip({
    wrap: $("#client-chips"),
    label: "↔ same EOA · evaluator",
    tooltip,
    partnerTileId: "tile-evaluator",
  });
}

function _ensureSelfEvaluatorChip({ wrap, label, tooltip, partnerTileId }) {
  if (!wrap) return;
  let chip = wrap.querySelector(".self-evaluator-chip");
  if (!chip) {
    chip = document.createElement("button");
    chip.type = "button";
    chip.className = "self-evaluator-chip";
    chip.dataset.pair = "self-evaluator";
    chip.addEventListener("click", () => {
      const partner = document.getElementById(partnerTileId);
      if (!partner) return;
      partner.scrollIntoView({ behavior: "smooth", block: "nearest" });
      pulseTile(partnerTileId);
    });
    wrap.appendChild(chip);
  }
  chip.textContent = label;
  chip.title = tooltip;
}

function _renderEvalComputeChip({
  modelId,
  computeProvider,
  teeSignerAddress,
}) {
  const wrap = $("#evaluator-chips");
  if (!wrap) return;
  let chip = wrap.querySelector(".eval-compute-chip");
  if (!chip) {
    chip = document.createElement("span");
    chip.className = "eval-compute-chip";
    wrap.appendChild(chip);
  }
  const modelLabel = (modelId ?? "Qwen-2.5-7b-instruct").replace(
    /^([^/]+\/)?/,
    "",
  );
  const cpShort = computeProvider ? _shortFmt(computeProvider) : "0xPrv…";
  chip.innerHTML = "";
  const txt = document.createElement("span");
  txt.textContent = `0G Compute · ${modelLabel} · ${cpShort}`;
  chip.appendChild(txt);
  chip.dataset.tee = teeSignerAddress ? "ok" : "pending";
  const tip = document.createElement("span");
  tip.className = "eval-compute-tip";
  tip.textContent = teeSignerAddress
    ? `teeSignerAddress ${teeSignerAddress} · TEE signer acknowledged ✓`
    : "TEE signer not yet acknowledged";
  chip.appendChild(tip);
}

export function setEvaluatorEvaluating(isOn) {
  const wrap = $("#evaluator-chips");
  const chip = wrap?.querySelector(".eval-compute-chip");
  if (!chip) return;
  if (isOn) {
    chip.dataset.state = "evaluating";
    const stateEl = $("#evaluator-state");
    if (stateEl) stateEl.textContent = "evaluating in TEE";
  } else {
    delete chip.dataset.state;
  }
}

function _renderEvalDelegateVerify({ setOperatorTxHash, setOperatorScanUrl }) {
  const verify = $("#evaluator-verify");
  if (!verify) return;
  verify.hidden = false;
  verify.innerHTML = "";
  verify.appendChild(
    buildVerifyLine({
      claim: "authorizedOperators[op] = true",
      proofLabel: setOperatorTxHash ? "view tx" : "checked just now",
      proofTitle: setOperatorTxHash
        ? `setOperator tx ${setOperatorTxHash}`
        : "ACLEvaluator.authorizedOperators(0G Compute provider)",
      onClick: () => {
        if (setOperatorScanUrl) window.open(setOperatorScanUrl, "_blank");
      },
      state: "ok",
    }),
  );
}

/* ───────── verify-strip helper ───────── */

export function buildVerifyLine({
  claim,
  proofLabel,
  proofTitle,
  onClick,
  state = "ok",
}) {
  const row = document.createElement("div");
  row.className = "verify-line";
  row.dataset.state = state;
  const mark = document.createElement("span");
  mark.className = "verify-mark";
  mark.innerHTML =
    state === "fail"
      ? "<svg viewBox='0 0 12 12' width='12' height='12'><path d='M3 3l6 6M9 3l-6 6' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round'/></svg>"
      : "<svg viewBox='0 0 12 12' width='12' height='12'><path d='M2.5 6.5l2.5 2.5L9.5 3.5' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>";
  row.appendChild(mark);
  const claimEl = document.createElement("span");
  claimEl.className = "verify-claim";
  claimEl.textContent = claim;
  row.appendChild(claimEl);
  if (proofLabel) {
    const proof = document.createElement("span");
    proof.className = "verify-proof";
    proof.textContent = proofLabel;
    if (proofTitle) proof.title = proofTitle;
    if (onClick) proof.addEventListener("click", onClick);
    row.appendChild(proof);
  }
  return row;
}

/* ───────── tradability pulse ───────── */

export function setTradablePulse(role, info) {
  const wrap = document.getElementById(_chipsIdFor(role));
  if (!wrap) return;
  let pulse = wrap.querySelector(".tradable-pulse");
  if (info && !pulse) {
    pulse = document.createElement("span");
    pulse.className = "tradable-pulse";
    const txt = document.createElement("span");
    txt.textContent = "tradable · iNFT";
    pulse.appendChild(txt);
    wrap.appendChild(pulse);
  }
  if (!info && pulse) pulse.remove();
  if (info && pulse) {
    pulse.title = info.title ?? "";
  }
}

function _chipsIdFor(role) {
  if (role === "provider-security") return "security-chips";
  if (role === "provider-generalist") return "generalist-chips";
  return "";
}

/* ───────── iNFT card flight ───────── */

export function flyInftCard({ tokenId, fromRole }) {
  updateEdges();
  const stage = $(".stage-grid");
  const layer = $("#inft-flight-layer");
  if (!stage || !layer) return;
  const stageRect = stage.getBoundingClientRect();
  const fromTileId =
    fromRole === "provider-security"
      ? "tile-provider-security"
      : "tile-provider-generalist";
  const fromCenter = _tileCenter(fromTileId, "left");
  const toCenter = _tileCenter("tile-client", "right");
  if (!fromCenter || !toCenter) return;
  const sx = fromCenter.x - stageRect.left;
  const sy = fromCenter.y - stageRect.top;
  const tx = toCenter.x - stageRect.left;
  const ty = toCenter.y - stageRect.top;
  const card = document.createElement("div");
  card.className = "inft-card";
  card.style.left = `${sx}px`;
  card.style.top = `${sy}px`;
  card.style.setProperty("--dx", `${tx - sx}px`);
  card.style.setProperty("--dy", `${ty - sy}px`);
  card.innerHTML = `
    <span class="inft-card-label">iNFT</span>
    <span class="inft-card-token">tokenId ${tokenId ?? "?"}</span>
  `;
  layer.appendChild(card);
  setTimeout(() => card.remove(), 1200);
}

/* ───────── evidence-rail section state ───────── */

export function setEvidencePill(section, label, sectionState) {
  const sec = document.querySelector(
    `.evidence-section[data-section="${section}"]`,
  );
  if (!sec) return;
  const pill = sec.querySelector(".ev-pill");
  if (!pill) return;
  pill.textContent = label;
  if (sectionState) pill.dataset.state = sectionState;
  else delete pill.dataset.state;
}

/* ───────── small helpers re-exported for app.js ───────── */

export { setTileState, pulseTile };

function _shortFmt(addr) {
  if (typeof addr !== "string") return "";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
