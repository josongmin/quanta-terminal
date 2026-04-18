# ADR 0007 — Diagnostic Parser Rollout Plan

## Status

Accepted for Phase 1. Tiers the parser list, names per-parser accuracy targets, and defines a fixture corpus expectation.

## Context

The spec lists eight shipped parsers in the "first implementation wave": tsc, rustc/cargo, Python traceback, Node.js stack traces, pytest, jest/vitest, ESLint, and GCC/Clang. Putting all of them on the same P0 slope causes the team to ship eight half-good parsers instead of four good ones. The product's core value — faster error-to-code — depends on diagnostics being *trusted*. A wrong file jump is worse than no file jump.

Opinion: precision is worth more than recall in this product. Better to miss a diagnostic than to misdirect a developer to the wrong line.

## Decision

### Tiers

**Tier 1 (P0 — ship at Phase 1 start)**

- `rustc` + `cargo`
- TypeScript `tsc`
- Python traceback
- Node.js stack traces

Rationale: these four cover the bulk of compile-and-run failures for the primary target repos (Rust backend, TypeScript frontend) and the two most common side stacks. They also have stable, well-documented output formats.

**Tier 2 (P1 — ship at Phase 2 recovery milestone)**

- `pytest`
- `vitest` / `jest`
- `ESLint`

Rationale: test runners and linters are high-value but higher-variance in output format. Better to ship once the T1 pipeline has proven its fixture discipline.

**Tier 3 (P2 — ship when demand justifies)**

- GCC / Clang
- `ruff`
- `mypy`
- `cargo clippy` (may be folded into the rustc adapter early)
- `go test` and Go stack traces
- `rspec`

### Per-Parser Accuracy Targets

Measured on the fixture corpus, not on live inputs.

- Precision ≥ 0.97 for Tier 1 parsers.
- Recall ≥ 0.85 for Tier 1 parsers.
- Precision ≥ 0.95 for Tier 2.
- Recall ≥ 0.80 for Tier 2.
- Tier 3 parsers may ship once they clear 0.95 / 0.75.

A parser that misses the bar does not ship. It lands in-tree behind a feature flag and accumulates fixtures until it clears.

### Latency Targets

Per ADR 0002, diagnostic extraction must not block PTY flow. Targets are wall-clock, measured from "output chunk reaches the diagnostics pipeline" to "diagnostic emitted to the projection":

- Tier 1 parsers: p95 first-useful-diagnostic ≤ 150 ms.
- Tier 2 parsers: p95 ≤ 300 ms.
- Tier 3 parsers: p95 ≤ 500 ms.

These are per-output-chunk budgets, not per-block. Block-level diagnostic completion may trail by much longer for long compiler runs.

### Fixture Corpus

- Minimum 20 diverse failure fixtures per Tier 1 parser at initial ship, growing over time.
- Minimum 15 per Tier 2 parser.
- Fixtures live in `crates/quanta-diagnostics/fixtures/<parser_id>/`, each with a raw output file and an expected-normalized JSON.
- Every bug report that describes a missed or misattributed diagnostic converts into a new fixture before the fix ships.
- A fixture can be marked `expected_miss: true` to capture ambiguous cases the parser is intentionally refusing.

### Confidence Scoring

Every emitted diagnostic carries `confidence: 0.0 — 1.0`. Confidence flows from:

- Parser adapter's prior for that output shape.
- Cross-signal agreement: exit code, stderr density, path resolvability, line within file bounds.
- Penalty if the file/line fails to resolve in the workspace.

UI behavior by confidence band:

- ≥ 0.85 — rendered as a direct clickable link.
- 0.6 — 0.85 — rendered with a hover warning about uncertainty.
- < 0.6 — not surfaced as a primary link; available in a "possible locations" overlay.

### Normalization Guarantees

All Tier 1 and Tier 2 parsers must emit:

- Workspace-relative path when the absolute path resolves inside a known workspace root, otherwise absolute.
- 1-based line and column.
- Deduplicated emissions within a block (multi-emission of the same source location is merged with provenance preserved).
- A stable `parser_id` string used for filtering, metrics, and rule-level disable.

### Per-Parser Disable

Users can disable individual parsers. Disabled parsers:

- Still run for telemetry in debug builds, not in shipping builds.
- Hide their emissions from the UI.
- Can be disabled globally or per workspace.

### Metrics

The diagnostic pipeline emits metrics per parser id:

- `matches_emitted`
- `matches_suppressed_low_confidence`
- `path_resolution_hit` / `miss`
- `time_to_first_diagnostic_ms`
- `user_clicked_diagnostic`
- `user_dismissed_diagnostic`

User clicks vs dismissals is the real-world proxy for precision. Track it.

## Consequences

- Release notes per phase name which parsers shipped.
- A dedicated fixture-driven test suite runs in CI and blocks merges on regressions for any Tier 1 parser.
- The parser interface is stable enough that a community contributor could add a Tier 3 parser without touching the core pipeline.

## Non-Goals

- Covering every tool. The tail is long; pick the parsers that move the product metric.
- Machine-learned diagnostic extraction in Phase 1. The deterministic adapter pipeline is the design.
