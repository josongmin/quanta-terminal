//! `ControlRegistry` — implements `quanta_protocol::ControlHandler` by routing
//! RPC calls into the `Engine` and event fetch into the shared event log.

use std::collections::VecDeque;
use std::sync::Arc;

use async_trait::async_trait;
use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::rpc::{
    CreateSessionResult, InputMode, ListSessionsResult, RpcError, RpcMethod, RpcResponse,
    RpcResult, SessionSummary, SubmitInputResult,
};
use quanta_protocol::ControlHandler;
use quanta_session::{InputSubmission, SessionHandle as _};
use tokio::sync::Mutex;

use super::engine::Engine;

/// The registry holds the engine handle and a small event queue used as the
/// default event-plane fanout (Phase 1 simply drains the log as events are
/// appended; a fuller implementation uses pub/sub fanout).
pub struct ControlRegistry {
    pub engine: Engine,
    /// Pending events waiting to be drained by the protocol adapter. In Phase 1
    /// we deliberately leave this empty unless the host explicitly fills it;
    /// the control plane and the event plane are layered but not yet
    /// pub-sub-coupled.
    pub pending: Mutex<VecDeque<Envelope<Event>>>,
}

impl std::fmt::Debug for ControlRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ControlRegistry").finish_non_exhaustive()
    }
}

impl ControlRegistry {
    pub fn new(engine: Engine) -> Arc<Self> {
        Arc::new(Self {
            engine,
            pending: Mutex::new(VecDeque::new()),
        })
    }
}

fn err_response(
    request_id: String,
    code: &str,
    message: impl Into<String>,
) -> RpcResponse<serde_json::Value> {
    RpcResponse {
        request_id,
        result: RpcResult::Err {
            error: RpcError {
                code: code.into(),
                message: message.into(),
            },
        },
    }
}

fn ok_response<T: serde::Serialize>(
    request_id: String,
    value: &T,
) -> RpcResponse<serde_json::Value> {
    match serde_json::to_value(value) {
        Ok(v) => RpcResponse {
            request_id,
            result: RpcResult::Ok { value: v },
        },
        Err(e) => err_response(request_id, "encode_error", e.to_string()),
    }
}

#[async_trait]
impl ControlHandler for ControlRegistry {
    async fn handle_rpc(
        &self,
        request_id: String,
        method: RpcMethod,
    ) -> RpcResponse<serde_json::Value> {
        match method {
            RpcMethod::CreateSession(req) => match self
                .engine
                .create_session(
                    req.shell,
                    req.cwd.map(std::path::PathBuf::from),
                    req.cols,
                    req.rows,
                )
                .await
            {
                Ok(sid) => ok_response(request_id, &CreateSessionResult { session_id: sid }),
                Err(e) => err_response(request_id, "create_session_failed", e.to_string()),
            },
            RpcMethod::SubmitInput(req) => {
                let Some(session) = self.engine.session(req.session_id).await else {
                    return err_response(request_id, "no_such_session", "unknown session id");
                };
                let submit = matches!(req.mode, InputMode::Submit);
                let kind = quanta_proto::events::InputKind::Shell;
                match session
                    .submit_input(InputSubmission {
                        text: req.text,
                        kind,
                        submit,
                    })
                    .await
                {
                    Ok(block_id) => ok_response(request_id, &SubmitInputResult { block_id }),
                    Err(e) => err_response(request_id, "submit_input_failed", e.to_string()),
                }
            }
            RpcMethod::ResizePty(req) => {
                let Some(session) = self.engine.session(req.session_id).await else {
                    return err_response(request_id, "no_such_session", "unknown session id");
                };
                match session
                    .resize(quanta_pty::PtySize::new(req.cols, req.rows))
                    .await
                {
                    Ok(()) => ok_response(request_id, &serde_json::Value::Null),
                    Err(e) => err_response(request_id, "resize_failed", e.to_string()),
                }
            }
            RpcMethod::CancelBlock(req) => {
                match self.engine.cancel_block(req.session_id, req.block_id).await {
                    Ok(()) => ok_response(request_id, &serde_json::Value::Null),
                    Err(e) => err_response(request_id, "cancel_failed", e.to_string()),
                }
            }
            RpcMethod::CloseSession(req) => match self.engine.close_session(req.session_id).await {
                Ok(()) => ok_response(request_id, &serde_json::Value::Null),
                Err(e) => err_response(request_id, "close_failed", e.to_string()),
            },
            RpcMethod::ListSessions(_) => {
                let ids = self.engine.list_sessions().await;
                let sessions = ids
                    .into_iter()
                    .map(|session_id| SessionSummary {
                        session_id,
                        shell: self.engine.default_shell.clone(),
                        started_at: String::new(),
                    })
                    .collect();
                ok_response(request_id, &ListSessionsResult { sessions })
            }
        }
    }

    async fn next_event(&self) -> Option<Envelope<Event>> {
        self.pending.lock().await.pop_front()
    }
}
