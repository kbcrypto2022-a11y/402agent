#!/usr/bin/env bash
# Production startup wrapper for Agent402.
#
# Runs as the production `run` command (replaces the bare `node` invocation).
# Sequence:
#   1. Start the Agent402 node server in the background on $PORT
#   2. Poll the health endpoint until the server is ready (up to MAX_WAIT_SECONDS)
#   3. Run the x402 smoke test against the running server in an independent child
#      - Pass  → log the result and keep the server up
#      - Fail  → log the result and keep the server up; the child exits nonzero
#   4. Keep the wrapper alive while the server runs
#
# The smoke test target defaults to the locally running server (localhost:$PORT),
# which is the actual new server being deployed.  Set AGENT402_URL to the
# externally reachable URL (e.g. https://xxx.replit.app/agent402) if you want
# to verify the full proxy chain instead — but only do this after the first
# successful deploy so the URL exists.
#
# Required env (inherited from Replit deployment or userenv):
#   PORT                     — port the server should listen on (set in artifact.toml)
#   PAYER_PRIVATE_KEY        — Base Sepolia wallet used by the smoke test
#
# Optional env:
#   AGENT402_URL             — override smoke test target URL
#   SMOKE_ALERT_WEBHOOK_URL  — Slack/Discord webhook; smoke.ts posts here on failure
#   MAX_WAIT_SECONDS         — readiness poll timeout (default: 90)
#   SMOKE_POLL_INTERVAL      — seconds between health polls (default: 3)

set -uo pipefail

PORT="${PORT:-8090}"
AGENT402_URL="${AGENT402_URL:-http://localhost:${PORT}/agent402}"
MAX_WAIT="${MAX_WAIT_SECONDS:-90}"
POLL_INTERVAL="${SMOKE_POLL_INTERVAL:-3}"
SERVER_PID=""
SMOKE_PID=""

terminate_server() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
  fi
}

terminate_smoke_child() {
  if [[ -n "${SMOKE_PID}" ]] && kill -0 "${SMOKE_PID}" 2>/dev/null; then
    # Smoke runs in its own process group so its pnpm/tsx descendants cannot
    # outlive a server shutdown.
    kill -- "-${SMOKE_PID}" 2>/dev/null || kill "${SMOKE_PID}" 2>/dev/null || true
  fi
}

terminate_children() {
  terminate_server
  terminate_smoke_child
}

cleanup_on_exit() {
  trap - EXIT
  terminate_children
  if [[ -n "${SERVER_PID}" ]]; then
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  if [[ -n "${SMOKE_PID}" ]]; then
    wait "${SMOKE_PID}" 2>/dev/null || true
  fi
}

on_signal() {
  echo ""
  echo "=== [startup] Received shutdown signal; stopping server and smoke child ==="
  exit 143
}

# Signals sent to the deployment wrapper are forwarded to its children. A smoke
# child exiting on its own never reaches this handler and is never a reason to
# stop the server.
trap on_signal TERM INT HUP
trap cleanup_on_exit EXIT

# ── 1. Start the server ──────────────────────────────────────────────────────
echo "=== [startup] Starting Agent402 on port ${PORT} ==="
node --enable-source-maps artifacts/agent402/dist/index.mjs &
SERVER_PID=$!
echo "    pid: ${SERVER_PID}"

# ── 2. Wait for the health endpoint ─────────────────────────────────────────
echo ""
echo "=== [startup] Polling ${AGENT402_URL}/api/v1/health (timeout ${MAX_WAIT}s) ==="
ELAPSED=0
until curl -sf "${AGENT402_URL}/api/v1/health" > /dev/null 2>&1; do
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "ERROR: Server process exited unexpectedly before becoming ready."
    wait "${SERVER_PID}" 2>/dev/null || true
    exit 1
  fi
  if [ "${ELAPSED}" -ge "${MAX_WAIT}" ]; then
    echo "ERROR: Server did not become ready within ${MAX_WAIT}s."
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
    exit 1
  fi
  sleep "${POLL_INTERVAL}"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done
echo "    ready after ${ELAPSED}s"

# ── 3. Run the smoke test in an independent child ────────────────────────────
echo ""
echo "=== [startup] Starting smoke test child against ${AGENT402_URL} ==="
cd /home/runner/workspace

setsid bash -c '
  set +e
  AGENT402_URL="$1" pnpm --filter @workspace/agent402 run smoke
  smoke_exit=$?
  if [ "${smoke_exit}" -eq 0 ]; then
    echo "=== [smoke-child] Smoke test PASSED — server remains healthy ==="
  else
    # Keep this explicit warning stable for operational log searches and the
    # process-isolation regression test.
    echo "WARNING: Smoke test failed (exit ${smoke_exit}); production server remains running."
    echo "=== [smoke-child] Smoke test FAILED (exit ${smoke_exit}) — server remains healthy ==="
  fi
  exit "${smoke_exit}"
' smoke-child "${AGENT402_URL}" &
SMOKE_PID=$!
echo "    smoke child pid: ${SMOKE_PID}"

# ── 4. Keep the wrapper alive while the server runs ─────────────────────────
# Poll both children so a completed smoke child is reaped promptly. Its exit
# status is recorded for observability only; the server remains authoritative
# for the wrapper/deployment exit status.
SERVER_EXIT=0
SMOKE_EXIT=0
while kill -0 "${SERVER_PID}" 2>/dev/null; do
  if [[ -n "${SMOKE_PID}" ]] && ! kill -0 "${SMOKE_PID}" 2>/dev/null; then
    wait "${SMOKE_PID}" || SMOKE_EXIT=$?
    echo "    smoke child exit: ${SMOKE_EXIT} (non-fatal)"
    SMOKE_PID=""
  fi
  sleep 1
done

wait "${SERVER_PID}" || SERVER_EXIT=$?

# If the server exits while smoke is still running, stop only that smoke child
# and preserve the server's exit status. This path is unrelated to smoke
# failures during normal serving.
if [[ -n "${SMOKE_PID}" ]]; then
  terminate_smoke_child
  wait "${SMOKE_PID}" || SMOKE_EXIT=$?
  echo "    smoke child exit after server shutdown: ${SMOKE_EXIT}"
  SMOKE_PID=""
fi

echo "=== [startup] Agent402 server exited (exit ${SERVER_EXIT}) ==="
exit "${SERVER_EXIT}"
