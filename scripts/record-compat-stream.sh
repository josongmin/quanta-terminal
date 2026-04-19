#!/usr/bin/env bash
# scripts/record-compat-stream.sh
#
# EPIC-G compat-stream recorder. Wraps `script(1)` with the fixed capture
# environment defined in
# `docs/plans/0001-custom-vt-engine-xterm-removal/epic-G-compat-matrix.md`
# §4.1:
#
#   TERM=xterm-256color
#   LINES=24, COLUMNS=80
#   TZ=UTC
#   LANG=en_US.UTF-8 (override via --locale)
#   COLORTERM=truecolor
#   HOME=<freshly-created tempdir>
#   PATH=/usr/bin:/bin:/usr/local/bin
#
# Outputs:
#
#   <out>/input.pty              -- raw PTY byte stream (script(1) output,
#                                   framing stripped)
#   <out>/scenario.md            -- stub; operator fills in after recording
#   <out>/expected_grid_snapshot.json  -- stub written by the blesser
#   <out>/expected_cursor.json         -- stub written by the blesser
#   <out>/expected_modes.json          -- stub written by the blesser
#
# After recording, run the blesser to populate the expected JSONs:
#
#   QUANTA_VT_BLESS=1 cargo test -p quanta-vt --test compat_harness
#
# The script also appends a provenance row to
# `crates/quanta-vt/tests/compat/VERSIONS.md`.
#
# Usage:
#
#   scripts/record-compat-stream.sh <program> \
#     --version <version_string> \
#     --scenario <scenario_id> \
#     --out <fixture_dir> \
#     [--locale <LC_ALL>] \
#     [--args "<cmd line args>"]
#
# Example:
#
#   scripts/record-compat-stream.sh vim \
#     --version 9.0.1234 \
#     --scenario vim-basic-edit-save \
#     --out crates/quanta-vt/tests/compat/vim/ \
#     --args "/tmp/hello.txt"
#
# Platform notes:
#   - macOS `script(1)`     : `script -q FILE cmd args...`
#   - util-linux `script(1)`: `script -q -c "cmd args..." FILE`
#   The script auto-detects and branches.

set -euo pipefail

# -----------------------------------------------------------------------
# CLI parsing
# -----------------------------------------------------------------------

PROGRAM=""
VERSION=""
SCENARIO=""
OUT_DIR=""
LOCALE="en_US.UTF-8"
PROGRAM_ARGS=""

err() { echo "error: $*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $0 <program> --version <v> --scenario <id> --out <dir> [--locale <L>] [--args "<a>"]

Required:
  <program>        Binary to invoke (e.g., vim, less, htop).
  --version V      The program's version string (e.g., "9.0.1234").
  --scenario ID    Short scenario id used in scenario.md (e.g., "vim-basic-edit-save").
  --out DIR        Fixture directory (e.g., crates/quanta-vt/tests/compat/vim/).

Optional:
  --locale L       LANG / LC_ALL at capture time (default: en_US.UTF-8).
  --args "ARGS"    Quoted argv passed to the program (default: empty).
EOF
}

if [ $# -lt 1 ]; then
  usage >&2
  exit 2
fi

PROGRAM="$1"
shift

if [ "$PROGRAM" = "-h" ] || [ "$PROGRAM" = "--help" ]; then
  usage
  exit 0
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --version)  VERSION="${2:-}";  shift 2 ;;
    --scenario) SCENARIO="${2:-}"; shift 2 ;;
    --out)      OUT_DIR="${2:-}";  shift 2 ;;
    --locale)   LOCALE="${2:-}";   shift 2 ;;
    --args)     PROGRAM_ARGS="${2:-}"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *) err "unknown flag: $1" ;;
  esac
done

[ -n "$VERSION" ]  || err "--version is required"
[ -n "$SCENARIO" ] || err "--scenario is required"
[ -n "$OUT_DIR" ]  || err "--out is required"

# -----------------------------------------------------------------------
# Host detection
# -----------------------------------------------------------------------

OS_KIND="$(uname -s)"
case "$OS_KIND" in
  Darwin) SCRIPT_FLAVOR="bsd" ;;
  Linux)  SCRIPT_FLAVOR="util-linux" ;;
  *)      err "unsupported OS: $OS_KIND (expected Darwin or Linux)" ;;
esac

command -v script >/dev/null 2>&1 || err "\`script(1)\` not found on PATH"
command -v "$PROGRAM" >/dev/null 2>&1 \
  || err "program \`$PROGRAM\` not found on PATH — install it or pick a different binary"

# -----------------------------------------------------------------------
# Output directory prep
# -----------------------------------------------------------------------

mkdir -p "$OUT_DIR"
INPUT_PTY_RAW="$OUT_DIR/input.pty.raw"
INPUT_PTY="$OUT_DIR/input.pty"
SCENARIO_MD="$OUT_DIR/scenario.md"

# -----------------------------------------------------------------------
# Fixed capture env
# -----------------------------------------------------------------------

CAPTURE_HOME="$(mktemp -d -t compat-stream-home.XXXXXX)"
trap 'rm -rf "$CAPTURE_HOME"' EXIT

ENV_ARGS=(
  env -i
  "HOME=$CAPTURE_HOME"
  "PATH=/usr/bin:/bin:/usr/local/bin"
  "TERM=xterm-256color"
  "LINES=24"
  "COLUMNS=80"
  "TZ=UTC"
  "LANG=$LOCALE"
  "LC_ALL=$LOCALE"
  "COLORTERM=truecolor"
)

# -----------------------------------------------------------------------
# Record
# -----------------------------------------------------------------------

echo "recording: $PROGRAM $PROGRAM_ARGS (scenario=$SCENARIO, version=$VERSION)"
echo "out dir:   $OUT_DIR"
echo "capture:   TERM=xterm-256color LINES=24 COLUMNS=80 TZ=UTC LANG=$LOCALE"
echo

if [ "$SCRIPT_FLAVOR" = "bsd" ]; then
  # macOS / BSD: `script -q FILE cmd args...`
  # Note: BSD `script` swallows args after the file. For complex argv use
  # `--args "a b c"`; we shell-expand below inside the child shell.
  "${ENV_ARGS[@]}" script -q "$INPUT_PTY_RAW" /bin/sh -c "$PROGRAM $PROGRAM_ARGS"
else
  # util-linux: `script -q -c "cmd args..." FILE`
  "${ENV_ARGS[@]}" script -q -c "$PROGRAM $PROGRAM_ARGS" "$INPUT_PTY_RAW"
fi

# -----------------------------------------------------------------------
# Post-process: strip script(1)'s framing
# -----------------------------------------------------------------------
#
# BSD script prepends one "Script started on ..." line and appends
# "Script done on ...". util-linux does similar. We strip the first and
# last line of text framing; the escape-sequence content in between is
# what we want.
#
# This is intentionally coarse — operators should inspect input.pty after
# recording and trim further if needed. A more sophisticated stripper
# would understand script(1)'s header/footer line formats per platform;
# for now, the trivial skip-one-line approach covers the common case.

if [ -s "$INPUT_PTY_RAW" ]; then
  # Skip first line (header), write the rest, then strip a trailing
  # "Script done ..." line if present.
  tail -n +2 "$INPUT_PTY_RAW" \
    | sed -E '$ { /^Script done on/d; }' \
    > "$INPUT_PTY"
else
  err "script(1) produced no output at $INPUT_PTY_RAW"
fi
rm -f "$INPUT_PTY_RAW"

echo "wrote: $INPUT_PTY ($(wc -c < "$INPUT_PTY") bytes)"

# -----------------------------------------------------------------------
# scenario.md template (only if absent — don't clobber a human-edited one)
# -----------------------------------------------------------------------

if [ ! -f "$SCENARIO_MD" ]; then
  cat > "$SCENARIO_MD" <<EOF
# Scenario: \`$(basename "$OUT_DIR")\`

- **Title**: \`$SCENARIO\`
- **Harness**: replay (golden-stream)
- **Fixture kind**: recorded from \`$PROGRAM $PROGRAM_ARGS\`.

## Precondition

TBD — operator fills in: what files / state existed before the
recording, any environmental assumption beyond the fixed capture env.

## Input

Raw PTY byte stream captured via \`script(1)\` at:

- \`TERM=xterm-256color\`
- \`LINES=24\`, \`COLUMNS=80\`
- \`TZ=UTC\`, \`LANG=$LOCALE\`
- \`COLORTERM=truecolor\`
- Clean \`\$HOME\` tempdir
- \`PATH=/usr/bin:/bin:/usr/local/bin\`

## Expected observable state

TBD — operator fills in the specific assertions for this scenario.
End-of-feed grid / cursor / mode state is captured in the sibling
\`expected_*.json\` files by running
\`QUANTA_VT_BLESS=1 cargo test -p quanta-vt --test compat_harness\`.

## Purpose

TBD — describe the v1 failure mode this fixture catches.

## Captured

**Captured**: $PROGRAM $VERSION / $OS_KIND / $LOCALE / $(date -u +%Y-%m-%d) / by \$USER
EOF
  echo "wrote: $SCENARIO_MD (template — edit before committing)"
else
  echo "kept:  $SCENARIO_MD (already exists)"
fi

# -----------------------------------------------------------------------
# Stub the three expected_*.json files so the harness can discover the
# fixture before the blesser populates real content.
# -----------------------------------------------------------------------

for stub in expected_grid_snapshot.json expected_cursor.json expected_modes.json; do
  if [ ! -f "$OUT_DIR/$stub" ]; then
    echo '{}' > "$OUT_DIR/$stub"
    echo "stub:  $OUT_DIR/$stub (run the blesser to populate)"
  fi
done

# -----------------------------------------------------------------------
# Append VERSIONS.md row
# -----------------------------------------------------------------------

VERSIONS_MD="$(dirname "$OUT_DIR")/VERSIONS.md"
if [ -f "$VERSIONS_MD" ]; then
  ROW="| $(basename "$OUT_DIR") | $VERSION | $OS_KIND | $LOCALE | $(date -u +%Y-%m-%d) | \$USER | recorded via record-compat-stream.sh |"
  # Append at end of file (idempotency is the operator's job — re-runs
  # append new rows for re-recordings, which is the desired behavior).
  echo "$ROW" >> "$VERSIONS_MD"
  echo "appended: $VERSIONS_MD"
else
  echo "warning: $VERSIONS_MD not found — no provenance row written." >&2
fi

echo
echo "Next steps:"
echo "  1. Edit $SCENARIO_MD to describe the scenario."
echo "  2. Run the blesser to populate expected_*.json:"
echo "       QUANTA_VT_BLESS=1 cargo test -p quanta-vt --test compat_harness"
echo "  3. Add the fixture name to FIXTURES in crates/quanta-vt/tests/compat_harness.rs."
echo "  4. Commit."
