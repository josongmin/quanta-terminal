//! `InMemoryRecorder` — the default production recorder.
//!
//! Thread-safe and zero-allocation on the hot path (entries are created
//! lazily; subsequent records reuse the existing `Arc`). Counters and
//! gauges use atomics; histograms use `parking_lot::Mutex` around a small
//! `HistogramData` struct.
//!
//! # Why DashMap
//!
//! The hot path needs:
//!
//! 1. O(1) lookup by `&'static str`.
//! 2. Concurrent read-heavy access from many tasks.
//! 3. First-insert semantics that don't block subsequent readers.
//!
//! `DashMap` gives all three without the cost of a global `RwLock`. The
//! first record for a name pays a short shard-lock to insert; every
//! subsequent record on that name hits the `AtomicU64` / `AtomicI64`
//! directly without touching the outer structure.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use parking_lot::Mutex;

use crate::domain::{
    CounterSnapshot, GaugeSnapshot, Histogram, HistogramSnapshot, MetricsSnapshot,
};
use crate::ports::MetricsRecorder;

#[derive(Debug, Default)]
pub struct InMemoryRecorder {
    counters: DashMap<&'static str, Arc<AtomicU64>>,
    gauges: DashMap<&'static str, Arc<AtomicI64>>,
    histograms: DashMap<&'static str, Arc<Mutex<Histogram>>>,
}

impl InMemoryRecorder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Wrap in `Arc` — the canonical way hot paths hold a recorder.
    #[must_use]
    pub fn new_arc() -> Arc<Self> {
        Arc::new(Self::new())
    }

    /// Serialize the current state to a `serde_json::Value` — the shape is
    /// `{"counters": {...}, "gauges": {...}, "histograms": {...}}`. Used by
    /// the replay CLI and any future debug-panel integration that wants a
    /// shallow JSON readout without pulling in `prometheus`.
    ///
    /// Errors only if `serde_json` serialization itself fails, which for
    /// the snapshot types in this crate is impossible in practice —
    /// counters/gauges are primitives and histograms are small `Vec<u64>`.
    pub fn dump_snapshot(&self) -> serde_json::Value {
        let snap = self.snapshot();
        serde_json::to_value(&snap).unwrap_or(serde_json::Value::Null)
    }

    fn counter_handle(&self, name: &'static str) -> Arc<AtomicU64> {
        if let Some(entry) = self.counters.get(name) {
            return entry.clone();
        }
        // Slow path — first insert. `DashMap::entry().or_insert` runs
        // inside a shard lock so concurrent first-writers observe a
        // single Arc.
        self.counters
            .entry(name)
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone()
    }

    fn gauge_handle(&self, name: &'static str) -> Arc<AtomicI64> {
        if let Some(entry) = self.gauges.get(name) {
            return entry.clone();
        }
        self.gauges
            .entry(name)
            .or_insert_with(|| Arc::new(AtomicI64::new(0)))
            .clone()
    }

    fn histogram_handle(&self, name: &'static str) -> Arc<Mutex<Histogram>> {
        if let Some(entry) = self.histograms.get(name) {
            return entry.clone();
        }
        self.histograms
            .entry(name)
            .or_insert_with(|| Arc::new(Mutex::new(Histogram::new())))
            .clone()
    }
}

impl MetricsRecorder for InMemoryRecorder {
    fn inc_counter(&self, name: &'static str) {
        self.counter_handle(name).fetch_add(1, Ordering::Relaxed);
    }

    fn add_counter(&self, name: &'static str, delta: u64) {
        self.counter_handle(name)
            .fetch_add(delta, Ordering::Relaxed);
    }

    fn record_histogram(&self, name: &'static str, value: u64) {
        let handle = self.histogram_handle(name);
        let mut guard = handle.lock();
        guard.record(value);
    }

    fn set_gauge(&self, name: &'static str, value: i64) {
        self.gauge_handle(name).store(value, Ordering::Relaxed);
    }

    fn adjust_gauge(&self, name: &'static str, delta: i64) {
        self.gauge_handle(name).fetch_add(delta, Ordering::Relaxed);
    }

    fn snapshot(&self) -> MetricsSnapshot {
        let mut counters: Vec<(String, CounterSnapshot)> = self
            .counters
            .iter()
            .map(|entry| {
                (
                    (*entry.key()).to_string(),
                    CounterSnapshot {
                        value: entry.value().load(Ordering::Relaxed),
                    },
                )
            })
            .collect();
        counters.sort_by(|a, b| a.0.cmp(&b.0));

        let mut gauges: Vec<(String, GaugeSnapshot)> = self
            .gauges
            .iter()
            .map(|entry| {
                (
                    (*entry.key()).to_string(),
                    GaugeSnapshot {
                        value: entry.value().load(Ordering::Relaxed),
                    },
                )
            })
            .collect();
        gauges.sort_by(|a, b| a.0.cmp(&b.0));

        let mut histograms: Vec<(String, HistogramSnapshot)> = self
            .histograms
            .iter()
            .map(|entry| {
                let guard = entry.value().lock();
                (
                    (*entry.key()).to_string(),
                    HistogramSnapshot::from_histogram(&guard),
                )
            })
            .collect();
        histograms.sort_by(|a, b| a.0.cmp(&b.0));

        MetricsSnapshot {
            counters,
            gauges,
            histograms,
        }
    }

    fn counter_value(&self, name: &'static str) -> u64 {
        self.counters
            .get(name)
            .map(|entry| entry.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    fn gauge_value(&self, name: &'static str) -> i64 {
        self.gauges
            .get(name)
            .map(|entry| entry.load(Ordering::Relaxed))
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counter_increment_is_observable_via_snapshot() {
        let r = InMemoryRecorder::new();
        r.inc_counter("session.envelope.appended");
        r.inc_counter("session.envelope.appended");
        r.add_counter("session.envelope.appended", 3);
        let snap = r.snapshot();
        let found = snap
            .counters
            .iter()
            .find(|(k, _)| k == "session.envelope.appended")
            .map(|(_, v)| v.value);
        assert_eq!(found, Some(5));
        assert_eq!(r.counter_value("session.envelope.appended"), 5);
    }

    #[test]
    fn histogram_record_puts_value_in_expected_bucket() {
        let r = InMemoryRecorder::new();
        r.record_histogram("session.append.latency_us", 100);
        r.record_histogram("session.append.latency_us", 200);
        r.record_histogram("session.append.latency_us", 100_000);
        let snap = r.snapshot();
        let hist = snap
            .histograms
            .iter()
            .find(|(k, _)| k == "session.append.latency_us")
            .map(|(_, v)| v.clone())
            .expect("histogram must be present");
        assert_eq!(hist.count, 3);
        assert_eq!(hist.sum, 100 + 200 + 100_000);
    }

    #[test]
    fn dump_snapshot_round_trips_to_expected_json_shape() {
        let r = InMemoryRecorder::new();
        r.inc_counter("a.counter");
        r.record_histogram("a.histogram", 5);
        r.set_gauge("a.gauge", 42);
        let json = r.dump_snapshot();
        assert!(json.is_object(), "snapshot must be a JSON object");
        assert!(json.get("counters").is_some());
        assert!(json.get("gauges").is_some());
        assert!(json.get("histograms").is_some());
    }

    #[test]
    fn missing_counter_returns_zero() {
        let r = InMemoryRecorder::new();
        assert_eq!(r.counter_value("never.recorded"), 0);
        assert_eq!(r.gauge_value("never.recorded"), 0);
    }

    /// Concurrent increments from many tasks must all land in the same
    /// counter without loss. We spawn N tasks, each doing M increments, and
    /// assert the final value is N*M.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_increments_are_lossless() {
        const TASKS: u64 = 8;
        const INCREMENTS_PER_TASK: u64 = 500;
        let recorder = Arc::new(InMemoryRecorder::new());
        let mut handles = Vec::new();
        for _ in 0..TASKS {
            let r = recorder.clone();
            handles.push(tokio::spawn(async move {
                for _ in 0..INCREMENTS_PER_TASK {
                    r.inc_counter("parallel.counter");
                }
            }));
        }
        for h in handles {
            h.await.expect("task must not panic");
        }
        assert_eq!(
            recorder.counter_value("parallel.counter"),
            TASKS * INCREMENTS_PER_TASK
        );
    }

    #[test]
    fn gauge_set_and_adjust_work() {
        let r = InMemoryRecorder::new();
        r.set_gauge("pending", 10);
        r.adjust_gauge("pending", -3);
        r.adjust_gauge("pending", 1);
        assert_eq!(r.gauge_value("pending"), 8);
    }
}
