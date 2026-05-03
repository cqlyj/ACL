#!/usr/bin/env bash
#
# Shut down everything `demo-up` started:
#
#   - kelp-postmortem coordinator (cascades SIGTERM to all 7 child
#     processes — 3 AXL bridges + 4 agent processes)
#   - CCIP-Read gateway
#
# Recovers PIDs from .demo-pids/, then falls back to pgrep so a stale
# pid file doesn't leave a zombie.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEMO_DIR="$REPO_ROOT/examples/kelp-postmortem"
PID_DIR="$DEMO_DIR/.demo-pids"

step() { printf '\033[36m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }

# Kill `pid` and every descendant of it. Bun spawns `bun run gateway:start
# → bun run --filter @acl/gateway start → bun run src/cli.ts` in a chain
# and SIGTERM on the outermost pid does not always cascade to the leaf,
# so we walk the children explicitly first.
collect_descendants() {
  local pid="$1"
  local kids
  kids="$(pgrep -P "$pid" 2>/dev/null || true)"
  for k in $kids; do
    collect_descendants "$k"
    echo "$k"
  done
}

stop_pidfile() {
  local label="$1" path="$2"
  if [[ -f "$path" ]]; then
    local pid
    pid="$(cat "$path")"
    if kill -0 "$pid" 2>/dev/null; then
      step "stopping $label (pid $pid + descendants)"
      local descendants
      descendants="$(collect_descendants "$pid" | tr '\n' ' ' || true)"
      # shellcheck disable=SC2086
      kill -TERM $descendants "$pid" 2>/dev/null || true
      for ((i = 0; i < 30; i++)); do
        if ! kill -0 "$pid" 2>/dev/null; then break; fi
        sleep 0.5
      done
      if kill -0 "$pid" 2>/dev/null; then
        # shellcheck disable=SC2086
        kill -KILL $descendants "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$path"
  fi
}

stop_pidfile "coord"   "$PID_DIR/coord.pid"
stop_pidfile "gateway" "$PID_DIR/gateway.pid"

# Belt-and-suspenders sweep: anything pgrep can still find by command-
# line gets a SIGTERM. Quiet by design — clean shutdowns produce no
# matches here.
sweep() {
  local label="$1" pattern="$2"
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null | tr '\n' ' ' || true)"
  if [[ -n "${pids// /}" ]]; then
    step "sweep: stopping stray $label processes (${pids})"
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    sleep 1
    pids="$(pgrep -f "$pattern" 2>/dev/null | tr '\n' ' ' || true)"
    if [[ -n "${pids// /}" ]]; then
      # shellcheck disable=SC2086
      kill -KILL $pids 2>/dev/null || true
    fi
  fi
}

sweep "coord"     "examples/kelp-postmortem/src/server.ts"
sweep "gateway:1" "@acl/gateway"
sweep "gateway:2" "gateway:start"
sweep "gateway:3" "@acl/gateway/src/cli.ts"
sweep "axl"       "examples/kelp-postmortem/.axl/.*\\.config\\.json"

# Verify ports are free.
sleep 1
busy=()
for port in 3000 8787 9101 9102 9103; do
  if ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN; then
    busy+=("$port")
  fi
done
if ((${#busy[@]} > 0)); then
  echo "! ports still in use: ${busy[*]}"
else
  ok "ports 3000 / 8787 / 9101–9103 freed"
fi

ok "demo stopped"
