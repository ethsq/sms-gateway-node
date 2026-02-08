#!/usr/bin/env bash
# ------------------------------------------------------------------
# Install (or reinstall) the USB/IP bridge watchdog as a macOS
# LaunchAgent.  The watchdog keeps usbipd + modem attach + sms-api
# alive automatically.
#
# Usage:
#   ./install-watchdog.sh          # install & start
#   ./install-watchdog.sh --remove # unload & remove
# ------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="net.backvision.usbip-watchdog"
PLIST_SRC="$SCRIPT_DIR/net.backvision.usbip-watchdog.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
WATCHDOG_SH="$SCRIPT_DIR/usbip-watchdog.sh"
INSTALL_DIR="$HOME/.local/bin"
INSTALLED_WATCHDOG="$INSTALL_DIR/usbip-watchdog.sh"
INSTALLED_BRIDGE_UP="$INSTALL_DIR/usbip-bridge-up.sh"

log() { printf '[install-watchdog] %s\n' "$*"; }
die() { printf '[install-watchdog] ERROR: %s\n' "$*" >&2; exit 1; }

# ── remove ──

if [[ "${1:-}" = "--remove" ]]; then
  log "Unloading $LABEL …"
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  rm -f "$PLIST_DST"
  log "Removed."
  exit 0
fi

# ── install ──

[[ -f "$PLIST_SRC" ]] || die "Template not found: $PLIST_SRC"
[[ -f "$WATCHDOG_SH" ]] || die "Watchdog script not found: $WATCHDOG_SH"

# Copy scripts to ~/.local/bin to avoid macOS App Management
# restrictions on ~/Desktop and ~/Documents folders.
mkdir -p "$INSTALL_DIR"
cp "$WATCHDOG_SH" "$INSTALLED_WATCHDOG"
cp "$SCRIPT_DIR/usbip-bridge-up.sh" "$INSTALLED_BRIDGE_UP"
chmod +x "$INSTALLED_WATCHDOG" "$INSTALLED_BRIDGE_UP"
log "Copied scripts → $INSTALL_DIR/"

# Unload previous if exists
launchctl unload "$PLIST_DST" 2>/dev/null || true

# Generate plist with installed path
ROOT_DIR_RESOLVED="$(cd "$SCRIPT_DIR/.." && pwd)"
sed -e "s|USBIP_WATCHDOG_PATH|${INSTALLED_WATCHDOG}|g" \
    -e "s|SMS_API_ROOT_PLACEHOLDER|${ROOT_DIR_RESOLVED}|g" \
    "$PLIST_SRC" > "$PLIST_DST"

log "Installed plist → $PLIST_DST"
log "Watchdog script → $WATCHDOG_SH"

launchctl load "$PLIST_DST"
log "✅ Loaded $LABEL"
log ""
log "  Status:  launchctl list | grep usbip"
log "  Logs:    tail -f /tmp/usbip-watchdog.log"
log "  Remove:  $0 --remove"
