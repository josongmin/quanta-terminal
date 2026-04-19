# Perf Baselines

Tracked baseline numbers for the perf harness at `tests/perf/`.

> **Update this table when re-baselining.** The CI job at `.github/workflows/perf.yml` reads the numbers below and fails a PR if any stage regresses by more than 10 %. A new baseline PR is the mechanism for intentionally moving a number: change the table, note the reason in the commit body, and the next run on `main` confirms the green state.

## 1. Baseline platform

The p95 column is authoritative on **macOS arm64 (M-series)** per RFC 0001 §13.12. Secondary runners (Linux x86_64) capture regression signal but do not gate against an absolute number — they gate against the delta from their own last-green run.

Hardware class (baseline): Apple M-series, 16 GB, macOS 14+, built in `release` profile with the workspace lint settings.

## 2. Stage budgets (RFC §13.13)

Sum of per-stage p95 budgets = 16 ms (the per-frame target). These are sustain targets, not hard ceilings.

| Stage                 | Metric name                            | Budget (p95) |
|-----------------------|----------------------------------------|-------------:|
| PTY parse             | `perf.stage.pty_parse_us`              | 2 000 µs     |
| Reducer apply         | `perf.stage.reducer_apply_us`          | 3 000 µs     |
| Layout / hit-test     | `perf.stage.layout_hit_test_us`        | 1 000 µs     |
| Raster                | `perf.stage.raster_us`                 | 6 000 µs     |
| Cursor / overlay      | `perf.stage.cursor_overlay_us`         | 1 000 µs     |
| Atlas miss recovery   | `perf.stage.atlas_miss_recovery_us`    | 3 000 µs     |

## 3. Measured baselines

The benches in `tests/perf/benches/` are currently stubs — they exercise a synthetic byte-summing loop, not the real stages. Numbers below are placeholders; replace them when each EPIC lands its real instrumentation.

### 3.1 `keystroke_latency` (reducer_apply stand-in)

| Platform                        | p50      | p95      | p99      | Notes                   |
|---------------------------------|---------:|---------:|---------:|-------------------------|
| macOS arm64 (baseline)          |   —      |   —      |   —      | populated post EPIC-B   |
| macOS x86_64                    |   —      |   —      |   —      | secondary               |
| Linux x86_64 (Ubuntu 22.04)     |   —      |   —      |   —      | secondary               |
| Windows x86_64                  |   —      |   —      |   —      | tracking                |

### 3.2 `delta_throughput` (1 MB apply)

| Platform                        | throughput (MB/s) | p95 apply | Notes |
|---------------------------------|------------------:|----------:|-------|
| macOS arm64 (baseline)          |   —               |   —       | populated post EPIC-C |
| macOS x86_64                    |   —               |   —       | secondary |
| Linux x86_64                    |   —               |   —       | secondary |
| Windows x86_64                  |   —               |   —       | tracking |

### 3.3 `atlas_miss` (64 × 64 synthetic fill)

| Platform                        | p50      | p95      | Notes                   |
|---------------------------------|---------:|---------:|-------------------------|
| macOS arm64 (baseline)          |   —      |   —      | populated post EPIC-D   |
| macOS x86_64                    |   —      |   —      | secondary               |
| Linux x86_64                    |   —      |   —      | secondary               |
| Windows x86_64                  |   —      |   —      | tracking                |

## 4. Regression policy

- **Baseline numbers live in this file.** The CI job compares criterion's `estimates.json` output against the table.
- **Threshold: 10 %** on p95. Anything worse fails the PR; anything better is a silent pass.
- **Re-baselining:** edit this file in the same PR that ships the speedup, and describe the reason in the commit body. Reviewers check that the diff is reasonable.
- **New stage:** add a row first, leave the numbers as `—`, populate once the bench runs green on all platforms.

## 5. Limitations while benches are stubs

Until the real implementations land:

- The perf workflow runs the bench targets but skips the regression comparison (the stub numbers have no signal).
- `keystroke_latency`, `delta_throughput`, `atlas_miss` all measure synthetic work. The budget table above is what we expect; the "measured" tables stay `—`.
- When an EPIC delivers its stage, update the bench, commit a measured number here, and enable the comparison in `perf.yml`.
