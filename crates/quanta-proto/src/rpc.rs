//! RPC control plane messages.
//!
//! The event channel (see `events::Event`) is one-way sidecar→host.
//! The RPC channel is request/response, used for commands and queries.
//!
//! Per [ADR 0011]: all RPCs must be idempotent by `request_id` so at-least-once
//! retries are safe.

use serde::{Deserialize, Serialize};

use crate::ids::{BlockId, SessionId};

/// Every RPC is wrapped so the host can match responses to requests across the
/// async boundary and retry safely.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RpcRequest<P> {
    pub request_id: String,
    pub payload: P,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RpcResponse<R> {
    pub request_id: String,
    pub result: RpcResult<R>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RpcResult<R> {
    Ok { value: R },
    Err { error: RpcError },
}

#[derive(Clone, Debug, Serialize, Deserialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

// ---- Concrete RPC payloads Phase 1 ships ----

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum RpcMethod {
    CreateSession(CreateSession),
    SubmitInput(SubmitInput),
    ResizePty(ResizePty),
    CancelBlock(CancelBlock),
    CloseSession(CloseSession),
    ListSessions(ListSessions),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateSession {
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateSessionResult {
    pub session_id: SessionId,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SubmitInput {
    pub session_id: SessionId,
    pub text: String,
    /// Whether the host wants the bytes interpreted as a command submission
    /// (i.e. a CR appended) or as raw keystroke passthrough.
    pub mode: InputMode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputMode {
    /// Submit as a full command: the core appends the shell's line terminator.
    Submit,
    /// Passthrough each byte as typed, for interactive TUIs and raw mode.
    Passthrough,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SubmitInputResult {
    /// The block id the submission created, if any. `Submit` always creates a
    /// block; `Passthrough` does not.
    pub block_id: Option<BlockId>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResizePty {
    pub session_id: SessionId,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CancelBlock {
    pub session_id: SessionId,
    pub block_id: BlockId,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CloseSession {
    pub session_id: SessionId,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ListSessions;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ListSessionsResult {
    pub sessions: Vec<SessionSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session_id: SessionId,
    pub shell: String,
    pub started_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_result_roundtrips() {
        let r: RpcResult<CreateSessionResult> = RpcResult::Ok {
            value: CreateSessionResult {
                session_id: SessionId::new(),
            },
        };
        let s = serde_json::to_string(&r).unwrap();
        let back: RpcResult<CreateSessionResult> = serde_json::from_str(&s).unwrap();
        match back {
            RpcResult::Ok { .. } => {}
            RpcResult::Err { .. } => panic!("wrong variant"),
        }
    }
}
