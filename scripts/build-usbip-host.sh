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
PATCH_COUNT=0
for p in "$PATCH_DIR"/*.patch; do
  [[ -f "$p" ]] || continue
  PATCH_NAME="$(basename "$p")"
  PATCH_COUNT=$((PATCH_COUNT + 1))
  log "  $PATCH_NAME"
  if git -C "$DEST_DIR" apply --check "$p" 2>/dev/null; then
    git -C "$DEST_DIR" apply "$p" \
      || die "Failed to apply patch: $PATCH_NAME"
  elif git -C "$DEST_DIR" apply --reverse --check "$p" 2>/dev/null; then
    log "  ↳ already applied"
  else
    die "Patch cannot be applied (conflict): $PATCH_NAME"
  fi
done
if [[ "$PATCH_COUNT" -eq 0 ]]; then
  die "No patches found in $PATCH_DIR – expected at least 2"
fi
log "Applied/verified $PATCH_COUNT patches"

# ---- build --------------------------------------------------------
log "Building release binary …"
(cd "$DEST_DIR" && cargo build --release --example host)

BINARY="$DEST_DIR/target/release/examples/host"
if [[ -x "$BINARY" ]]; then
  # Record patch fingerprint so bridge-up can verify
  FINGERPRINT="$(cd "$DEST_DIR" && git diff HEAD | md5 -q 2>/dev/null || git diff HEAD | md5sum | cut -d' ' -f1)"
  printf '%s\n' "$FINGERPRINT" > "${BINARY}.patches-md5"
  log "✅ Built successfully: $BINARY (patches-md5: $FINGERPRINT)"
else
  die "Binary not found at $BINARY"
fi
