//! Event log ports.

use async_trait::async_trait;

use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::ids::SessionId;

use crate::domain::LogRecord;

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
