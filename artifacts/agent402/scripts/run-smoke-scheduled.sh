#!/usr/bin/env bash
# Runs the Agent402 smoke test on a daily schedule.
# Designed to run as a persistent Replit workflow ("smoke_test: Smoke Test (Scheduled)").
#
# On each iteration:
#   - Prints a timestamped header
#   - Runs the paid smoke test and the separate non-paying CDP discovery monitor
#   - Prints each exit code so failures are visible in workflow logs
#   - On failure, either child posts an alert to SMOKE_ALERT_WEBHOOK_URL (if set)
#   - Sleeps 24 hours before the next run
#
# Optional env:
#   SMOKE_INTERVAL_SECONDS   — override the 24-hour interval (default: 86400)
#   SMOKE_ALERT_WEBHOOK_URL  — Slack / Discord webhook URL; posted on failure by smoke.ts
#
# The script never exits on its own so Replit can track it as a running workflow.

set -euo pipefail

cd /home/runner/workspace

INTERVAL_SECONDS=${SMOKE_INTERVAL_SECONDS:-86400}   # default: 24 hours

echo "=== Agent402 scheduled smoke test ==="
echo "    interval : ${INTERVAL_SECONDS}s"
echo "    started  : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if [ -n "${SMOKE_ALERT_WEBHOOK_URL:-}" ]; then
  echo "    alerts   : webhook configured"
else
  echo "    alerts   : none (set SMOKE_ALERT_WEBHOOK_URL to enable)"
fi
echo ""

while true; do
  echo "──────────────────────────────────────────────────────"
  echo "  run at : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "──────────────────────────────────────────────────────"

  SMOKE_EXIT_CODE=0
  DISCOVERY_EXIT_CODE=0
  pnpm --filter @workspace/agent402 run smoke || SMOKE_EXIT_CODE=$?
  pnpm --filter @workspace/agent402 run monitor:cdp-discovery || DISCOVERY_EXIT_CODE=$?

  if [ "${SMOKE_EXIT_CODE}" -eq 0 ] && [ "${DISCOVERY_EXIT_CODE}" -eq 0 ]; then
    echo "  [RESULT] PASS"
  else
    echo "  [RESULT] FAIL (smoke exit ${SMOKE_EXIT_CODE}; discovery exit ${DISCOVERY_EXIT_CODE})"
  fi

  echo ""
  echo "  next run in ${INTERVAL_SECONDS}s  ($(date -u -d "+${INTERVAL_SECONDS} seconds" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v +${INTERVAL_SECONDS}S '+%Y-%m-%dT%H:%M:%SZ'))"
  sleep "${INTERVAL_SECONDS}"
done
