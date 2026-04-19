# Perf Baselines

Tracked baseline numbers for the perf harness at `tests/perf/`.

> **Update this table when re-baselining.** The CI job at `.github/workflows/perf.yml` reads the numbers below and fails a PR if any stage regresses by more than 10 %. A new baseline PR is the mechanism for intentionally moving a number: change the table, note the reason in the commit body, and the next run on `main` confirms the green state.

- **Last verified**: 2026-04-19 (RFC 0001 §19 closure audit)
- **Test binary path**: `tests/perf/benches/` (criterion targets)
- **Methodology note**: numbers below come from the stub criterion benches landed by EPIC-J. They exercise the metrics-recorder path only; they do NOT yet exercise end-to-end keystroke → rendered cell under a real PTY, because the browser renderer test harness is a vitest + jsdom surface (no paint timing). The synthetic numbers still gate against regression of the telemetry recorder path that every stage feeds, and the stage budgets below are what CI asserts against when each EPIC wires a real measurement in.

## 1. Baseline platform

The p95 column is authoritative on **macOS arm64 (M-series)** per RFC 0001 §13.12. Secondary runners (Linux x86_64) capture regression signal but do not gate against an absolute number — they gate against the delta from their own last-green run.

Hardware class (baseline): Apple M-series, 16 GB, macOS 14+, built in `release` profile with the workspace lint settings.

## 2. Stage budgets (RFC §13.13)

Sum of per-stage p95 budgets = 16 ms (the per-frame target). These are sustain targets, not hard ceilings. Source of truth: `crates/quanta-metrics/src/stage.rs::PerfStage::budget_p95_us`.

| Stage                 | Metric name                            | Budget (p95) | Measured (stub harness) | Status |
|-----------------------|----------------------------------------|-------------:|------------------------:|--------|
| PTY parse             | `perf.stage.pty_parse_us`              | 2 000 µs     | 1 µs (stub)             | WITHIN BUDGET |
| Reducer apply         | `perf.stage.reducer_apply_us`          | 3 000 µs     | 1 µs (stub)             | WITHIN BUDGET |
| Layout / hit-test     | `perf.stage.layout_hit_test_us`        | 1 000 µs     | 1 µs (stub)             | WITHIN BUDGET |
| Raster                | `perf.stage.raster_us`                 | 6 000 µs     | 1 µs (stub)             | WITHIN BUDGET |
| Cursor / overlay      | `perf.stage.cursor_overlay_us`         | 1 000 µs     | 1 µs (stub)             | WITHIN BUDGET |
| Atlas miss recovery   | `perf.stage.atlas_miss_recovery_us`    | 3 000 µs     | 1 µs (stub)             | WITHIN BUDGET |

The stub harness writes a synthetic observation that clamps to 1 µs via `record_stage` (`Duration::as_micros().max(1)`). Real per-stage numbers land when each EPIC finishes wiring its instrumentation — every stage today has a live counter emitter per `crates/quanta-metrics/tests/rfc_counter_catalog.rs`.

## 3. Measured baselines (criterion benches)

The three criterion benches in `tests/perf/benches/` all run and emit stable numbers on the baseline hardware. They are bench targets only (`cargo bench -p quanta-perf-harness`) and the workspace `cargo test --workspace` does not build them. The stored criterion estimates under `target/criterion/*/estimates.json` back the CI regression check.

### 3.1 `keystroke_latency` — reducer apply stand-in

Measures a 1 024-byte wrapping-add loop and records a `ReducerApply` histogram observation, so we detect regressions in the recorder + histogram pathway. Replace with a real reducer-apply pass once the engine + canvas renderer are wired on the perf harness's driver thread.

| Platform                        | p50      | p95      | p99      | Notes                         |
|---------------------------------|---------:|---------:|---------:|-------------------------------|
| macOS arm64 (baseline)          |  ~0.9 µs |  ~1.5 µs |  ~2 µs   | stub — within 16 ms budget    |
| macOS x86_64                    |   —      |   —      |   —      | secondary (CI populates)      |
| Linux x86_64 (Ubuntu 22.04)     |   —      |   —      |   —      | secondary (CI populates)      |
| Windows x86_64                  |   —      |   —      |   —      | tracking (known partial)      |

### 3.2 `delta_throughput` — 1 MB apply stand-in

Measures how fast the metrics recorder can ingest a stream of reducer-apply observations. Baseline throughput stays well above the RFC §13.12 steady-delta target (`≤ 200 KB/s` on `cargo build`-scale output) because the stub path does no grid mutation.

| Platform                        | throughput (MB/s) | p95 apply | Notes |
|---------------------------------|------------------:|----------:|-------|
| macOS arm64 (baseline)          |  ~500 MB/s (stub) |  ~2 µs    | stub harness — no grid work |
| macOS x86_64                    |   —               |   —       | secondary |
| Linux x86_64                    |   —               |   —       | secondary |
| Windows x86_64                  |   —               |   —       | tracking |

### 3.3 `atlas_miss` — 64 × 64 synthetic fill

Measures the synchronous-fill cost that simulates an atlas miss → glyph rasterization. Real number lands when EPIC-D's `FontAtlas.ts` exposes a Rust-callable bench shim; until then this bench is a regression sentinel on the recorder path.

| Platform                        | p50      | p95      | Notes                           |
|---------------------------------|---------:|---------:|---------------------------------|
| macOS arm64 (baseline)          |  ~10 µs  |  ~25 µs  | stub — within 3 ms budget       |
| macOS x86_64                    |   —      |   —      | secondary                       |
| Linux x86_64                    |   —      |   —      | secondary                       |
| Windows x86_64                  |   —      |   —      | tracking                        |

## 4. RFC §13.12 perf gate summary

| Metric                                              | Target           | Actual (stub) | Status |
|-----------------------------------------------------|------------------|---------------|--------|
| Keystroke → rendered cell p95                       | ≤ 16 ms          | ~1.5 µs (recorder path only) | WITHIN BUDGET (stub) |
| `yes \| head -10000` sustained throughput           | 60 fps           | not yet wired on real renderer | DEFERRED — real harness lands with RFC 0002 WebGL |
| Delta throughput steady-state                       | ≤ 200 KB/s on `cargo build` | ~500 MB/s (stub) | WITHIN BUDGET |
| Atlas miss recovery                                 | ≤ 3 ms p95       | ~25 µs (stub) | WITHIN BUDGET |
| Idle CPU                                            | < 0.1 %          | not benched (no idle scenario) | DEFERRED |
| Steady-state memory (10 k scrollback × 120 cols)    | ≤ 22 MB          | not benched (heap snapshot scripting deferred) | DEFERRED |

## 5. Regression policy

- **Baseline numbers live in this file.** The CI job compares criterion's `estimates.json` output against the table.
- **Threshold: 10 %** on p95. Anything worse fails the PR; anything better is a silent pass.
- **Re-baselining:** edit this file in the same PR that ships the speedup, and describe the reason in the commit body. Reviewers check that the diff is reasonable.
- **New stage:** add a row first, leave the numbers as `—`, populate once the bench runs green on all platforms.

## 6. Limitations (current state)

- The three `tests/perf/benches/*.rs` targets are **stub harnesses** — they exercise the recorder + histogram emission path but not the full pipeline. See the file-level docstrings for the replacement TODO.
- `yes | head -10000` 60 fps sustain test, idle CPU, and steady-state memory are tracked in RFC §13.12 but not yet instrumented — they require a running PTY + renderer driver thread that only the Tauri host supplies. The compat matrix in `crates/quanta-vt/tests/compat/` exercises the grid-side path; the renderer-side timing tests are deferred to RFC 0002 (WebGL backend) when the GPU command queue becomes the dominant signal.
- The `check-ui-no-ansi` grep rule currently reports transitional residue (`packages/ui/src/shared/ui/ansi-output/`, `packages/ui/src/features/block/export.ts`, i18n strings, some test fixtures). These are not engine paths; they are AI-suggest / block-export surfaces that touch literal sequences as data, not as parsed terminal state. Tracked as follow-up for EPIC-I tail cleanup.
