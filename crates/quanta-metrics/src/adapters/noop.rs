//! `NoopRecorder` — discards every operation.
//!
//! The trivial implementation is worth having as a concrete type so callers
//! that want to disable metrics for a specific run don't have to construct
//! an `Option<Arc<dyn MetricsRecorder>>` — they just pass a
//! `Arc<NoopRecorder>` and the hot paths don't branch.

use crate::domain::MetricsSnapshot;
use crate::ports::MetricsRecorder;

/// No-op recorder. Every method is a constant-time discard. A snapshot
/// returns an empty `MetricsSnapshot`.
#[derive(Debug, Default)]
pub struct NoopRecorder;

impl NoopRecorder {
    /// Construct a fresh no-op recorder. Kept as a named constructor
    /// even though `::default()` would work, so call sites show the intent.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

impl MetricsRecorder for NoopRecorder {
    fn inc_counter(&self, _name: &'static str) {}
    fn add_counter(&self, _name: &'static str, _delta: u64) {}
    fn record_histogram(&self, _name: &'static str, _value: u64) {}
    fn set_gauge(&self, _name: &'static str, _value: i64) {}
    fn adjust_gauge(&self, _name: &'static str, _delta: i64) {}

    fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot::default()
    }

    fn counter_value(&self, _name: &'static str) -> u64 {
        0
    }

    fn gauge_value(&self, _name: &'static str) -> i64 {
        0
    }
}
