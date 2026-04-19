//! Perf budget decomposition (RFC 0001 §13.13).
//!
//! The steady-state frame budget is 16 ms on the baseline platform
//! (M-series macOS). RFC §13.13 decomposes that budget into six
//! named stages, each independently measurable. This module binds
//! each stage to a histogram name so call sites record durations
//! through a single `record_stage` helper instead of remembering the
//! string-name convention.
//!
//! # Budgets
//!
//! Targets are per-frame at 60 fps; each is a slice of the 16 ms total
//! and is a "sustain" target (p95), not a hard ceiling (p100). See
//! `docs/perf-baselines.md` for the tracked table.
//!
//! | Stage                 | p95 target |
//! |-----------------------|-----------:|
//! | `PtyParse`            | 2 ms       |
//! | `ReducerApply`        | 3 ms       |
//! | `LayoutHitTest`       | 1 ms       |
//! | `Raster`              | 6 ms       |
//! | `CursorOverlay`       | 1 ms       |
//! | `AtlasMissRecovery`   | 3 ms       |
//!
//! Sum = 16 ms, matching §13.12's keystroke → cell gate.
//!
//! # Units
//!
//! All durations recorded as microseconds (`u64`). The default
//! histogram bucket ladder (see [`domain::HISTOGRAM_BUCKET_UPPER_BOUNDS`])
//! covers 1 µs → 16 M µs, which is 1 µs → 16 s — more than enough for
//! a per-frame slice without custom buckets. Sub-microsecond
//! measurements round up to 1 via `Duration::as_micros().max(1)` in
//! the helper so the "slept 100 ns" case doesn't collide with "never
//! recorded".
//!
//! [`domain::HISTOGRAM_BUCKET_UPPER_BOUNDS`]: crate::domain::HISTOGRAM_BUCKET_UPPER_BOUNDS

use std::time::Duration;

use crate::ports::MetricsRecorder;

/// One of the six budget stages from RFC §13.13.
///
/// A `PerfStage` maps 1:1 to a histogram name on the recorder. Call
/// sites that measure a stage duration construct one and call
/// [`record_stage`] — they never touch the raw name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PerfStage {
    /// PTY bytes → `vte::Perform` parse. Upper bound ~2 ms p95.
    PtyParse,
    /// Reducer applies a single `GridDelta` / event envelope to the
    /// UI mirror. Upper bound ~3 ms p95.
    ReducerApply,
    /// Layout + hit-test (grapheme → pixel rects, pointer → cell).
    /// Upper bound ~1 ms p95.
    LayoutHitTest,
    /// Raster of the dirty rows this frame. Upper bound ~6 ms p95;
    /// dominates the budget.
    Raster,
    /// Cursor / overlay layer paint (IME overlay, selection overlay).
    /// Upper bound ~1 ms p95.
    CursorOverlay,
    /// Atlas-miss recovery — synchronous glyph rasterization after a
    /// cache miss. Upper bound ~3 ms p95; should be rare.
    AtlasMissRecovery,
}

impl PerfStage {
    /// The canonical histogram name for this stage.
    #[must_use]
    pub const fn metric_name(self) -> &'static str {
        match self {
            Self::PtyParse => "perf.stage.pty_parse_us",
            Self::ReducerApply => "perf.stage.reducer_apply_us",
            Self::LayoutHitTest => "perf.stage.layout_hit_test_us",
            Self::Raster => "perf.stage.raster_us",
            Self::CursorOverlay => "perf.stage.cursor_overlay_us",
            Self::AtlasMissRecovery => "perf.stage.atlas_miss_recovery_us",
        }
    }

    /// The p95 budget for this stage, in microseconds. Informational —
    /// the runtime doesn't gate on this; CI (`tests/perf/`) does.
    #[must_use]
    pub const fn budget_p95_us(self) -> u64 {
        match self {
            Self::PtyParse => 2_000,
            Self::ReducerApply => 3_000,
            Self::LayoutHitTest => 1_000,
            Self::Raster => 6_000,
            Self::CursorOverlay => 1_000,
            Self::AtlasMissRecovery => 3_000,
        }
    }

    /// Every stage in declaration order. Useful for iterating a
    /// snapshot or dumping the budget table.
    #[must_use]
    pub const fn all() -> &'static [Self] {
        &[
            Self::PtyParse,
            Self::ReducerApply,
            Self::LayoutHitTest,
            Self::Raster,
            Self::CursorOverlay,
            Self::AtlasMissRecovery,
        ]
    }
}

/// Record `duration` on the histogram for `stage`. Clamps the minimum
/// observation to 1 µs so a sub-microsecond measurement is
/// distinguishable from an unrecorded stage.
pub fn record_stage<R: MetricsRecorder + ?Sized>(
    recorder: &R,
    stage: PerfStage,
    duration: Duration,
) {
    // `as_micros()` returns `u128`; the histogram takes `u64`. Clamp
    // to `u64::MAX` on the (pathological) overflow case. Clamp the
    // lower bound to 1 so "recorded" > "not recorded".
    let raw = duration.as_micros();
    let clamped: u64 = u64::try_from(raw).unwrap_or(u64::MAX);
    let observation = clamped.max(1);
    recorder.record_histogram(stage.metric_name(), observation);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::InMemoryRecorder;

    #[test]
    fn every_stage_has_a_unique_metric_name() {
        let mut names: Vec<&'static str> =
            PerfStage::all().iter().map(|s| s.metric_name()).collect();
        names.sort_unstable();
        let n = names.len();
        names.dedup();
        assert_eq!(names.len(), n, "stage metric names must be unique");
    }

    #[test]
    fn stage_budgets_sum_to_frame_budget() {
        let total: u64 = PerfStage::all().iter().map(|s| s.budget_p95_us()).sum();
        assert_eq!(
            total, 16_000,
            "sum of stage budgets must equal the 16 ms per-frame budget"
        );
    }

    #[test]
    fn record_stage_writes_observation_to_expected_histogram() {
        let r = InMemoryRecorder::new();
        record_stage(&r, PerfStage::Raster, Duration::from_micros(5_000));
        let snap = r.snapshot();
        let hist = snap
            .histograms
            .iter()
            .find(|(k, _)| k == PerfStage::Raster.metric_name())
            .map(|(_, v)| v.clone())
            .expect("raster histogram must be present");
        assert_eq!(hist.count, 1);
        assert_eq!(hist.sum, 5_000);
    }

    #[test]
    fn record_stage_clamps_sub_microsecond_to_one() {
        let r = InMemoryRecorder::new();
        record_stage(&r, PerfStage::LayoutHitTest, Duration::from_nanos(100));
        let snap = r.snapshot();
        let hist = snap
            .histograms
            .iter()
            .find(|(k, _)| k == PerfStage::LayoutHitTest.metric_name())
            .map(|(_, v)| v.clone())
            .expect("layout histogram must be present");
        assert_eq!(hist.sum, 1, "sub-microsecond observation must clamp to 1");
    }
}
