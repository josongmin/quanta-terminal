//! Event log ports.

use async_trait::async_trait;

use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::ids::SessionId;

use crate::domain::LogRecord;

/// Errors surfaced by event-log adapters.
///
/// The variants carry enough context to diagnose a specific record/segment
/// without needing access to the originating file. In particular:
/// - [`EventLogError::ChecksumMismatch`] pins the byte offset inside the
///   affected segment.
/// - [`EventLogError::SegmentTooLarge`] reports the observed length and the
///   ceiling so operators can triage malformed or adversarial files.
/// - [`EventLogError::PayloadTooLarge`] distinguishes a post-decompression
///   size violation from a pre-read one.
#[derive(Debug, thiserror::Error)]
pub enum EventLogError {
    #[error("io error: {0}")]
    Io(String),
    #[error("encode error: {0}")]
    Encode(String),
    #[error("decode error: {0}")]
    Decode(String),
    #[error("checksum mismatch at offset {offset}")]
    ChecksumMismatch { offset: u64 },
    /// A segment file on disk exceeded the reader's size ceiling. This is
    /// treated as corruption; no records from the segment are returned.
    #[error("segment file too large: {observed} bytes (limit {limit})")]
    SegmentTooLarge { observed: u64, limit: u64 },
    /// A decompressed frame declared a payload larger than the decoder will
    /// accept. Defends replay against zstd bombs.
    #[error("record payload too large: {observed} bytes (limit {limit})")]
    PayloadTooLarge { observed: usize, limit: usize },
    /// Two adjacent records in a session are not strictly consecutive by
    /// `monotonic_seq`. Per ADR 0011 §Monotonic Seq, gaps are a corruption
    /// signal (the writer is the sole authority on seq assignment; a gap
    /// means a segment was dropped, reordered, or tampered with) and replay
    /// refuses to proceed rather than silently return a truncated history.
    #[error("monotonic_seq gap during replay: expected {expected}, got {actual}")]
    SeqGap { expected: u64, actual: u64 },
    #[error("event log closed")]
    Closed,
}

impl From<std::io::Error> for EventLogError {
    fn from(e: std::io::Error) -> Self {
        EventLogError::Io(e.to_string())
    }
}

/// The write side of the log. Sessions push envelopes here; the adapter decides
/// segment rotation and compression.
#[async_trait]
pub trait EventSink: Send + Sync + std::fmt::Debug {
    async fn append(&self, envelope: Envelope<Event>) -> Result<(), EventLogError>;
    async fn flush(&self) -> Result<(), EventLogError>;
}

/// The read side — used for replay. Synchronous iteration is fine because
/// callers treat replay as batch.
#[async_trait]
pub trait EventLogReader: Send + Sync + std::fmt::Debug {
    async fn replay_session(&self, session: SessionId) -> Result<Vec<LogRecord>, EventLogError>;
    async fn replay_all(&self) -> Result<Vec<LogRecord>, EventLogError>;
}
