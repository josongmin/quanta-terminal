//! Session ports — how callers drive a session and observe errors.

use async_trait::async_trait;

use quanta_proto::ids::BlockId;
use quanta_pty::PtySize;

use crate::domain::{InputSubmission, SessionSnapshot};

// EPIC-F — VT port re-exports. Downstream consumers import VT event / envelope
// surfaces through `quanta_session::ports::*` so they don't have to know whether
// the types live in `quanta_vt` or this crate. Per the contract freeze in
// `docs/plans/0001-custom-vt-engine-xterm-removal/epic-F-session-integration.md` §14.
pub use quanta_vt::{
    BufferKind, CellRun, EventEnvelope, GridDelta, GridSnapshot, ModeChangedPayload, RectDamage,
    RowDelta, TerminalEvent,
};

/// Errors returned from a [`SessionHandle`].
///
/// Two of the variants (`Pty`, `EventLog`) carry the original error so the
/// caller can diagnose the underlying failure without string-parsing. `Other`
/// is a catch-all for future sources not yet modeled as their own variant.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    /// The session has already been closed; further operations are rejected.
    #[error("session closed")]
    Closed,
    /// The input channel accepted no command within the configured deadline.
    /// The session is alive (it hasn't been closed) but the input task is
    /// stuck — typically because a prior write is blocked on an unresponsive
    /// PTY. Callers should treat this as "session unresponsive" and surface
    /// a distinct UI state rather than retrying indefinitely. See FIX 5 in
    /// the audit.
    #[error("session unresponsive: input channel accepted no command within deadline")]
    Unresponsive,
    /// The underlying PTY adapter returned an error.
    #[error("pty error: {0}")]
    Pty(#[from] quanta_pty::PtyError),
    /// The event log adapter returned an error while appending.
    #[error("event log error: {0}")]
    EventLog(#[from] quanta_events::EventLogError),
    /// Catch-all for unstructured failures (e.g. a dropped ack channel).
    #[error("other: {0}")]
    Other(String),
}

/// Async handle to a running session actor.
///
/// All methods are idempotent and safe to call from multiple tasks: internal
/// channels serialize commands through the actor's input task. `close()` is
/// re-entrant; see its implementation doc-comment for details.
#[async_trait]
pub trait SessionHandle: Send + Sync + std::fmt::Debug {
    /// Submit input for the PTY. Returns the new block id if `submit` is true.
    async fn submit_input(&self, input: InputSubmission) -> Result<Option<BlockId>, SessionError>;
    /// Resize the PTY window.
    async fn resize(&self, size: PtySize) -> Result<(), SessionError>;
    /// Request cancellation of the in-flight block (currently a best-effort
    /// SIGINT via Ctrl-C).
    async fn cancel_block(&self, block_id: BlockId) -> Result<(), SessionError>;
    /// Shut down the session, joining all background tasks. Idempotent.
    async fn close(&self) -> Result<(), SessionError>;
    /// Return a point-in-time snapshot of the session's observable metadata.
    async fn snapshot(&self) -> SessionSnapshot;
}
