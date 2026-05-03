#!/usr/bin/env bash
#
# Boot the kelp-postmortem demo end-to-end on a fresh shell with one
# command. Idempotent in spirit:
#
#   - if the CCIP-Read gateway isn't already on :3000, spawn it
#   - if the providers haven't been registered (.axl/*.token-id absent),
#     run `setup:providers` to mint iNFTs + publish ACL metadata
#   - if `.env` doesn't have a KELP_SOURCE_ROOT yet, run `setup:source`
#   - finally spawn the coordinator + wait until /api/config is up
#
# PIDs are tracked under ./.demo-pids/{gateway,coord}.pid for `demo-down`.
# Background output streams to /tmp/acl-{gateway,kelp-coord}.log.
#
# Usage:
#   bash examples/kelp-postmortem/scripts/demo-up.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEMO_DIR="$REPO_ROOT/examples/kelp-postmortem"
PID_DIR="$DEMO_DIR/.demo-pids"
mkdir -p "$PID_DIR"

GATEWAY_LOG=/tmp/acl-gateway.log
COORD_LOG=/tmp/kelp-coord.log
GATEWAY_HEALTH=http://127.0.0.1:3000/healthz
COORD_CONFIG=http://127.0.0.1:8787/api/config

step() { printf '\033[36m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Wait for an HTTP endpoint to start returning 2xx.
# wait_for <url> <max-tries> <step-seconds>
wait_for() {
  local url="$1" tries="$2" step="$3"
  for ((i = 1; i <= tries; i++)); do
    if curl -sf "$url" >/dev/null 2>&1; then return 0; fi
    sleep "$step"
  done
  return 1
}

# 1. Gateway -----------------------------------------------------------------

if curl -sf "$GATEWAY_HEALTH" >/dev/null 2>&1; then
  ok "gateway already up on :3000"
else
  step "starting CCIP-Read gateway in background → $GATEWAY_LOG"
  (
    cd "$REPO_ROOT/sdk"
    nohup bun run gateway:start >"$GATEWAY_LOG" 2>&1 &
    echo $! >"$PID_DIR/gateway.pid"
  )
  if wait_for "$GATEWAY_HEALTH" 20 3; then
    ok "gateway up on :3000 (pid $(cat "$PID_DIR/gateway.pid"))"
  else
    die "gateway did not come up within 60s — see $GATEWAY_LOG"
  fi
fi

# 2. Provider registration --------------------------------------------------

if [[ -f "$DEMO_DIR/.axl/kelp-security.token-id" && -f "$DEMO_DIR/.axl/kelp-generalist.token-id" ]]; then
  ok "providers already registered (kelp-security #$(cat "$DEMO_DIR/.axl/kelp-security.token-id"), kelp-generalist #$(cat "$DEMO_DIR/.axl/kelp-generalist.token-id"))"
else
  step "registering providers + minting seller iNFTs (~2–5 min on Galileo)"
  (cd "$DEMO_DIR" && bun run setup:providers)
  ok "providers registered"
fi

# 3. Source-corpus pin ------------------------------------------------------

if grep -qE '^KELP_SOURCE_ROOT=0x[0-9a-fA-F]{64}$' "$DEMO_DIR/.env" 2>/dev/null; then
  ok "0G Storage source root already pinned in .env"
else
  step "uploading Kelp post-mortem source to 0G Storage…"
  (cd "$DEMO_DIR" && bun run setup:source)
  ok "source root written into .env"
fi

# 4. Coordinator -----------------------------------------------------------

if [[ -f "$PID_DIR/coord.pid" ]] && kill -0 "$(cat "$PID_DIR/coord.pid")" 2>/dev/null; then
  warn "coord already running (pid $(cat "$PID_DIR/coord.pid")); skipping spawn"
else
  step "starting coordinator in background → $COORD_LOG"
  (
    cd "$DEMO_DIR"
    nohup bun run dev >"$COORD_LOG" 2>&1 &
    echo $! >"$PID_DIR/coord.pid"
  )
  if wait_for "$COORD_CONFIG" 20 2; then
    ok "coord up on :8787 (pid $(cat "$PID_DIR/coord.pid"))"
  else
    die "coord did not come up within 40s — see $COORD_LOG"
  fi
fi

cat <<EOF

────────────────────────────────────────────────────────────────────
✓ Demo ready.

  → Open http://localhost:8787 in your browser.

  → In the UI:
      1. Click [Start agents] — boots 3 AXL bridges + 4 agent procs
      2. Click [Run job]      — Phase 1 + Phase 2 fire end-to-end
                                (deliverable + iNFT iTransfer)

  Tail logs:    tail -f $COORD_LOG
                tail -f $GATEWAY_LOG

  Shut down:    make demo-down
────────────────────────────────────────────────────────────────────
EOF
