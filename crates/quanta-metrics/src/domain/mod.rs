//! Pure value types for counters, histograms, gauges, and snapshots.
//!
//! Intentionally no sync primitives — the thread-safe wrapping lives in
//! `adapters/`. These types are the "what" of metrics (shape, buckets,
//! sample counts); the adapter owns the "when and how" (atomics, mutex).

use serde::{Deserialize, Serialize};

/// The fixed bucket ladder for histograms. Power-of-two widths starting at
/// 1, capped at 16_777_216 (~16 M) to cover both latency (µs / ms) and byte
/// counts without custom tuning per call site. 25 buckets is enough for
/// p99s on a typical desktop workload; anything beyond is "too big to
/// usefully bucket" and goes into `+Inf` effectively because we cap at
/// the last bucket.
///
/// When the recorded value exceeds the largest bucket, we increment the
/// last bucket — `+Inf` in Prometheus parlance. Snapshots surface the
/// observation count alongside the bucket array so consumers can detect
/// the overflow.
pub const HISTOGRAM_BUCKET_UPPER_BOUNDS: &[u64] = &[
    1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_024, 2_048, 4_096, 8_192, 16_384, 32_768, 65_536,
    131_072, 262_144, 524_288, 1_048_576, 2_097_152, 4_194_304, 8_388_608, 16_777_216,
];

/// Index of the bucket whose upper bound is >= `value`, or the last bucket
/// when `value` exceeds the largest bound. A small inline binary search
/// keeps the hot path tight.
#[must_use]
pub fn bucket_index(value: u64) -> usize {
    match HISTOGRAM_BUCKET_UPPER_BOUNDS.binary_search(&value) {
        Ok(i) => i,
        Err(i) => i.min(HISTOGRAM_BUCKET_UPPER_BOUNDS.len() - 1),
    }
}

/// A monotonically-non-decreasing `u64`. Adapter wraps it in an `AtomicU64`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counter(pub u64);

/// Serializable snapshot of a counter. Simple wrapper so future fields
/// (last update timestamp, etc.) can be added without breaking consumers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CounterSnapshot {
    pub value: u64,
}

/// Current `i64` value — adapter wraps in `AtomicI64`. Gauges are allowed
/// to go negative so we can represent signed deltas (e.g. "pending tasks").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gauge(pub i64);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GaugeSnapshot {
    pub value: i64,
}

/// A bucketed histogram. The `buckets` array parallels
/// [`HISTOGRAM_BUCKET_UPPER_BOUNDS`] — bucket `i` counts observations whose
/// value fell at or below `HISTOGRAM_BUCKET_UPPER_BOUNDS[i]` (and above the
/// previous bucket's bound, i.e. non-cumulative at the domain level; the
/// snapshot converts to cumulative form for Prometheus-style consumption).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Histogram {
    pub buckets: Vec<u64>,
    pub count: u64,
    pub sum: u64,
}

impl Default for Histogram {
    fn default() -> Self {
        Self {
            buckets: vec![0; HISTOGRAM_BUCKET_UPPER_BOUNDS.len()],
            count: 0,
            sum: 0,
        }
    }
}

impl Histogram {
    /// Construct an empty histogram with the default bucket ladder.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record `value` in the appropriate bucket. Saturating arithmetic —
    /// we'd rather stall at `u64::MAX` than wrap and produce misleading
    /// data downstream.
    pub fn record(&mut self, value: u64) {
        let idx = bucket_index(value);
        // Saturating bucket increment. If a single bucket ever reaches
        // `u64::MAX` we've already lost useful signal, but corrupt wrapping
        // would mislead a consumer more.
        if let Some(slot) = self.buckets.get_mut(idx) {
            *slot = slot.saturating_add(1);
        }
        self.count = self.count.saturating_add(1);
        self.sum = self.sum.saturating_add(value);
    }
}

/// Snapshot-form histogram — same payload as [`Histogram`] plus explicit
/// upper-bound labels so a JSON consumer knows the bucket semantics without
/// referring back to the crate's documentation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistogramSnapshot {
    pub upper_bounds: Vec<u64>,
    pub buckets: Vec<u64>,
    pub count: u64,
    pub sum: u64,
}

impl HistogramSnapshot {
    /// Build a snapshot from a live histogram. Clones the bucket vec; this
    /// is a snapshot-time cost, not a record-time cost.
    #[must_use]
    pub fn from_histogram(h: &Histogram) -> Self {
        Self {
            upper_bounds: HISTOGRAM_BUCKET_UPPER_BOUNDS.to_vec(),
            buckets: h.buckets.clone(),
            count: h.count,
            sum: h.sum,
        }
    }
}

/// All metrics at a point in time. `dump_snapshot()` on the recorder returns
/// this; `serde_json::to_value(&snapshot)` yields a JSON object the replay
/// CLI / future debug UI can render.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetricsSnapshot {
    pub counters: Vec<(String, CounterSnapshot)>,
    pub gauges: Vec<(String, GaugeSnapshot)>,
    pub histograms: Vec<(String, HistogramSnapshot)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_index_maps_boundaries_correctly() {
        // 1 is the first bucket upper bound → index 0.
        assert_eq!(bucket_index(0), 0);
        assert_eq!(bucket_index(1), 0);
        // 2 is bucket 1.
        assert_eq!(bucket_index(2), 1);
        // 5 falls between 4 and 8 → bucket 3.
        assert_eq!(bucket_index(5), 3);
        // Values beyond the last bound saturate at the last bucket.
        assert_eq!(
            bucket_index(u64::MAX),
            HISTOGRAM_BUCKET_UPPER_BOUNDS.len() - 1
        );
    }

    #[test]
    fn histogram_record_updates_count_sum_and_bucket() {
        let mut h = Histogram::new();
        h.record(5);
        assert_eq!(h.count, 1);
        assert_eq!(h.sum, 5);
        assert_eq!(h.buckets[3], 1, "bucket 3 (upper 8) holds the 5");

        h.record(5);
        h.record(1024);
        assert_eq!(h.count, 3);
        assert_eq!(h.sum, 1034);
    }

    #[test]
    fn histogram_snapshot_mirrors_live_data() {
        let mut h = Histogram::new();
        h.record(42);
        let snap = HistogramSnapshot::from_histogram(&h);
        assert_eq!(snap.count, 1);
        assert_eq!(snap.sum, 42);
        assert_eq!(snap.upper_bounds.len(), HISTOGRAM_BUCKET_UPPER_BOUNDS.len());
        assert_eq!(snap.buckets.len(), HISTOGRAM_BUCKET_UPPER_BOUNDS.len());
    }
}
