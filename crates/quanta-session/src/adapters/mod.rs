//! Session adapters — the actor that drives a PTY.

mod actor;

pub use actor::{SessionActor, METRIC_APPEND_LATENCY_US, METRIC_ENVELOPE_APPENDED};
