#!/usr/bin/env bash
# ------------------------------------------------------------------
# SMS API Watchdog  (v3 – native macOS USB, no USB/IP)
#
# Runs as a continuous loop (designed for launchd KeepAlive).
# Every INTERVAL seconds it checks:
#   1. node server.js is running and listening on :3000
#   2. /health responds with modemConnected:true
#   3. cloudflared Docker container is running
#
# If sms-api is down it restarts; if cloudflared is down it restarts.
# ------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SMS_API_ROOT:-$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)}"

INTERVAL="${WATCHDOG_INTERVAL:-30}"
LOG="/tmp/sms-watchdog.log"
PIDFILE="/tmp/sms-api.pid"

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

# ── health checks ────────────────────────────────────────────────

check_sms_api_process() {
  # Check if we have a PID file and the process is alive
  if [ -f "$PIDFILE" ]; then
    local pid
    pid="$(cat "$PIDFILE" 2>/dev/null)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  # Fallback: check if any process is listening on :3000
  lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1
}

check_sms_api_health() {
  local out
  out="$(curl -sf --max-time 5 http://localhost:3000/health 2>/dev/null)" || return 1
  echo "$out" | grep -q '"modemConnected":true'
}

check_cloudflared() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -q sms-cloudflared
}

# ── recovery ─────────────────────────────────────────────────────

start_sms_api() {
  log "Starting sms-api (node server.js) ..."
  # Kill any stale process
  if [ -f "$PIDFILE" ]; then
    local old_pid
    old_pid="$(cat "$PIDFILE" 2>/dev/null)"
    kill "$old_pid" 2>/dev/null
    sleep 1
  fi
  # Also kill anything on :3000
  lsof -ti tcp:3000 2>/dev/null | xargs kill 2>/dev/null
  sleep 1

  cd "$ROOT_DIR" || return 1
  local node_bin
  node_bin="$(command -v node 2>/dev/null)"
  if [ -z "$node_bin" ]; then
    log "ERROR: node not found in PATH"
    return 1
  fi
  nohup "$node_bin" server.js >> /tmp/sms-api.log 2>&1 &
  echo $! > "$PIDFILE"
  log "sms-api started (pid=$!)"
  sleep 3
}

start_cloudflared() {
  log "Starting cloudflared container ..."
  cd "$ROOT_DIR" || return 1
  docker compose up -d cloudflared >> "$LOG" 2>&1
  log "cloudflared started"
  sleep 2
}

# ── main loop ────────────────────────────────────────────────────

log "Watchdog started (interval=${INTERVAL}s, pid=$$, root=${ROOT_DIR})"

CONSECUTIVE_FAILURES=0
TICK=0
FIRST_CYCLE=true

while true; do
  HEALTHY=true

  # Check 1: sms-api process
  if ! check_sms_api_process; then
    log "WARN sms-api process not running"
    start_sms_api
    HEALTHY=false
  fi

  # Check 2: sms-api health (only if process is up)
  if $HEALTHY && ! check_sms_api_health; then
    log "WARN sms-api health check failed (modem may be disconnected)"
    HEALTHY=false
    # If process is there but modem not connected, restart
    start_sms_api
  fi

  # Check 3: cloudflared container
  if ! check_cloudflared; then
    log "WARN cloudflared container not running"
    start_cloudflared
    HEALTHY=false
  fi

  if $HEALTHY; then
    if [ "$CONSECUTIVE_FAILURES" -gt 0 ] 2>/dev/null; then
      log "OK all checks passed (recovered after ${CONSECUTIVE_FAILURES} failures)"
    else
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
  fi

  rotate_log
  sleep "$INTERVAL"
done
