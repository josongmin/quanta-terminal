#![allow(clippy::match_same_arms, clippy::float_cmp)]

//! `quanta-metrics` — metrics surface for the Quanta sidecar.
//!
//! # Scope
//!
//! The crate provides:
//!
//! - Counters (`u64`, monotonic).
//! - Histograms (bucketed into a fixed-width power-of-two ladder).
//! - Gauges (current `i64`, set / add / sub).
//! - A `MetricsRecorder` port so hot paths hold an `Arc<dyn MetricsRecorder>`
//!   rather than binding to a concrete type.
//! - An in-memory adapter (`InMemoryRecorder`) that keeps everything in
//!   `DashMap`s and exposes `dump_snapshot()` → `serde_json::Value` for the
//!   replay CLI / debug UI.
//! - Canonical metric names (`names`) per RFC 0001 §13.14 — counters are
//!   declared as `pub const NAME: &str = "..."` so consumers reference
//!   them by constant rather than risk a silent typo.
//! - Perf budget decomposition stages (`stage`) per RFC 0001 §13.13.
//!   Each stage maps to a histogram name with a documented p95 budget.
//! - A rolling-rate helper (`rolling_rate`) for rate-style readouts
//!   (e.g. `vt.full_redraw_frequency`).
//!
//! # Canonical metric catalog (RFC §13.14)
//!
//! See the [`names`] module for the full list; each constant carries
//! a doc-comment linking back to the RFC line. The short list:
//!
//! | Kind      | Name                                        |
//! |-----------|---------------------------------------------|
//! | counter   | `vt.unknown_csi_count`                      |
//! | counter   | `vt.unknown_osc_count`                      |
//! | counter   | `vt.width_mismatch_count`                   |
//! | counter   | `vt.full_redraw_frequency`                  |
//! | histogram | `vt.delta_size_bytes`                       |
//! | counter   | `vt.out_of_order_events_dropped`            |
//! | counter   | `vt.stale_epoch_events_dropped`             |
//! | counter   | `vt.row_resync_requests`                    |
//! | counter   | `vt.full_snapshot_fallbacks`                |
//! | counter   | `vt.mode_negotiation_conflicts`             |
//! | counter   | `ime.lifecycle_start`                       |
//! | counter   | `ime.lifecycle_commit`                      |
//! | counter   | `ime.lifecycle_cancel`                      |
//! | counter   | `ime.abnormal_termination`                  |
//! | histogram | `ui.selection_normalization_corrections`    |
//! | counter   | `renderer.backend_recovery_events`          |
//!
//! Perf-stage histograms (`perf.stage.*_us`) live alongside these and
//! are populated through [`stage::record_stage`].
//!
//! # Architecture
//!
//! Hexagonal per ADR 0014:
//!
//! - `domain/` — pure value types (`MetricKey`, `Histogram`, `Counter`,
//!   `Gauge`, `MetricsSnapshot`). No IO, no sync primitives.
//! - `ports/` — the `MetricsRecorder` trait. Synchronous by design — a
//!   metrics record is a local atomic; making it awaitable would turn
//!   every call site into a `.await` and bloat the event loop.
//! - `adapters/` — `InMemoryRecorder`, `NoopRecorder`.
//!
//! # Concurrency
//!
//! The in-memory adapter is thread-safe: counters / gauges use atomics
//! inside a `DashMap<&'static str, Arc<…>>`. Histograms use a
//! `parking_lot::Mutex<HistogramData>` — a histogram record is a bucket
//! index + observation count increment, cheap enough that the
//! contention cost of a mutex is negligible for the workload.
//!
//! # Keying
//!
//! Every metric is keyed by a `&'static str`. Names are chosen at call
//! sites; the convention is dotted lowercase (`session.envelope.appended`).
//! Unknown-at-lookup-time keys return zero rather than error — metrics are
//! advisory, never load-bearing.

pub mod adapters;
pub mod domain;
pub mod names;
pub mod ports;
pub mod rolling_rate;
pub mod stage;

pub use adapters::{InMemoryRecorder, NoopRecorder};
pub use domain::{
    Counter, CounterSnapshot, Gauge, GaugeSnapshot, Histogram, HistogramSnapshot, MetricsSnapshot,
};
pub use ports::MetricsRecorder;
pub use rolling_rate::RollingRate;
pub use stage::{record_stage, PerfStage};
