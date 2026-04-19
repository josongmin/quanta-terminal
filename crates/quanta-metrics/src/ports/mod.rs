//! The `MetricsRecorder` port.
//!
//! Intentionally synchronous. A record is a local atomic increment; making
//! the trait `async` would force every hot path into `.await` with no
//! runtime benefit. Call from blocking code, async code, or from the middle
//! of a spawned future — the port doesn't care.

use crate::domain::MetricsSnapshot;

/// Record primitive metric operations.
///
/// All methods take `&self` and `&'static str` names. `'static` keeps the
/// API zero-allocation at call sites (no per-record `String` copy) and
/// matches the convention we use in `tracing` field names.
///
/// A `NoopRecorder` is trivially available when metrics are turned off in
/// a given build.
pub trait MetricsRecorder: Send + Sync + std::fmt::Debug {
    /// Increment the counter named `name` by 1.
    fn inc_counter(&self, name: &'static str);

    /// Increment the counter named `name` by `delta`.
    fn add_counter(&self, name: &'static str, delta: u64);

    /// Record a single observation on the histogram named `name`.
    fn record_histogram(&self, name: &'static str, value: u64);

    /// Set the gauge named `name` to `value`, replacing whatever was there.
    fn set_gauge(&self, name: &'static str, value: i64);

    /// Add `delta` (may be negative) to the gauge named `name`.
    fn adjust_gauge(&self, name: &'static str, delta: i64);

    /// Return a `MetricsSnapshot` of the current state. O(n) in the number
    /// of distinct metric names — called by dashboards / replay CLI, not on
    /// the hot path.
    fn snapshot(&self) -> MetricsSnapshot;

    /// Return the current value of a counter, or 0 if the name has never
    /// been recorded. Dashboards use this for single-value probes without
    /// serialising the whole snapshot.
    fn counter_value(&self, name: &'static str) -> u64;

    /// Return the current value of a gauge, or 0 if absent.
    fn gauge_value(&self, name: &'static str) -> i64;
}
