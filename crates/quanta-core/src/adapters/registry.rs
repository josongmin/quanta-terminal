//! `ControlRegistry` — implements `quanta_protocol::ControlHandler` by routing
//! RPC calls into the `Engine` and event fetch into the shared broadcast
//! channel fed by `FanoutSink`.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::rpc::{
    CreateSessionResult, InputMode, ListSessionsResult, RpcError, RpcMethod, RpcResponse,
    RpcResult, SessionSummary, SubmitInputResult,
};
use quanta_protocol::ControlHandler;
use quanta_session::{InputSubmission, SessionHandle as _};
use tokio::sync::{broadcast, Mutex};
use tracing::warn;

use super::engine::Engine;

/// Bounded poll window for `next_event`. The protocol adapter polls at a 5 ms
/// cadence; we cap our wait on the broadcast receiver at roughly the same
/// order so we return `None` and let the adapter pick other work up
/// (shutdown signal, connection close) promptly.
const NEXT_EVENT_WAIT: Duration = Duration::from_millis(20);

/// The registry binds the engine to the control plane.
///
/// `next_event` consumes the broadcast channel fed by `FanoutSink`. A lagged
/// receiver skips ahead per ADR 0011 at-least-once semantics — the durable
/// event log remains canonical.
pub struct ControlRegistry {
    pub engine: Engine,
    rx: Mutex<broadcast::Receiver<Envelope<Event>>>,
}

impl std::fmt::Debug for ControlRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ControlRegistry").finish_non_exhaustive()
    }
}

impl ControlRegistry {
    pub fn new(engine: Engine, rx: broadcast::Receiver<Envelope<Event>>) -> Arc<Self> {
        Arc::new(Self {
            engine,
            rx: Mutex::new(rx),
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
        let mut rx = self.rx.lock().await;
        match tokio::time::timeout(NEXT_EVENT_WAIT, rx.recv()).await {
            Ok(Ok(env)) => Some(env),
            Ok(Err(broadcast::error::RecvError::Closed)) => None,
            Ok(Err(broadcast::error::RecvError::Lagged(n))) => {
                warn!(
                    dropped = n,
                    "control registry: broadcast subscriber lagged; events replayable via event log"
                );
                None
            }
            Err(_timeout) => None,
        }
    }

    /// Replay events for `session_id` whose `monotonic_seq > since_seq` by
    /// reading the durable event log. Per ADR 0011, this is the read path
    /// for the resume cursor. Errors surface empty to the caller — missing
    /// history is not fatal at the protocol boundary.
    async fn replay_since(
        &self,
        session_id: quanta_proto::ids::SessionId,
        since_seq: u64,
    ) -> Vec<Envelope<Event>> {
        match self.engine.replay_session(session_id).await {
            Ok(records) => records
                .into_iter()
                .map(|r| r.envelope)
                .filter(|env| env.monotonic_seq > since_seq)
                .collect(),
            Err(err) => {
                warn!(%session_id, ?err, "replay_since: event log read failed; returning empty");
                Vec::new()
            }
        }
    }
}
