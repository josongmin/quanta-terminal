#!/usr/bin/env bash
# Rasterize the placeholder SVG into the full set of bundle icons Tauri
# expects under packages/host-tauri/src-tauri/icons/.
#
# Inputs:
#   assets/icon.svg                  — the single-source SVG
#
# Outputs:
#   packages/host-tauri/src-tauri/icons/32x32.png
#   packages/host-tauri/src-tauri/icons/128x128.png
#   packages/host-tauri/src-tauri/icons/128x128@2x.png     (= 256x256)
#   packages/host-tauri/src-tauri/icons/icon.icns          (macOS)
#   packages/host-tauri/src-tauri/icons/icon.ico           (Windows)
#
# Tools required on PATH:
#   - `magick` or `convert` (ImageMagick) for PNG + ICO
#   - `iconutil` on macOS for ICNS (the Linux fallback uses `png2icns`
#     if available, otherwise the script emits a warning and skips)
#   - `rsvg-convert` (optional) — produces crisper rasters than
#     ImageMagick's built-in SVG renderer. When present the PNGs go
#     through rsvg-convert first and ImageMagick only handles format
#     conversions.
#
# Safe to re-run; every output is overwritten. The generated files are
# committed to the repo so `cargo tauri build` works out of the box —
# don't .gitignore them.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SRC_SVG="assets/icon.svg"
OUT_DIR="packages/host-tauri/src-tauri/icons"

if [ ! -f "$SRC_SVG" ]; then
  echo "generate-icons: error: source SVG $SRC_SVG is missing" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# Pick the best SVG rasterizer available.
have() { command -v "$1" >/dev/null 2>&1; }

rasterize() {
  # rasterize <size> <out.png>
  local size="$1"
  local out="$2"
  if have rsvg-convert; then
    rsvg-convert -w "$size" -h "$size" "$SRC_SVG" -o "$out"
  elif have magick; then
    magick -background none -density 384 "$SRC_SVG" -resize "${size}x${size}" "$out"
  elif have convert; then
    convert -background none -density 384 "$SRC_SVG" -resize "${size}x${size}" "$out"
  else
    echo "generate-icons: error: need rsvg-convert, magick, or convert on PATH" >&2
    exit 1
  fi
}

echo "generate-icons: rasterizing PNGs"
rasterize 32   "$OUT_DIR/32x32.png"
rasterize 128  "$OUT_DIR/128x128.png"
rasterize 256  "$OUT_DIR/128x128@2x.png"
rasterize 512  "$OUT_DIR/icon.png"
rasterize 1024 "$OUT_DIR/icon-1024.png"

# --- macOS .icns -------------------------------------------------------------
echo "generate-icons: assembling icon.icns"
ICONSET_DIR="$OUT_DIR/icon.iconset"
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"
rasterize 16   "$ICONSET_DIR/icon_16x16.png"
rasterize 32   "$ICONSET_DIR/icon_16x16@2x.png"
rasterize 32   "$ICONSET_DIR/icon_32x32.png"
rasterize 64   "$ICONSET_DIR/icon_32x32@2x.png"
rasterize 128  "$ICONSET_DIR/icon_128x128.png"
rasterize 256  "$ICONSET_DIR/icon_128x128@2x.png"
rasterize 256  "$ICONSET_DIR/icon_256x256.png"
rasterize 512  "$ICONSET_DIR/icon_256x256@2x.png"
rasterize 512  "$ICONSET_DIR/icon_512x512.png"
rasterize 1024 "$ICONSET_DIR/icon_512x512@2x.png"

if have iconutil; then
  iconutil -c icns "$ICONSET_DIR" -o "$OUT_DIR/icon.icns"
elif have png2icns; then
  png2icns "$OUT_DIR/icon.icns" \
    "$ICONSET_DIR/icon_16x16.png" \
    "$ICONSET_DIR/icon_32x32.png" \
    "$ICONSET_DIR/icon_128x128.png" \
    "$ICONSET_DIR/icon_256x256.png" \
    "$ICONSET_DIR/icon_512x512.png" \
    "$ICONSET_DIR/icon_512x512@2x.png"
else
  echo "generate-icons: warn: no iconutil/png2icns; icon.icns will not be generated on this host" >&2
fi
rm -rf "$ICONSET_DIR"

# --- Windows .ico ------------------------------------------------------------
echo "generate-icons: assembling icon.ico"
if have magick; then
  magick "$OUT_DIR/32x32.png" "$OUT_DIR/128x128.png" \
    "$OUT_DIR/128x128@2x.png" "$OUT_DIR/icon.png" \
    -define icon:auto-resize=16,24,32,48,64,128,256 "$OUT_DIR/icon.ico"
elif have convert; then
  convert "$OUT_DIR/32x32.png" "$OUT_DIR/128x128.png" \
    "$OUT_DIR/128x128@2x.png" "$OUT_DIR/icon.png" \
    -define icon:auto-resize=16,24,32,48,64,128,256 "$OUT_DIR/icon.ico"
elif have png-to-ico; then
  png-to-ico "$OUT_DIR/icon.png" > "$OUT_DIR/icon.ico"
else
  echo "generate-icons: warn: no magick/convert/png-to-ico; icon.ico will not be generated" >&2
fi

# Housekeeping: the 1024 intermediate isn't shipped.
rm -f "$OUT_DIR/icon-1024.png"

echo "generate-icons: done. Outputs under $OUT_DIR:"
ls -la "$OUT_DIR"
