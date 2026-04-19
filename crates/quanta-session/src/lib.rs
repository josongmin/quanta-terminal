//! `quanta-session` — the session actor and its supporting types.
//!
//! A session owns one PTY, one block reducer, and emits events through a sink
//! port. Per ADR 0003, the launch cwd is authoritative; OSC 7 and OSC 133
//! promote the tier when detected. No env-delta tracking in Phase 1.

pub mod adapters;
pub mod domain;
pub mod ports;

pub use adapters::{
    SessionActor, METRIC_APPEND_LATENCY_US, METRIC_ENVELOPE_APPENDED, METRIC_VT_EVENTS_EMITTED,
    METRIC_VT_FEED_LATENCY_US,
};
pub use domain::{InputSubmission, SessionConfig, SessionId, SessionSnapshot};
pub use ports::{
    BufferKind, EventEnvelope, GridDelta, GridSnapshot, SessionError, SessionHandle, TerminalEvent,
};
