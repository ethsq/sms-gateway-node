#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USBIP_REMOTE_HOST="${USBIP_REMOTE_HOST:-host.docker.internal}"

log() {
  printf '[usbip-status] %s\n' "$*"
}

vm_cmd() {
  local cmd="$1"
  docker run --rm --privileged --pid=host alpine sh -lc \
    "nsenter -t 1 -m -u -i -n sh -lc $(printf '%q' "$cmd")"
}

log "host listener :3240"
lsof -nP -iTCP:3240 -sTCP:LISTEN || true

log "USB/IP export list from host"
vm_cmd "usbip list -r ${USBIP_REMOTE_HOST}" || true

log "Docker VM vhci status"
vm_cmd "cat /sys/devices/platform/vhci_hcd.0/status" || true

log "Docker VM ttyUSB devices"
vm_cmd "ls -l /dev/ttyUSB* 2>/dev/null || true"

log "sms-api containers"
(
  cd "$ROOT_DIR"
  docker compose ps
)

log "sms-api health"
(
  cd "$ROOT_DIR"
  docker compose exec -T sms-api curl -s http://localhost:3000/health
  echo
)
