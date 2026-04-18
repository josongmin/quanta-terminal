# quanta-diagnostic fixtures

Per ADR 0007, diagnostic parsers are driven through a fixture corpus that is
walkable by `tools/fixtures-runner`. Each fixture lives in a subdirectory named
after the scenario, and contains:

- `input.txt` — raw compiler/linter/runtime output as a terminal program would
  emit it.
- `expected.json` — the structured `DiagnosticDetected` events the parser
  should produce, in order. The envelope metadata (`event_id`, `wall_clock_ts`)
  is NOT asserted; only the payload shape.
- `notes.md` — one paragraph of context: which program, which version, which
  edge case.

The `quanta-diagnostic` crate itself does not yet exist (it is slated for the
post-walking-skeleton Phase 1 slice). This directory pre-declares the fixture
convention so the corpus walker has a real target and future parser work has
a pattern to follow.

## Current fixtures

- `rustc-basic/` — a single-error `cargo build` output. Placeholder until the
  real rustc adapter lands.
