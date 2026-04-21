#!/usr/bin/env bash
# compat-record — stub
#
# Future: spawns a target program in a PTY, records every byte to an
# `input.bytes` file, and lets the author mark checkpoints interactively.
# See README.md in this directory for the planned invocation.
#
# Tracked: Plan 0005 Epic ε §6.

set -euo pipefail

cat >&2 <<'EOF'
compat-record: not yet implemented.

Plan 0005 Epic ε P0 ships the REPLAY half of the fixture pipeline. The
recording CLI is a separate follow-up; for now, fixtures are authored
by hand (see packages/ui/fixtures/compat/C-ED-01/build-fixture.mjs for
an example).

When this tool lands it will:
  1. Spawn the target in a real PTY with the requested cols/rows.
  2. Tee every emitted byte into <out>/input.bytes.
  3. Print a `checkpoint>` prompt; typed descriptions mark byte offsets.
  4. Write checkpoints.json, meta.json, and a README.md stub.

Tracked in docs/plans/0005-sota-convergence/README.md (Epic ε §6).
EOF

exit 1
