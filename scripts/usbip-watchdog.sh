#!/usr/bin/env bash
# ------------------------------------------------------------------
# USB/IP Bridge Watchdog  (v2 – simplified, no subshell timeouts)
#
# Runs as a continuous loop (designed for launchd KeepAlive).
# Every INTERVAL seconds it checks:
#   1. usbipd is listening on tcp/3240
#   2. sms-api container responds on /health with modemConnected:true
#
# If any check fails it runs the full bridge-up recovery.
# ------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SMS_API_ROOT:-$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)}"

INTERVAL="${WATCHDOG_INTERVAL:-30}"
LOG="/tmp/usbip-watchdog.log"

# ── logging ──────────────────────────────────────────────────────

log() {
  printf '[watchdog %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" \
    | tee -a "$LOG"
}

rotate_log() {
  local sz
  sz="$(stat -f%z "$LOG" 2>/dev/null || echo 0)"
  if [ "$sz" -gt 1048576 ] 2>/dev/null; then
    mv "$LOG" "${LOG}.1"
    log "Log rotated"
  fi
}

# ── health checks (no background processes, no subshell capture) ─

check_usbipd() {
  lsof -nP -iTCP:3240 -sTCP:LISTEN >/dev/null 2>&1
}

check_sms_api() {
  # docker compose exec + curl; --max-time keeps it bounded
  local out
  out="$(cd "$ROOT_DIR" && docker compose exec -T sms-api \
    curl -sf --max-time 5 http://localhost:3000/health 2>/dev/null)" || return 1
  echo "$out" | grep -q '"modemConnected":true'
}

# ── recovery ─────────────────────────────────────────────────────

recover() {
  log "Running bridge recovery …"

  # kill stale usbipd if hanging (process alive but not listening)
  if pgrep -f "usbip.*host" >/dev/null 2>&1 && ! check_usbipd; then
    log "  killing stale usbipd"
    pkill -f "usbip.*host" 2>/dev/null
    sleep 1
  fi

  local bridge="${SCRIPT_DIR}/usbip-bridge-up.sh"
  [ -x "$bridge" ] || bridge="$ROOT_DIR/scripts/usbip-bridge-up.sh"
  if SMS_API_ROOT="$ROOT_DIR" bash "$bridge" >> "$LOG" 2>&1; then
    log "Recovery complete"
    return 0
  else
    log "Recovery failed – will retry next cycle"
    return 1
  fi
}

# ── main loop ────────────────────────────────────────────────────

log "Watchdog started (interval=${INTERVAL}s, pid=$$, root=${ROOT_DIR})"

CONSECUTIVE_FAILURES=0
TICK=0
FIRST_CYCLE=true

while true; do
  HEALTHY=true

  if ! check_usbipd; then
    log "WARN usbipd not listening on :3240"
    HEALTHY=false
  fi

  if $HEALTHY && ! check_sms_api; then
    log "WARN sms-api health check failed"
    HEALTHY=false
  fi

  if $HEALTHY; then
    if [ "$CONSECUTIVE_FAILURES" -gt 0 ] 2>/dev/null; then
      log "OK all checks passed (recovered after ${CONSECUTIVE_FAILURES} failures)"
    else
      # heartbeat every 10 cycles (~5 min) to confirm watchdog is alive
      if $FIRST_CYCLE; then
        log "OK first check passed – all healthy"
        FIRST_CYCLE=false
      fi
      TICK=$((TICK + 1))
      if [ "$TICK" -ge 10 ]; then
        log "OK heartbeat – all healthy"
        TICK=0
      fi
    fi
    CONSECUTIVE_FAILURES=0
  else
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    log "Failure #${CONSECUTIVE_FAILURES}"
    recover || true
  fi

  rotate_log
  sleep "$INTERVAL"
done
