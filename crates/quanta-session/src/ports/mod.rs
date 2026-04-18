//! Session ports — how callers drive a session and observe errors.

use async_trait::async_trait;

use quanta_proto::ids::BlockId;
use quanta_pty::PtySize;

use crate::domain::{InputSubmission, SessionSnapshot};

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("session closed")]
    Closed,
    #[error("pty error: {0}")]
    Pty(#[from] quanta_pty::PtyError),
    #[error("event log error: {0}")]
    EventLog(#[from] quanta_events::EventLogError),
    #[error("other: {0}")]
    Other(String),
}

#[async_trait]
pub trait SessionHandle: Send + Sync + std::fmt::Debug {
    async fn submit_input(&self, input: InputSubmission) -> Result<Option<BlockId>, SessionError>;
    async fn resize(&self, size: PtySize) -> Result<(), SessionError>;
    async fn cancel_block(&self, block_id: BlockId) -> Result<(), SessionError>;
    async fn close(&self) -> Result<(), SessionError>;
    async fn snapshot(&self) -> SessionSnapshot;
}
