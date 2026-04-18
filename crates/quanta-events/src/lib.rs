//! `quanta-events` — append-only event log with replay.
//!
//! Per ADR 0011:
//! - Each record is length-prefixed and xxhash-checksummed.
//! - Segments are zstd-compressed on rotation.
//! - Replay consumes all records per session and reconstructs projections.

pub mod adapters;
pub mod domain;
pub mod ports;

pub use adapters::ZstdSegmentedEventLog;
pub use domain::{LogRecord, LogStats, RecordId};
pub use ports::{EventLogError, EventLogReader, EventSink};
