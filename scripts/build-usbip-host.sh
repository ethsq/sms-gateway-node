#!/usr/bin/env bash
# ------------------------------------------------------------------
# Build the patched USB/IP host binary from jiegec/usbip.
#
# This clones upstream, applies our two patches (macOS IOKit claim +
# fast IN timeout), and produces a release binary at:
#   <DEST_DIR>/target/release/examples/host
#
# Usage:
#   ./build-usbip-host.sh [DEST_DIR]
#
# DEST_DIR defaults to /tmp/usbip.
# Requires: git, cargo (rustup)
# ------------------------------------------------------------------
set -euo pipefail

DEST_DIR="${1:-/tmp/usbip}"
UPSTREAM="https://github.com/jiegec/usbip.git"
UPSTREAM_REF="v0.8.0"   # commit 0878920
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_DIR="${SCRIPT_DIR}/../patches/usbip"

log() { printf '[build-usbip] %s\n' "$*"; }
die() { printf '[build-usbip] ERROR: %s\n' "$*" >&2; exit 1; }

command -v git   >/dev/null 2>&1 || die "git not found"
command -v cargo >/dev/null 2>&1 || die "cargo not found – install Rust via https://rustup.rs"

# ---- clone / reset ------------------------------------------------
if [[ -d "$DEST_DIR/.git" ]]; then
  log "Resetting existing clone at $DEST_DIR"
  git -C "$DEST_DIR" checkout -- . 2>/dev/null || true
  git -C "$DEST_DIR" clean -fdx >/dev/null
  git -C "$DEST_DIR" fetch origin
  git -C "$DEST_DIR" checkout "$UPSTREAM_REF" 2>/dev/null \
    || git -C "$DEST_DIR" checkout master
else
  log "Cloning $UPSTREAM → $DEST_DIR"
  git clone "$UPSTREAM" "$DEST_DIR"
  git -C "$DEST_DIR" checkout "$UPSTREAM_REF" 2>/dev/null \
    || git -C "$DEST_DIR" checkout master
fi

# ---- apply patches -----------------------------------------------
log "Applying patches from $PATCH_DIR"
for p in "$PATCH_DIR"/*.patch; do
  [[ -f "$p" ]] || continue
  log "  $(basename "$p")"
  git -C "$DEST_DIR" apply --check "$p" 2>/dev/null \
    && git -C "$DEST_DIR" apply "$p" \
    || log "  ↳ already applied or conflict – skipping"
done

# ---- build --------------------------------------------------------
log "Building release binary …"
(cd "$DEST_DIR" && cargo build --release --example host)

BINARY="$DEST_DIR/target/release/examples/host"
if [[ -x "$BINARY" ]]; then
  log "✅ Built successfully: $BINARY"
else
  die "Binary not found at $BINARY"
fi
