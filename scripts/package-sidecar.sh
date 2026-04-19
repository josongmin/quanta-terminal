#!/usr/bin/env bash
# Package the freshly built `quanta-core` binary into the Tauri bundle layout.
#
# Tauri 2's `bundle.externalBin` convention requires the file on disk to be
# suffixed with the target triple (e.g. `quanta-core-aarch64-apple-darwin`).
# The bundler resolves the correct file at build time per target.
#
# This script builds the current-host triple only. Cross-compiling to ship a
# multi-target bundle is outside this script's scope — invoke it once per
# target triple on the corresponding builder (or wire it into CI matrix jobs).
#
# Usage:
#   ./scripts/package-sidecar.sh
#
# Output:
#   packages/host-tauri/src-tauri/binaries/quanta-core-<triple>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
if [ -z "$TRIPLE" ]; then
  echo "error: could not detect host triple from \`rustc -vV\`" >&2
  exit 1
fi

echo "build: quanta-core (release, triple=$TRIPLE)"
cargo build --release --bin quanta-core

BIN_SRC="target/release/quanta-core"
if [ "${TRIPLE}" != "${TRIPLE%windows*}" ]; then
  BIN_SRC="${BIN_SRC}.exe"
fi

if [ ! -f "$BIN_SRC" ]; then
  echo "error: expected $BIN_SRC to exist after \`cargo build --release --bin quanta-core\`" >&2
  exit 1
fi

DEST_DIR="packages/host-tauri/src-tauri/binaries"
mkdir -p "$DEST_DIR"

DEST="$DEST_DIR/quanta-core-$TRIPLE"
if [ "${TRIPLE}" != "${TRIPLE%windows*}" ]; then
  DEST="${DEST}.exe"
fi

cp "$BIN_SRC" "$DEST"
chmod +x "$DEST"
echo "packaged: $DEST"
