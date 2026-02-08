#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

USBIP_HOST_BIN="${USBIP_HOST_BIN:-/tmp/usbip/target/release/examples/host}"
USBIP_REMOTE_HOST="${USBIP_REMOTE_HOST:-host.docker.internal}"
USB_VID="${USB_VID:-1e0e}"
USB_PID="${USB_PID:-9001}"

log() {
  printf '[usbip-bridge] %s\n' "$*"
}

die() {
  printf '[usbip-bridge] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

vm_cmd() {
  local cmd="$1"
  docker run --rm --privileged --pid=host alpine sh -lc \
    "nsenter -t 1 -m -u -i -n sh -lc $(printf '%q' "$cmd")"
}

vm_has_modem() {
  vm_cmd "for f in /sys/bus/usb/devices/*/idVendor; do d=\${f%/idVendor}; v=\$(cat \"\$f\" 2>/dev/null); p=\$(cat \"\$d/idProduct\" 2>/dev/null); if [ \"\$v:\$p\" = \"${USB_VID}:${USB_PID}\" ]; then exit 0; fi; done; exit 1" >/dev/null 2>&1
}

require_cmd docker
require_cmd lsof

if [[ ! -x "$USBIP_HOST_BIN" ]]; then
  log "USB/IP host binary not found – building with patches …"
  USBIP_REPO="${USBIP_HOST_BIN%/target/release/examples/host}"
  "${ROOT_DIR}/scripts/build-usbip-host.sh" "$USBIP_REPO"
  if [[ ! -x "$USBIP_HOST_BIN" ]]; then
    die "Build failed – binary still missing at $USBIP_HOST_BIN"
  fi
fi

log "1/6 ensure USB/IP host server listens on tcp/3240"
if ! lsof -nP -iTCP:3240 -sTCP:LISTEN >/dev/null 2>&1; then
  nohup "$USBIP_HOST_BIN" >/tmp/usbip-host.log 2>&1 &
  sleep 1
fi
if ! lsof -nP -iTCP:3240 -sTCP:LISTEN >/dev/null 2>&1; then
  die "USB/IP host server is not listening on tcp/3240"
fi

log "2/6 ensure usbip client exists in Docker VM"
vm_cmd "command -v usbip >/dev/null 2>&1 || (apt-get update >/dev/null && apt-get install -y usbip >/dev/null)"

log "3/6 ensure modem is attached in Docker VM"
if vm_has_modem; then
  log "modem already attached, skipping attach"
else
  log "modem not attached yet, searching USB/IP export list"
  EXPORT_LIST="$(vm_cmd "usbip list -r ${USBIP_REMOTE_HOST}")"
  BUSID="$(printf '%s\n' "$EXPORT_LIST" | awk -v target="(${USB_VID}:${USB_PID})" '$0 ~ target {gsub(":", "", $1); print $1; exit}')"
  if [[ -z "$BUSID" ]]; then
    printf '%s\n' "$EXPORT_LIST" >&2
    die "Modem not found in USB/IP export list"
  fi
  log "found busid: $BUSID"

  log "4/6 clear stale vhci ports then attach modem"
  vm_cmd "for p in 0 1 2 3 4 5 6 7; do usbip detach -p \$p >/dev/null 2>&1 || true; done; usbip attach -r ${USBIP_REMOTE_HOST} -b ${BUSID}"

  log "5/6 wait until modem appears in Docker VM usb sysfs"
  FOUND=0
  for _ in $(seq 1 20); do
    if vm_has_modem; then
      FOUND=1
      break
    fi
    sleep 1
  done
  if [[ "$FOUND" != "1" ]]; then
    vm_cmd "cat /sys/devices/platform/vhci_hcd.0/status || true" >&2 || true
    die "Modem did not appear in Docker VM after attach"
  fi
fi

log "6/6 recreate sms-api"
(
  cd "$ROOT_DIR"
  docker compose up -d --force-recreate sms-api
)

log "bridge is ready"
log "health check: docker compose exec -T sms-api curl -s http://localhost:3000/health"
