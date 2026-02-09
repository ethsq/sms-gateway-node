#!/usr/bin/env bash
# ------------------------------------------------------------------
# Install (or reinstall) the SMS API watchdog as a macOS LaunchAgent.
# The watchdog keeps sms-api (node) + cloudflared (Docker) alive.
#
# Usage:
#   ./install-watchdog.sh          # install & start
#   ./install-watchdog.sh --remove # unload & remove
# ------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="net.backvision.sms-watchdog"
OLD_LABEL="net.backvision.usbip-watchdog"
PLIST_SRC="$SCRIPT_DIR/net.backvision.sms-watchdog.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
WATCHDOG_SH="$SCRIPT_DIR/sms-watchdog.sh"
INSTALL_DIR="$HOME/.local/bin"
INSTALLED_WATCHDOG="$INSTALL_DIR/sms-watchdog.sh"

log() { printf '[install-watchdog] %s\n' "$*"; }
die() { printf '[install-watchdog] ERROR: %s\n' "$*" >&2; exit 1; }

# ── remove ──

if [[ "${1:-}" = "--remove" ]]; then
  log "Unloading $LABEL …"
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  rm -f "$PLIST_DST"
  # Also clean up old USB/IP watchdog if present
  launchctl unload "$HOME/Library/LaunchAgents/${OLD_LABEL}.plist" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/${OLD_LABEL}.plist"
  rm -f "$INSTALL_DIR/usbip-watchdog.sh" "$INSTALL_DIR/usbip-bridge-up.sh"
  log "Removed."
  exit 0
fi

# ── install ──

[[ -f "$PLIST_SRC" ]] || die "Template not found: $PLIST_SRC"
[[ -f "$WATCHDOG_SH" ]] || die "Watchdog script not found: $WATCHDOG_SH"

# Copy watchdog to ~/.local/bin to avoid macOS App Management
# restrictions on ~/Desktop and ~/Documents folders.
mkdir -p "$INSTALL_DIR"
cp "$WATCHDOG_SH" "$INSTALLED_WATCHDOG"
chmod +x "$INSTALLED_WATCHDOG"
log "Copied watchdog → $INSTALL_DIR/"

# Unload previous (both old and new labels)
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/${OLD_LABEL}.plist" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/${OLD_LABEL}.plist"
# Clean up old USB/IP scripts
rm -f "$INSTALL_DIR/usbip-watchdog.sh" "$INSTALL_DIR/usbip-bridge-up.sh"

# Generate plist with installed path
ROOT_DIR_RESOLVED="$(cd "$SCRIPT_DIR/.." && pwd)"
sed -e "s|SMS_WATCHDOG_PATH|${INSTALLED_WATCHDOG}|g" \
    -e "s|SMS_API_ROOT_PLACEHOLDER|${ROOT_DIR_RESOLVED}|g" \
    "$PLIST_SRC" > "$PLIST_DST"

log "Installed plist → $PLIST_DST"
log "Watchdog script → $WATCHDOG_SH"

launchctl load "$PLIST_DST"
log "✅ Loaded $LABEL"
log ""
log "  Status:  launchctl list | grep sms-watchdog"
log "  Logs:    tail -f /tmp/sms-watchdog.log"
log "  Remove:  $0 --remove"
