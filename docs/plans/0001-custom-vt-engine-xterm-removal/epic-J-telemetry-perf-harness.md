# EPIC-J — Telemetry + Perf Harness (cross-cutting) — Detailed Plan

- **Status**: Planning (cross-cutting, Phase 0 → Phase 5 rolling; spec-ready
  from day 1).
- **Date**: 2026-04-19
- **Scope owner**: EPIC-J planning agent.
- **Implements**: RFC 0001 v4 §13.12 (performance gate), §13.13 (performance
  budget decomposition), §13.14 (telemetry — exact counter list), §9.5
  (telemetry-visible ordering errors), §10.3 (IME telemetry), §14.2 (debug
  tools), §16 BAN #4 (no full-snapshot per tick — this epic provides the
  alarm), §22 failure modes #15, #16, #17, #18, #19, #20 (telemetry is the
  drift detector).
- **Freezes**: metric name constants in `crates/quanta-metrics/src/names.rs`
  (already partially exists), `PerfStage` enum in
  `crates/quanta-metrics/src/stage.rs` (already partially exists), perf-harness
  fixture layout under `tests/perf/`, baseline doc format in
  `docs/perf-baselines.md`.
- **Out-of-scope**: the counters' _semantics_ (owned by each implementation
  epic — e.g., EPIC-B decides when `vt.unknown_csi_count` increments). This
  epic owns the _schema_, the _emission wiring_, the _histogram shape_, the
  _harness_, and the _CI gate_.
- **No-touch per parallel-agent brief**: `crates/quanta-vt-width/` (EPIC-A
  implementation) and `crates/quanta-metrics/` low-level primitives (the
  crate is shared; EPIC-J extends `names.rs` and `stage.rs` but other
  implementation agents own the _call sites_ inside their crates).

This plan is the testable contract EPIC-J implementation will be held to.
Every Definition-of-Done item maps to a specific metric constant, a specific
benchmark fixture, or a specific CI job.

---

## 1. Summary

**Goal**. Build the observability + perf-regression safety net that RFC §19
uses as a kickoff input. Specifically:

1. Every counter / histogram / gauge enumerated in RFC §13.14 is declared
   once in `crates/quanta-metrics/src/names.rs`, wired through the recorder
   port, and emitted from real call sites in every hot-path crate.
2. Every stage in RFC §13.13 is measurable independently via
   `quanta_metrics::stage::record_stage(PerfStage::X, dur)`, with budgets
   matching §13.12 and per-stage decomposition matching §13.13.
3. A `tests/perf/` harness runs criterion-style benches against five
   documented workloads (keystroke latency, delta throughput, atlas miss,
   scroll-region heavy TUI, line-oriented shell output) and produces a
   JSON report consumed by `.github/workflows/perf.yml`.
4. `docs/perf-baselines.md` records the committed baseline per platform
   (macOS arm64 + Linux x86_64) with explicit update-rules.
5. `perf.yml` fails CI on > 10% regression against the baseline on any
   PR that touches hot-path files (path-filter driven).
6. `quanta-replay dump-metrics` produces a JSON dump that round-trips
   through serde and is the dogfood evidence for §19.13.

**Phase / Duration**. Phase 0 → Phase 5, rolling. ~1 week of total work
distributed over the project's wall-clock as hooks become available.

**Dependencies**. Each hot-path landing is a dependency for its own
instrumentation — EPIC-B for engine counters, EPIC-C for reducer counters,
EPIC-D for renderer counters, EPIC-E for input / IME counters, EPIC-F for
actor counters. The planning + schema freeze happens Day 1; the wiring
happens as each epic lands.

**Owner**. EPIC-J implementation agent. Works in close coordination with
the implementation agents of B, C, D, E, F as each lands a hook surface.

---

## 2. Background & motivation

### 2.1 The wild-regression problem

RFC §16 BAN #4 says "full snapshot per tick = 30% idle CPU shipped." We have
code-level reviews that try to catch this, but the deterministic safety net
is a counter (`vt.full_redraw_frequency`) plus an alarm (rate trending
upward = P1) plus a CI workload (`yes | head -10000` through the engine →
assert snapshot-fallback count stays at baseline).

This pattern generalizes. Every failure mode in RFC §22 has a telemetry
shape that would have caught it:

| RFC §22 item | Telemetry shape that catches it |
|---|---|
| #15 slow-link > 100ms keystroke | `keystroke → cell p95` histogram |
| #16 GridDelta out-of-order → resync storm | `vt.out_of_order_events_dropped`, `vt.row_resync_requests` counters |
| #17 engine crash mid-alt-screen | `renderer.backend_recovery_events`, degraded-mode banner count |
| #18 sidecar restart mid-composition | `ime.abnormal_termination` counter |
| #19 web font late load → atlas mid-frame invalidation | `renderer.atlas_invalidation_events` counter (new, this epic) |
| #20 selection across wrapped row → copy joined-wrong | `ui.selection_normalization_corrections` histogram |

Without the counters, each of these is discovered by a user with a bug
report. With the counters, the alarm fires in dogfood before users see it.

### 2.2 Why a separate cross-cutting epic

Each implementation epic owns the _semantics_ of its counters (when to
increment, what the bucket layout should be). But the _infrastructure_ is
shared:

- The name constants live in one crate so typos are compile-time errors.
- The `PerfStage` enum is used by every hot-path crate.
- The harness framework, CI job, and baseline-update discipline are one
  system across all epics.

Treating this as a cross-cutting epic prevents duplication (each epic
independently reinventing a metric-name convention) and ensures the RFC
§13.14 list is covered exhaustively rather than per-best-effort.

### 2.3 Why Phase 0 starts

The schema freeze is Phase 0 so that every downstream epic writes its code
against the final metric names + stage enum from day one. Retrofitting
telemetry after the fact is how you end up with two counter-naming
conventions; we avoid that by freezing the schema before implementation
starts.

### 2.4 RFC invariants this realizes

- **I-9 — ordered reducer stream** — this epic provides the telemetry
  signal (`vt.out_of_order_events_dropped`, `vt.stale_epoch_events_dropped`,
  `vt.row_resync_requests`, `vt.full_snapshot_fallbacks`) that makes
  violations visible.
- **§13.12 performance gate** — this epic provides the measurement.
- **§13.13 performance budget decomposition** — this epic provides the
  per-stage histogram + documented budgets.
- **§13.14 telemetry** — this epic is §13.14.

---

## 3. Scope

### 3.1 In-scope files

#### 3.1.1 `crates/quanta-metrics/` additions

- `crates/quanta-metrics/src/names.rs` — canonical `pub const` declarations
  for every counter / histogram / gauge in RFC §13.14. The file already
  has partial content (see the existing `VT_UNKNOWN_CSI_COUNT`,
  `VT_UNKNOWN_OSC_COUNT`, etc.); this epic completes it to exact parity
  with RFC §13.14 plus the names introduced below (§3.2).
- `crates/quanta-metrics/src/stage.rs` — `PerfStage` enum + `record_stage`
  helper. Partially exists; this epic fills in the six-stage enum per
  §13.13 and the budget-annotated doc comment.
- `crates/quanta-metrics/src/domain/mod.rs` — histogram bucket upper
  bounds. Already has `HISTOGRAM_BUCKET_UPPER_BOUNDS`; this epic adds
  specialized ladders where needed (§3.4.3).
- `crates/quanta-metrics/src/ports/mod.rs` — `MetricsRecorder` trait. Keep
  shape; verify `record_counter`, `record_histogram`, `record_gauge` all
  present.
- `crates/quanta-metrics/tests/counter_catalog.rs` (new) — compile-time
  test that every RFC §13.14 counter has a `pub const` in `names.rs`.
  Implementation: a match on a `FROM_RFC_13_14: &[&str]` literal list.
- `crates/quanta-metrics/tests/stage_roundtrip.rs` (new) — records one
  sample per `PerfStage` variant and asserts it surfaces in the recorder
  under the expected name.
- `crates/quanta-metrics/tests/dump_metrics.rs` (new) — covers the
  `quanta-replay dump-metrics` JSON schema.

#### 3.1.2 Hot-path call sites — wiring (rolling, per upstream epic)

Every file below gets `use quanta_metrics::names::*;` + one or more
`record_counter(NAME, 1)` / `record_histogram(NAME, value)` call.

**Engine (EPIC-B surface, wiring owned by EPIC-J)**:
- `crates/quanta-vt/src/adapters/vte_processor.rs` —
  `VT_UNKNOWN_CSI_COUNT`, `VT_UNKNOWN_OSC_COUNT`, `PerfStage::PtyParse`
  timing.
- `crates/quanta-vt/src/domain/grid.rs` — `VT_FULL_REDRAW_FREQUENCY` on
  snapshot emission, `VT_DELTA_SIZE_BYTES` histogram on each delta.

**Protocol / reducer (EPIC-C surface)**:
- `crates/quanta-proto/src/events.rs` — serde schema additions already
  covered in EPIC-C; this epic adds the _metric-emitting_ drop / fence
  paths.
- `packages/ui/src/shared/lib/grid-mirror/GridMirror.ts` —
  `vt.out_of_order_events_dropped`, `vt.stale_epoch_events_dropped`,
  `vt.row_resync_requests`, `vt.full_snapshot_fallbacks`, plus
  `PerfStage::ReducerApply` timing.

**Fanout / actor (EPIC-F surface)**:
- `crates/quanta-core/src/adapters/fanout.rs` — broadcast latency
  histogram `core.fanout_broadcast_us` (added in §3.2).
- `crates/quanta-session/src/adapters/actor.rs` — session-level counters
  (see §3.2 for the `session.*` family).

**Renderer (EPIC-D surface)**:
- `packages/ui/src/shared/ui/cell-renderer/Renderer.ts` —
  `PerfStage::Raster`, `PerfStage::CursorOverlay`, `PerfStage::AtlasMissRecovery`.
- `packages/ui/src/shared/ui/cell-renderer/FontAtlas.ts` —
  `renderer.atlas_invalidation_events` (new name, §3.2).
- `packages/ui/src/shared/ui/cell-renderer/HitTest.ts` —
  `PerfStage::LayoutHitTest`.
- `packages/ui/src/shared/ui/cell-renderer/Selection.ts` —
  `UI_SELECTION_NORMALIZATION_CORRECTIONS` histogram.

**Input / IME (EPIC-E surface)**:
- `packages/ui/src/features/input/KeyEncoder.ts` — keystroke-to-PTY
  latency histogram `input.keystroke_to_pty_us` (new name, §3.2).
- `packages/ui/src/features/input/ime/ImeStateMachine.ts` —
  `IME_LIFECYCLE_START`, `IME_LIFECYCLE_COMMIT`, `IME_LIFECYCLE_CANCEL`,
  `IME_ABNORMAL_TERMINATION`, plus `ime.composition_duration_ms`
  histogram (new, §3.2).

**AI (EPIC stretch surface — quanta-ai)**:
- `crates/quanta-ai/src/adapters/anthropic_provider.rs` —
  `ai.request.latency_ms` histogram (new, §3.2).

#### 3.1.3 Perf harness fixtures (new)

- `tests/perf/Cargo.toml` — new workspace member; criterion + harness deps.
- `tests/perf/benches/keystroke_latency.rs` — feeds a 1-byte PTY write,
  measures time to `GridDelta` emission + time to `ApplyDelta` in a
  mock UI consumer; records as `PerfStage::PtyParse + ReducerApply`.
- `tests/perf/benches/delta_throughput.rs` — feeds `yes | head -10000` PTY
  output, asserts sustained 60 fps (frame time p95 ≤ 16 ms); records
  `PerfStage::PtyParse`, `ReducerApply`, `Raster`.
- `tests/perf/benches/atlas_miss.rs` — generates a workload where each
  line introduces a new grapheme not seen before (CJK rotating corpus);
  measures `PerfStage::AtlasMissRecovery`; asserts p95 ≤ 3 ms.
- `tests/perf/benches/scroll_region_heavy.rs` — replays a `htop -d 1`
  PTY capture; measures `PerfStage::Raster` sustained; asserts no
  `vt.full_snapshot_fallbacks` increments.
- `tests/perf/benches/line_oriented_output.rs` — replays `cargo build`
  output; measures delta size histogram; asserts p95 ≤ 200 KB/s per
  RFC §13.12.
- `tests/perf/fixtures/` — committed PTY captures backing each bench
  (shared with EPIC-G's compat fixtures where sensible, but EPIC-J owns
  the perf-specific captures that EPIC-G does not need).

#### 3.1.4 CI workflow (new)

- `.github/workflows/perf.yml` — path-filtered PR gate. Runs the five
  benches, compares against `docs/perf-baselines.md`, fails on > 10%
  regression in any stage's p95.

#### 3.1.5 Baseline doc (new)

- `docs/perf-baselines.md` — per-platform baseline table. Columns: stage,
  platform, p50, p95, p99. Rows: six `PerfStage` variants + five workload
  p95 totals. Update-rules (§3.4.5) documented in the file itself.

### 3.2 New metric constants this epic introduces

RFC §13.14 enumerates counters; the RFC uses shorthand names. This epic
locks the exact `pub const` identifiers + string names. Names not already
in `names.rs` that this epic adds:

| const | string | kind | RFC §13.14 bullet |
|---|---|---|---|
| `VT_UNKNOWN_CSI_COUNT` | `vt.unknown_csi_count` | counter | "unknown CSI sequences" |
| `VT_UNKNOWN_OSC_COUNT` | `vt.unknown_osc_count` | counter | "unknown OSC codes" |
| `VT_WIDTH_MISMATCH_COUNT` | `vt.width_mismatch_count` | counter | "width-mismatch detections" |
| `VT_FULL_REDRAW_FREQUENCY` | `vt.full_redraw_frequency` | counter | "full-redraw frequency" |
| `VT_DELTA_SIZE_BYTES` | `vt.delta_size_bytes` | histogram (bytes) | "delta size distribution" |
| `VT_OUT_OF_ORDER_EVENTS_DROPPED` | `vt.out_of_order_events_dropped` | counter | "out-of-order events dropped" |
| `VT_STALE_EPOCH_EVENTS_DROPPED` | `vt.stale_epoch_events_dropped` | counter | §9.2 ordering invariants |
| `VT_ROW_RESYNC_REQUESTS` | `vt.row_resync_requests` | counter | "row resync requests" |
| `VT_FULL_SNAPSHOT_FALLBACKS` | `vt.full_snapshot_fallbacks` | counter | "full-snapshot fallbacks" |
| `VT_MODE_NEGOTIATION_CONFLICTS` | `vt.mode_negotiation_conflicts` | counter | "mode-negotiation conflicts" |
| `IME_LIFECYCLE_START` | `ime.lifecycle_start` | counter | "IME lifecycle start" |
| `IME_LIFECYCLE_COMMIT` | `ime.lifecycle_commit` | counter | "IME lifecycle commit" |
| `IME_LIFECYCLE_CANCEL` | `ime.lifecycle_cancel` | counter | "IME lifecycle cancel" |
| `IME_LIFECYCLE_UPDATE` | `ime.lifecycle_update` | counter | "IME lifecycle update-count" |
| `IME_ABNORMAL_TERMINATION` | `ime.abnormal_termination` | counter | "IME overlay abnormal termination" |
| `IME_COMPOSITION_DURATION_MS` | `ime.composition_duration_ms` | histogram (ms) | DoD §5 — new for §10.3 |
| `UI_SELECTION_NORMALIZATION_CORRECTIONS` | `ui.selection_normalization_corrections` | histogram (cells) | "selection normalization corrections" |
| `RENDERER_BACKEND_RECOVERY_EVENTS` | `renderer.backend_recovery_events` | counter | "backend renderer recovery events" |
| `RENDERER_ATLAS_INVALIDATION_EVENTS` | `renderer.atlas_invalidation_events` | counter | new — catches §22 #19 |
| `INPUT_KEYSTROKE_TO_PTY_US` | `input.keystroke_to_pty_us` | histogram (µs) | §13.12 perf gate |
| `CORE_FANOUT_BROADCAST_US` | `core.fanout_broadcast_us` | histogram (µs) | §13.13 budget decomposition — fanout is on the reducer path |
| `SESSION_ACTOR_TICK_US` | `session.actor_tick_us` | histogram (µs) | §13.13 — actor-tick latency |
| `SESSION_PTY_CHUNK_BYTES` | `session.pty_chunk_bytes` | histogram (bytes) | supports §13.14 delta-distribution analysis |
| `AI_REQUEST_LATENCY_MS` | `ai.request.latency_ms` | histogram (ms) | E2E-J5 evidence |

If an existing constant is already in `names.rs`, this epic verifies the
string matches and the doc comment references RFC §13.14. New constants
carry the same doc-comment convention established by the existing file.

### 3.3 Out-of-scope files

- `crates/quanta-metrics/src/adapters/stdout_recorder.rs` and similar —
  existing adapters stay; this epic does not rewrite them.
- `crates/quanta-vt-width/` — EPIC-A surface; no-touch.
- Any call site that belongs to an epic whose implementation has not yet
  landed. Wiring follows the upstream epic's merge. This epic's DoD item
  "every counter is emitted from real code" is measured at the end of
  each relevant phase, not all at once on Day 1.

### 3.4 Design decisions locked by this epic

#### 3.4.1 Name convention

`<subsystem>.<noun>.<verb_or_qualifier>`. Already enforced in existing
`names.rs`; this epic preserves it.

Subsystems this epic uses:
- `vt` — VT engine counters.
- `ime` — IME lifecycle.
- `ui` — UI mirror / selection / search.
- `renderer` — paint-layer observability.
- `input` — keyboard / mouse encoder.
- `core` — fanout, event infrastructure.
- `session` — session actor.
- `ai` — AI provider call latency.

#### 3.4.2 Unit annotations

Every histogram name ends in a unit suffix (`_us`, `_ms`, `_bytes`,
`_cells`). Counter names have no suffix. Gauges (if any) end in the
value's unit. This is a static-analysis aid: you can tell what a metric
records by looking at its name.

#### 3.4.3 Histogram bucket ladders

- Duration histograms (µs, ms) use the default
  `HISTOGRAM_BUCKET_UPPER_BOUNDS` ladder already in `domain/mod.rs` (1 →
  16 M, one per decade-ish).
- `VT_DELTA_SIZE_BYTES` uses a bytes-specific ladder: 0 / 64 / 256 / 1 K /
  4 K / 16 K / 64 K / 256 K / 1 M / 4 M (10 buckets covering the range
  from single-cell deltas to full-screen full-color snapshots).
- `UI_SELECTION_NORMALIZATION_CORRECTIONS` uses a cells ladder: 0 / 1 / 2
  / 4 / 8 / 16 / 64 / 256 (7 buckets; the "how many cells did the UI's
  normalization disagree with canonical" distribution).

Each specialized ladder is declared as a `pub const` in the relevant
domain module.

#### 3.4.4 Stage → name mapping

`PerfStage` maps to histogram names via `stage.rs`:

- `PtyParse` → `perf.pty_parse_us`
- `ReducerApply` → `perf.reducer_apply_us`
- `LayoutHitTest` → `perf.layout_hit_test_us`
- `Raster` → `perf.raster_us`
- `CursorOverlay` → `perf.cursor_overlay_us`
- `AtlasMissRecovery` → `perf.atlas_miss_recovery_us`

The `perf.*` namespace is reserved for budget-decomposition stages.

#### 3.4.5 Baseline update rules

The baseline document lives in `docs/perf-baselines.md` and is
mutable-by-PR. Rules:

1. **Baseline regression** (perf gets worse) is ALWAYS a bug investigation
   before a baseline update. CI red fails the PR.
2. **Baseline improvement** (perf gets better by > 10%) is a baseline
   update PR with written rationale (e.g., "WebGL backend lands in
   RFC 0002 — per-stage Raster budget tightens from 6 ms to 3 ms").
3. **CI-runner changes** (GitHub Actions upgrades macOS arm64 to a newer
   chip revision) trigger a baseline re-capture PR with the runner
   os-version embedded in the table.
4. **Platform additions** (e.g., adding Linux ARM64 when we start
   shipping to that platform) add a column; existing columns stay.

Each update PR updates `docs/perf-baselines.md` as its sole material
change, so baseline shifts are trivially reviewable in git blame.

#### 3.4.6 Path-filter for perf.yml

`perf.yml` runs only on PRs whose diff touches one of:

```yaml
paths:
  - 'crates/quanta-vt/**'
  - 'crates/quanta-vt-width/**'
  - 'crates/quanta-core/**'
  - 'crates/quanta-session/**'
  - 'crates/quanta-proto/**'
  - 'crates/quanta-metrics/**'
  - 'packages/ui/src/shared/lib/grid-mirror/**'
  - 'packages/ui/src/shared/ui/cell-renderer/**'
  - 'packages/ui/src/features/input/**'
  - 'packages/ui/src/widgets/terminal-canvas/**'
  - 'tests/perf/**'
  - 'docs/perf-baselines.md'
  - '.github/workflows/perf.yml'
```

Rationale: perf runs are expensive in CI minutes; gating on hot-path
touches prevents a documentation PR from burning a 10-minute runner.

#### 3.4.7 Regression threshold

10% on p95 per stage. Not p50 (too noisy on CI runners) and not p99 (too
noisy — CI warm-up hit rates vary). 10% is empirically the smallest
threshold that survives GitHub Actions runner variance; tightening it
would cause false-positive flakes and dull the alarm.

Exception: `VT_DELTA_SIZE_BYTES` p95 is gated at +25% (delta size has
bimodal distributions depending on workload, so tighter gates flake).

#### 3.4.8 Local-run parity

`just perf` runs the same harness locally. The justfile target shells out
to `cargo bench -p quanta-perf --bench keystroke_latency`, etc., then
prints the same JSON report `perf.yml` posts to the PR. This is the "no
CI surprises" rule: if perf is red in CI, a local rerun reproduces it.

---

## 4. Design

### 4.1 Counter schema + emission contract

Every counter follows a three-part structure:

1. **Declaration.** A `pub const` in `crates/quanta-metrics/src/names.rs`
   with a doc comment linking RFC §13.14.
2. **Emission.** A single call site (per event) in the owning crate:
   `recorder.record_counter(names::VT_UNKNOWN_CSI_COUNT, 1)`.
3. **Coverage assertion.** The compile-time test in
   `tests/counter_catalog.rs` fails if the const list does not cover the
   RFC §13.14 enumeration.

This is deliberately rigid. The RFC §13.14 list is normative; the Rust
code is authoritative about the _exact_ string form; the declaration +
compile test ensures they stay in lockstep.

### 4.2 Perf stage measurement contract

Each stage is wrapped by a timing scope:

```rust
let start = Instant::now();
// ... work ...
quanta_metrics::stage::record_stage(PerfStage::PtyParse, start.elapsed());
```

In TS, the equivalent is:

```ts
const start = performance.now();
// ... work ...
recordStage('pty_parse', performance.now() - start);
```

The `record_stage` helper is the only place that knows the PerfStage →
metric-name mapping (§3.4.4), so call sites never hand-write the metric
name.

### 4.3 CI gate — perf.yml structure

```
perf.yml
├── matrix: {os: [macos-14, ubuntu-22.04]}
├── steps:
│   ├── checkout
│   ├── install-toolchain (cargo + pnpm)
│   ├── cargo bench -p quanta-perf (all benches)
│   ├── parse criterion output → perf-report.json
│   ├── compare perf-report.json against docs/perf-baselines.md
│   │     (tool: tests/perf/compare.rs)
│   │     → emit diff-report.md
│   ├── upload diff-report.md as PR comment
│   └── exit non-zero if any p95 regression > 10%
```

The comparator tool is in `tests/perf/compare.rs` and is exercised by its
own unit test (fed synthetic perf results + synthetic baselines to
verify the failure threshold).

### 4.4 Baseline capture workflow

When the implementation agent lands a change that intentionally shifts
perf:

1. Branch for the baseline update.
2. Run `just perf` locally on a clean runner-equivalent machine.
3. Update `docs/perf-baselines.md` with the new numbers + a commit message
   documenting the rationale.
4. Merge the baseline-update PR alone (not co-mingled with the
   perf-shifting change). Then rebase the perf-shifting change on main;
   its `perf.yml` run now passes against the updated baseline.

This two-PR dance is deliberately annoying. It prevents the anti-pattern
"I regressed perf so I updated the baseline to match" by forcing the
baseline update to land as its own reviewable commit.

### 4.5 Unknown-CSI storm alarm

`VT_UNKNOWN_CSI_COUNT` is a counter. Its storm alarm is a rolling rate:
if > 10 / minute sustained over a 5-minute window during dogfood, open
P1. The rolling-rate helper already exists at
`crates/quanta-metrics/src/rolling_rate.rs` — this epic adds the alarm
configuration, not the mechanism.

Other counters with storm alarms:
- `VT_FULL_REDRAW_FREQUENCY`: > 3 / minute → P1 (RFC §9.5).
- `VT_MODE_NEGOTIATION_CONFLICTS`: > 0 sustained over 1 minute → P1.
- `IME_ABNORMAL_TERMINATION`: > 0 in dogfood → P1 investigation.
- `VT_STALE_EPOCH_EVENTS_DROPPED`: > 5 / minute sustained → P1.

Storm alarms are documented in `crates/quanta-metrics/src/lib.rs` module
docs alongside each name's declaration.

### 4.6 `quanta-replay dump-metrics` surface

Per RFC §14.2 debug tools. The command dumps a JSON snapshot of every
counter / histogram / gauge at invocation time. Schema:

```json
{
  "counters": {
    "vt.unknown_csi_count": 17,
    "vt.full_redraw_frequency": 3,
    ...
  },
  "histograms": {
    "vt.delta_size_bytes": {
      "buckets": [{"upper": 64, "count": 1240}, ...],
      "sum": 89310,
      "count": 3102,
      "p50": 32,
      "p95": 768,
      "p99": 4096
    },
    ...
  },
  "gauges": {
    "session.active_count": 2
  }
}
```

This is the evidence format for RFC §19.13 "Telemetry healthy."

### 4.7 Histogram surfacing for dashboards

Dogfood dashboards (not part of this epic's CI artifacts but consumed by
the same JSON dump) present:

- `VT_DELTA_SIZE_BYTES` distribution — a sanity check that steady-state
  stays in small-bucket range, with a visible hump on resize / reconnect.
- `IME_COMPOSITION_DURATION_MS` distribution — an alarm shape if the p95
  shifts over time (IME getting slower).
- Per-stage `perf.*_us` distributions — the per-frame budget check.

Dashboard wiring is not part of this epic (operational; lives outside
the repo). The JSON dump is the contract; what the dashboards do with it
is separate.

### 4.8 Instrumentation vs behavior

Telemetry is additive: adding a counter never changes program behavior.
The only observable effect is a slightly slower emit path (one
`recorder.record_counter` call per event). We assert this with a
benchmark (`tests/perf/benches/metric_overhead.rs` — a micro-bench of
`record_counter` alone) and a rule: telemetry overhead MUST be
< 500 ns per call on baseline. If the recorder adapter gets slower than
that, the adapter is wrong; the call sites are fine.

---

## 5. Definition of Done (DoD)

Every item testable. Minimum 25 — this list has 32.

### 5.1 Schema freeze (Phase 0)

- [ ] **J-DoD-01.** Every counter in RFC §13.14 has a `pub const` in
  `crates/quanta-metrics/src/names.rs`.
- [ ] **J-DoD-02.** `crates/quanta-metrics/tests/counter_catalog.rs`
  passes — the coverage test that enumerates RFC §13.14 names and
  asserts each has a const.
- [ ] **J-DoD-03.** Every const's doc comment references the RFC §13.14
  bullet it implements.
- [ ] **J-DoD-04.** Name convention (§3.4.1) followed for every new
  constant.
- [ ] **J-DoD-05.** Unit-suffix convention (§3.4.2) followed for every
  histogram.
- [ ] **J-DoD-06.** `PerfStage` enum in `stage.rs` has exactly six
  variants matching RFC §13.13.
- [ ] **J-DoD-07.** `record_stage` helper writes to the
  `perf.*_us` namespace per §3.4.4; unit test
  `stage_roundtrip.rs` covers each variant.
- [ ] **J-DoD-08.** `HISTOGRAM_BUCKET_UPPER_BOUNDS` + specialized ladders
  per §3.4.3 committed.

### 5.2 Wiring (Phase 1-4, rolling)

- [ ] **J-DoD-09.** `vt.unknown_csi_count`, `vt.unknown_osc_count`
  emitted from `crates/quanta-vt/src/adapters/vte_processor.rs` on
  every unknown dispatch.
- [ ] **J-DoD-10.** `vt.full_redraw_frequency`, `vt.delta_size_bytes`
  emitted from `crates/quanta-vt/src/domain/grid.rs`.
- [ ] **J-DoD-11.** `vt.out_of_order_events_dropped`,
  `vt.stale_epoch_events_dropped`, `vt.row_resync_requests`,
  `vt.full_snapshot_fallbacks` emitted from
  `packages/ui/src/shared/lib/grid-mirror/GridMirror.ts`.
- [ ] **J-DoD-12.** `vt.mode_negotiation_conflicts` emitted from
  `crates/quanta-vt/src/domain/mode_state.rs` on conflict.
- [ ] **J-DoD-13.** `vt.width_mismatch_count` emitted from the UI mirror
  when its width disagrees with the engine's delta.
- [ ] **J-DoD-14.** IME lifecycle counters (`ime.lifecycle_start|update|commit|cancel`,
  `ime.abnormal_termination`, `ime.composition_duration_ms`) emitted
  from `packages/ui/src/features/input/ime/ImeStateMachine.ts`.
- [ ] **J-DoD-15.** `ui.selection_normalization_corrections` emitted
  from `packages/ui/src/shared/ui/cell-renderer/Selection.ts`.
- [ ] **J-DoD-16.** `renderer.backend_recovery_events` emitted from the
  renderer backend on atlas rebuild / context restore.
- [ ] **J-DoD-17.** `renderer.atlas_invalidation_events` emitted from
  `FontAtlas.ts` on DPR / theme / font-family / late-load
  invalidation.
- [ ] **J-DoD-18.** `input.keystroke_to_pty_us` emitted end-to-end from
  KeyEncoder → PTY-write transport.
- [ ] **J-DoD-19.** `core.fanout_broadcast_us` emitted from
  `crates/quanta-core/src/adapters/fanout.rs`.
- [ ] **J-DoD-20.** `session.actor_tick_us`, `session.pty_chunk_bytes`
  emitted from `crates/quanta-session/src/adapters/actor.rs`.
- [ ] **J-DoD-21.** `ai.request.latency_ms` emitted from
  `crates/quanta-ai/src/adapters/anthropic_provider.rs`.
- [ ] **J-DoD-22.** Every `PerfStage` variant is emitted from at least
  one call site (verified by a search-in-repo integration test).

### 5.3 Harness + benches

- [ ] **J-DoD-23.** `tests/perf/` workspace member compiles; `cargo
  bench -p quanta-perf` runs all five benches.
- [ ] **J-DoD-24.** `keystroke_latency.rs` passes p95 ≤ 16 ms on
  baseline (RFC §13.12).
- [ ] **J-DoD-25.** `delta_throughput.rs` sustains 60 fps on `yes | head
  -10000` workload.
- [ ] **J-DoD-26.** `atlas_miss.rs` asserts p95 ≤ 3 ms for
  `PerfStage::AtlasMissRecovery`.
- [ ] **J-DoD-27.** `scroll_region_heavy.rs` records zero
  `vt.full_snapshot_fallbacks` over the htop workload.
- [ ] **J-DoD-28.** `line_oriented_output.rs` asserts `cargo build`
  output steady delta ≤ 200 KB/s per RFC §13.12.

### 5.4 CI + baseline

- [ ] **J-DoD-29.** `.github/workflows/perf.yml` exists; path-filter
  per §3.4.6; runs on macOS-14 + ubuntu-22.04.
- [ ] **J-DoD-30.** `perf.yml` fails on > 10% p95 regression (verified
  by the synthetic-regression E2E, §7.7).
- [ ] **J-DoD-31.** `docs/perf-baselines.md` committed with baselines
  for both platforms and all six stages + five workload totals.
- [ ] **J-DoD-32.** `quanta-replay dump-metrics` emits valid JSON
  round-trippable through serde (test
  `crates/quanta-metrics/tests/dump_metrics.rs`).

### 5.5 Storm alarms

- [ ] **J-DoD-33.** Storm-alarm thresholds (§4.5) documented in
  `crates/quanta-metrics/src/lib.rs` module docs adjacent to each
  counter declaration.

---

## 6. Quality gates

| Gate | Check | Run when | Fail response |
|---|---|---|---|
| Counter catalog | every RFC §13.14 name has a const | Every PR touching `names.rs` | Add missing const; update doc |
| Stage catalog | every `PerfStage` variant has a call site | Every PR touching hot-path files | Add emission or justify omission in PR |
| Unit-suffix lint | histogram names end in `_us`/`_ms`/`_bytes`/`_cells` | PR review | Rename const |
| Perf gate — p95 regression | per-stage p95 within 110% of baseline | Every PR touching hot-path paths | Fail PR; either fix regression or update baseline in separate PR |
| Perf gate — delta size | `vt.delta_size_bytes` p95 within 125% of baseline | Same as above | Same as above |
| Metric overhead | `record_counter` call < 500 ns on baseline | Quarterly run of `metric_overhead.rs` | Investigate recorder adapter |
| Dump-metrics round-trip | JSON deserializes back to identical maps | Every PR touching `names.rs` or dump code | Fix serde |
| Storm alarm documentation | each alarm has rate + window documented | PR review on `lib.rs` | Add docs |
| Path filter | `perf.yml` runs iff hot-path touched | Every PR | Adjust filter if over/under-triggering |
| Baseline freshness | baseline doc last updated within 90 days OR rationale recorded | Quarterly review | Re-capture baseline |

---

## 7. E2E scenarios

Minimum 6. This epic has 7 because the CI synthetic-regression case
(E2E-J7) is how we verify the gate itself works.

### 7.1 E2E-J1 — `yes | head -10000` sustained 60 fps

**Goal**. Line-oriented output at high throughput stays within frame
budget.

**Steps**.
1. Start a session.
2. Run `yes | head -10000` through the PTY.
3. Sample `perf.*_us` histograms throughout.
4. Post-run: compute keystroke-to-cell p95.

**Pass**. p95 ≤ 16 ms. Sustained 60 fps (frame-time p95 ≤ 16.6 ms). No
`vt.full_snapshot_fallbacks` increment.

### 7.2 E2E-J2 — `cargo test -p quanta-session` → no unknown-CSI storm

**Goal**. The quanta-session integration tests don't trigger any
`vt.unknown_csi_count` increments (would indicate a malformed event in
the test harness).

**Steps**.
1. Clean counter state.
2. Run `cargo test -p quanta-session`.
3. Run `quanta-replay dump-metrics` against the session state.
4. Assert `vt.unknown_csi_count == 0` and
  `vt.unknown_osc_count == 0`.

**Pass**. Both counters at zero after the full test run.

### 7.3 E2E-J3 — Stale-epoch delta injection

**Goal**. `vt.stale_epoch_events_dropped` increments when a stale-epoch
delta is fed. This covers RFC §9.2 ordering invariants.

**Steps**.
1. Open a session; take note of `grid_epoch = E`.
2. Simulate a reconnect that bumps to `E+1`.
3. Inject a delta carrying `grid_epoch = E`.
4. Inspect `vt.stale_epoch_events_dropped`.

**Pass**. Counter incremented by exactly one. Grid state unchanged (RFC
§9.2 "DISCARDED, not best-effort applied"). No UI visible change.

### 7.4 E2E-J4 — Row-revision mismatch → resync + potential snapshot
fallback

**Goal**. Two-step escalation: mismatch → `vt.row_resync_requests` ++;
repeated mismatch → `vt.full_snapshot_fallbacks` ++.

**Steps**.
1. Open a session.
2. Inject a delta referencing a row revision that does not match the
   mirror's local revision.
3. Observe `vt.row_resync_requests` increments.
4. Repeat injection 5 times (exceeds threshold).
5. Observe `vt.full_snapshot_fallbacks` increments.

**Pass**. Both counters increment as specified. UI eventually recovers.
Snapshot-fallback storm threshold alarm fires in logs (§4.5).

### 7.5 E2E-J5 — AI request latency histogram

**Goal**. Mock an Anthropic AI request; verify
`ai.request.latency_ms` records a bucketed sample.

**Steps**.
1. Configure mock provider (deterministic 150 ms response).
2. Issue a single suggest call.
3. `quanta-replay dump-metrics`.
4. Assert `ai.request.latency_ms` histogram has count=1 and the sample
   falls in the 100-250 ms bucket.

**Pass**. Histogram records per assertion.

### 7.6 E2E-J6 — `quanta-replay dump-metrics` JSON round-trip

**Goal**. Serialize and deserialize the metrics dump; assert structural
equality.

**Steps**.
1. Generate a non-trivial metric state (run an integration test that
   increments several counters + histograms).
2. `quanta-replay dump-metrics > /tmp/dump.json`.
3. Deserialize /tmp/dump.json via serde in the test harness.
4. Re-serialize back to JSON.
5. Byte-compare to original (modulo key ordering — use a sorted-map
   compare).

**Pass**. Round-trip is lossless.

### 7.7 E2E-J7 — Synthetic perf regression

**Goal**. Verify `perf.yml` actually fails when a regression is
introduced (the "test the gate" case).

**Steps**.
1. Open a branch.
2. Add an artificial `std::thread::sleep(Duration::from_millis(5))` to
   `Grid::feed`'s hot path.
3. Push.
4. Observe `perf.yml` fails with a regression report pointing at
   `perf.pty_parse_us` p95.
5. Revert the synthetic regression.
6. Re-push; `perf.yml` passes.

**Pass**. Gate correctly identifies the regression. Revert restores
green.

### 7.8 E2E-J8 — IME abnormal-termination counter

**Goal**. Focus-out during composition bumps
`ime.abnormal_termination`.

**Steps**.
1. Set macOS to Korean 2-set input.
2. Open a session.
3. Start typing a Korean grapheme (press `g`, `k` with the IME active —
   preedit overlay shows `가`).
4. Without pressing space (no commit), click outside the terminal to
   take focus away.
5. `quanta-replay dump-metrics`.
6. Assert `ime.abnormal_termination` incremented by 1.

**Pass**. Counter increments. No partial PTY bytes emitted (verified
via session-level PTY write log).

---

## 8. Test deliverables

### 8.1 Unit tests in `crates/quanta-metrics/tests/`

- `counter_catalog.rs` — coverage assertion over RFC §13.14 list.
- `stage_roundtrip.rs` — every `PerfStage` variant records correctly.
- `dump_metrics.rs` — JSON schema + round-trip.
- `histogram_buckets.rs` — each specialized ladder has the documented
  bucket count + bounds.

### 8.2 Integration tests

- `tests/integration/tests/metric_emission.rs` — spin up a mock session,
  feed synthetic PTY bytes, assert each of the `vt.*` counters
  increments per contract.
- `packages/ui/src/shared/lib/grid-mirror/__tests__/metrics.test.ts` —
  resync / stale-epoch / full-snapshot-fallback counters.
- `packages/ui/src/features/input/ime/__tests__/metrics.test.ts` — IME
  lifecycle counters.

### 8.3 Perf fixtures

- `tests/perf/fixtures/pty_captures/yes_10k.pty` — recorded via `script(1)`.
- `tests/perf/fixtures/pty_captures/htop_30s.pty` — scroll-region-heavy.
- `tests/perf/fixtures/pty_captures/cargo_build.pty` — line-oriented.
- `tests/perf/fixtures/pty_captures/cjk_rotating.pty` — atlas-miss
  workload (synthetic corpus).
- `tests/perf/fixtures/pty_captures/README.md` — how to regenerate.

### 8.4 Documentation

- `docs/perf-baselines.md` — baseline numbers + update rules (§3.4.5).
- Inline doc in `crates/quanta-metrics/src/lib.rs` — storm-alarm
  thresholds (§4.5).

---

## 9. Failure modes retired

Indirect retirement — telemetry catches drift in dogfood before it
becomes user-visible. Explicit mappings:

- RFC §22 #15 (ssh slow link > 100ms keystroke) —
  `input.keystroke_to_pty_us` + `perf.raster_us` histograms catch the
  latency class.
- RFC §22 #16 (GridDelta out-of-order → resync storm) —
  `vt.out_of_order_events_dropped`, `vt.row_resync_requests`,
  `vt.full_snapshot_fallbacks` counters + storm alarms.
- RFC §22 #17 (engine crash mid-alt-screen) —
  `renderer.backend_recovery_events` + the separate degraded-mode
  counter EPIC-H owns.
- RFC §22 #18 (sidecar restart mid-composition) —
  `ime.abnormal_termination` counter + EPIC-E's recovery path.
- RFC §22 #19 (web font late load → atlas mid-frame invalidation) —
  `renderer.atlas_invalidation_events`.
- RFC §22 #20 (selection across wrapped row → wrong substring) —
  `ui.selection_normalization_corrections` histogram.

Plus the RFC §16 BAN #4 (full snapshot per tick) alarm —
`vt.full_redraw_frequency` storm detection.

---

## 10. Risks

### 10.1 CI perf runner variance

**Likelihood**. High.
**Impact**. Medium — flaky gates dull the alarm.
**Mitigation**. 10% p95 threshold (§3.4.7) was chosen empirically to
survive runner variance. Warm-up laps before measurement. Delta-size
histogram uses a looser 25% threshold because it's bimodal.

### 10.2 CI time budget blows up

**Likelihood**. Medium.
**Impact**. Medium — perf runs cost CI minutes.
**Mitigation**. Path-filter (§3.4.6) so only hot-path PRs trigger.
Benches are criterion's small-sample variants; each bench completes in
< 2 minutes. Total runner time budget per PR is ~10 minutes.

### 10.3 Baseline drift from unrelated runner upgrades

**Likelihood**. Low but inevitable.
**Impact**. High — causes a false-positive regression wave.
**Mitigation**. `docs/perf-baselines.md` records the runner OS version
per row; GitHub Actions runner image upgrades trigger a baseline
re-capture PR (§3.4.5 rule 3). Release notes on runner images are
checked quarterly.

### 10.4 Counter namespace collision

**Likelihood**. Low.
**Impact**. Low — mostly cosmetic.
**Mitigation**. Subsystem prefix (§3.4.1) + compile-time catalog
coverage.

### 10.5 Telemetry overhead becomes perf bug

**Likelihood**. Low.
**Impact**. Medium — would manifest as a silent perf regression across
ALL stages.
**Mitigation**. `metric_overhead.rs` micro-bench (§4.8); 500 ns
ceiling.

### 10.6 Missing counters — RFC §13.14 grows, code misses

**Likelihood**. Medium (RFC is a living document).
**Impact**. Medium — silent gap in observability.
**Mitigation**. `counter_catalog.rs` coverage test (§5.1 J-DoD-02) lists
every RFC §13.14 name as a literal; adding a counter to the RFC without
adding a const fails the test.

### 10.7 Storm-alarm fatigue

**Likelihood**. Medium.
**Impact**. Medium — if alarms fire too often they get ignored.
**Mitigation**. Alarm thresholds are conservative (§4.5); each alarm
documents its window + rate; any false-alarm experience is followed by
a tuning PR with the rationale in the commit message.

---

## 11. Rollback

Telemetry is additive; there is no behavior to roll back. Specific
reversibility:

### 11.1 Perf-harness CI rollback

If `perf.yml` starts blowing the CI budget, the fallback is:
1. Disable the `paths` path-filter, replacing it with a manual
   `workflow_dispatch` trigger.
2. Document the move in `.github/workflows/perf.yml`'s header comment.
3. The perf gate becomes an opt-in PR check; regressions are caught at
   release-cut time instead of PR time. This is a strict downgrade; use
   only if CI budget is the blocker.

### 11.2 Counter rollback

If a counter is emitting garbage (e.g., a unit mismatch wasn't caught
in review), the specific fix is to correct the call site; the _const
declaration_ stays to avoid cross-repo grep churn.

### 11.3 Baseline rollback

If a baseline-update PR turns out wrong, a follow-up PR restores the
prior baseline row. The baseline doc is small + text-only, so a git
revert is sufficient.

---

## 12. Cross-references

### 12.1 RFC 0001 sections

- **§9.5** — telemetry-visible ordering errors; where
  `vt.out_of_order_events_dropped` + friends come from.
- **§10.3** — IME telemetry.
- **§13.12** — perf gate numbers.
- **§13.13** — per-stage budget decomposition.
- **§13.14** — the exact counter list this epic implements.
- **§14.2** — debug tools (`dump-metrics`, `dump-grid`).
- **§16 BAN #4** — "no full snapshot per tick" — this epic's
  `vt.full_redraw_frequency` alarm enforces.
- **§19** — `perf.yml` + dump-metrics output are inputs to the removal
  gate (EPIC-I).
- **§22** — telemetry-retired failure modes (§9 of this plan).

### 12.2 Related ADRs

- **ADR 0017** (reducer ordering + mode authority) — the counters
  reflect the ordering invariants there.
- **ADR 0018** (IME state machine) — IME lifecycle counters reflect
  the state transitions there.

### 12.3 Related epics

- **EPIC-B** — provides engine call sites for `vt.*` counters.
- **EPIC-C** — provides mirror + reducer call sites.
- **EPIC-D** — provides renderer + selection call sites.
- **EPIC-E** — provides input + IME call sites.
- **EPIC-F** — provides actor call sites.
- **EPIC-H** — provides degraded-mode + backend-recovery call sites.
- **EPIC-I** — consumes the perf harness + dump-metrics as §19 gate
  evidence.
- **EPIC-K** — owns the `perf.yml` workflow plumbing; this epic owns the
  content.

### 12.4 Related crates / files

- `crates/quanta-metrics/` — the shared crate.
- `tests/perf/` — the harness this epic builds.
- `docs/perf-baselines.md` — the baseline record.

---

## 13. Work breakdown

### 13.1 Phase 0 — schema freeze + baseline-doc template

Tasks:
- Complete `names.rs` with every RFC §13.14 const.
- Complete `stage.rs` with every `PerfStage` variant.
- Write `counter_catalog.rs` coverage test.
- Draft `docs/perf-baselines.md` with empty table + update rules.
- Draft `.github/workflows/perf.yml` skeleton (no comparator yet).

Output: consts + stage enum + coverage test green; baseline doc
committed with "Awaiting baseline capture — Phase 4" banners.

### 13.2 Phase 1 — engine counter wiring (follows EPIC-B merge)

Tasks:
- Wire `vt.unknown_csi_count`, `vt.unknown_osc_count`,
  `vt.full_redraw_frequency`, `vt.delta_size_bytes`,
  `vt.mode_negotiation_conflicts`.
- Wire `PerfStage::PtyParse` around `VteProcessor::advance`.
- Unit tests per counter.

### 13.3 Phase 2 — protocol + renderer counter wiring (follows EPIC-C + EPIC-D merges)

Tasks:
- Wire reducer counters: `vt.out_of_order_events_dropped`,
  `vt.stale_epoch_events_dropped`, `vt.row_resync_requests`,
  `vt.full_snapshot_fallbacks`, `vt.width_mismatch_count`.
- Wire renderer counters + stages:
  `renderer.backend_recovery_events`,
  `renderer.atlas_invalidation_events`, `PerfStage::Raster`,
  `PerfStage::CursorOverlay`, `PerfStage::LayoutHitTest`,
  `PerfStage::AtlasMissRecovery`.
- Wire `ui.selection_normalization_corrections`.
- Ship first four perf benches (keystroke, delta throughput,
  atlas miss, line-oriented).

### 13.4 Phase 3 — input + IME wiring (follows EPIC-E merge)

Tasks:
- Wire IME lifecycle counters + `ime.composition_duration_ms`.
- Wire `input.keystroke_to_pty_us` end-to-end.
- Ship `scroll_region_heavy.rs` bench (needs EPIC-E scrolling).
- Wire `ai.request.latency_ms`.

### 13.5 Phase 4 — baseline capture + storm alarms

Tasks:
- Run benches on macOS-14 + ubuntu-22.04; record numbers in
  `perf-baselines.md`.
- Complete storm-alarm documentation in `lib.rs`.
- Activate `perf.yml` comparator.

### 13.6 Phase 5 — final integration + CI enablement

Tasks:
- Run `quanta-replay dump-metrics` against a full-workload
  integration test; validate JSON round-trip.
- Final wiring audit: every RFC §13.14 counter has at least one
  emission call site in production code (J-DoD-09 through J-DoD-22
  all green).
- `perf.yml` set to required PR check.
- This epic's exit: EPIC-I's §19.11 + §19.12 + §19.13 rows flip to
  TRUE on evidence.

---

## 14. Appendix — full RFC §13.14 → const name cross-reference

Paste-ready reference for the implementation agent.

| RFC §13.14 bullet | `const` | string |
|---|---|---|
| "Counter: unknown CSI sequences" | `VT_UNKNOWN_CSI_COUNT` | `vt.unknown_csi_count` |
| "Counter: unknown OSC codes" | `VT_UNKNOWN_OSC_COUNT` | `vt.unknown_osc_count` |
| "Counter: width-mismatch detections" | `VT_WIDTH_MISMATCH_COUNT` | `vt.width_mismatch_count` |
| "Counter: full-redraw (snapshot) frequency" | `VT_FULL_REDRAW_FREQUENCY` | `vt.full_redraw_frequency` |
| "Histogram: delta size distribution" | `VT_DELTA_SIZE_BYTES` | `vt.delta_size_bytes` |
| "Counter: out-of-order events dropped" | `VT_OUT_OF_ORDER_EVENTS_DROPPED` | `vt.out_of_order_events_dropped` |
| "Counter: row resync requests" | `VT_ROW_RESYNC_REQUESTS` | `vt.row_resync_requests` |
| "Counter: full-snapshot fallbacks" | `VT_FULL_SNAPSHOT_FALLBACKS` | `vt.full_snapshot_fallbacks` |
| "Histogram: selection normalization corrections" | `UI_SELECTION_NORMALIZATION_CORRECTIONS` | `ui.selection_normalization_corrections` |
| "Counter: IME overlay abnormal termination" | `IME_ABNORMAL_TERMINATION` | `ime.abnormal_termination` |
| "Counter: mode-negotiation conflicts" | `VT_MODE_NEGOTIATION_CONFLICTS` | `vt.mode_negotiation_conflicts` |
| "Counter: backend renderer recovery events" | `RENDERER_BACKEND_RECOVERY_EVENTS` | `renderer.backend_recovery_events` |
| "IME lifecycle traces: start / update-count / commit / cancel" | `IME_LIFECYCLE_START`, `IME_LIFECYCLE_UPDATE`, `IME_LIFECYCLE_COMMIT`, `IME_LIFECYCLE_CANCEL` | `ime.lifecycle_start`, `ime.lifecycle_update`, `ime.lifecycle_commit`, `ime.lifecycle_cancel` |
| implied by §9.2 ordering | `VT_STALE_EPOCH_EVENTS_DROPPED` | `vt.stale_epoch_events_dropped` |
| added by this epic (caught RFC §22 #19) | `RENDERER_ATLAS_INVALIDATION_EVENTS` | `renderer.atlas_invalidation_events` |
| added by this epic (§10.3) | `IME_COMPOSITION_DURATION_MS` | `ime.composition_duration_ms` |
| added by this epic (§13.12) | `INPUT_KEYSTROKE_TO_PTY_US` | `input.keystroke_to_pty_us` |
| added by this epic (§13.13) | `CORE_FANOUT_BROADCAST_US` | `core.fanout_broadcast_us` |
| added by this epic (§13.13) | `SESSION_ACTOR_TICK_US` | `session.actor_tick_us` |
| added by this epic (supports §13.14) | `SESSION_PTY_CHUNK_BYTES` | `session.pty_chunk_bytes` |
| added by this epic (E2E-J5) | `AI_REQUEST_LATENCY_MS` | `ai.request.latency_ms` |

`PerfStage` emission names:

| `PerfStage` | metric name |
|---|---|
| `PtyParse` | `perf.pty_parse_us` |
| `ReducerApply` | `perf.reducer_apply_us` |
| `LayoutHitTest` | `perf.layout_hit_test_us` |
| `Raster` | `perf.raster_us` |
| `CursorOverlay` | `perf.cursor_overlay_us` |
| `AtlasMissRecovery` | `perf.atlas_miss_recovery_us` |

This table is the single source of truth the implementation agent reads
when adding wiring. If a mismatch appears at runtime, the agent returns
to this table before fixing the call site.
