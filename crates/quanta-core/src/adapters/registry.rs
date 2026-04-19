//! `ControlRegistry` — implements `quanta_protocol::ControlHandler` by routing
//! RPC calls into the `Engine` and event fetch into the shared broadcast
//! channel fed by `FanoutSink`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::rpc::{
    CreateSessionResult, InputMode, ListSessionsResult, RpcError, RpcMethod, RpcResponse,
    RpcResult, SessionSummary, SubmitInputResult,
};
use quanta_protocol::{ControlHandler, ReplayError};
use quanta_session::{InputSubmission, SessionHandle as _};
use tokio::sync::{broadcast, Mutex};
use tracing::{debug, warn};

/// Lag summaries are emitted every LAG_SUMMARY_INTERVAL observed `Lagged`
/// events; the counter then resets. Keeps operational visibility to
/// backpressure without producing log storms when a slow subscriber keeps
/// lagging for an extended period. See FIX 4 in the audit.
const LAG_SUMMARY_INTERVAL: u64 = 100;

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
    /// Running total of envelopes dropped due to broadcast lag since the
    /// last summary log. Incremented on every `RecvError::Lagged(n)` with
    /// `n`, then reset each time we log a summary. See
    /// [`LAG_SUMMARY_INTERVAL`].
    lag_counter: AtomicU64,
    /// Count of Lagged occurrences (not envelopes) since last summary, so
    /// the interval is in terms of events observed by the receiver, not a
    /// raw envelope count — matches the task spec: "every 100 lags, log
    /// once with the total and reset".
    lag_events_since_summary: AtomicU64,
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
            lag_counter: AtomicU64::new(0),
            lag_events_since_summary: AtomicU64::new(0),
        })
    }

    /// Observed-but-not-yet-summarized lag-dropped envelope count. Exposed
    /// for tests.
    #[must_use]
    pub fn lag_counter_snapshot(&self) -> u64 {
        self.lag_counter.load(Ordering::Relaxed)
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
                // FIX 4: broadcast send never distinguishes Lagged from
                // NoSubscribers (the sender side only ever sees "no
                // subscribers"); lag is observed HERE on the receiver. We
                // accumulate a running total and summarize every
                // LAG_SUMMARY_INTERVAL Lagged occurrences. Individual drops
                // stay at debug level so a burst of lag doesn't produce a
                // log storm.
                self.lag_counter.fetch_add(n, Ordering::Relaxed);
                debug!(
                    dropped = n,
                    "control registry: broadcast subscriber lagged; envelope recoverable via event log"
                );
                let observed = self
                    .lag_events_since_summary
                    .fetch_add(1, Ordering::Relaxed)
                    + 1;
                if observed >= LAG_SUMMARY_INTERVAL {
                    let total = self.lag_counter.swap(0, Ordering::Relaxed);
                    self.lag_events_since_summary.store(0, Ordering::Relaxed);
                    warn!(
                        total_dropped = total,
                        over_lag_events = observed,
                        "control registry: broadcast backpressure summary (subscriber cannot keep up)"
                    );
                }
                None
            }
            Err(_timeout) => None,
        }
    }

    /// Replay events for `session_id` whose `monotonic_seq > since_seq` by
    /// reading the durable event log. Per ADR 0011, this is the read path
    /// for the resume cursor.
    ///
    /// On healthy replay, returns `Ok(Vec)` — possibly empty if the cursor
    /// is at or beyond the log head. Callers cannot distinguish "cursor
    /// ahead of log" from "genuine no-new-events" through the return value
    /// alone (both are `Ok(empty)`); this is deliberate per the trait doc,
    /// because a cursor-ahead situation is benign.
    ///
    /// On log failure (I/O, corruption, decode), returns
    /// [`ReplayError::LogUnavailable`]. Prior to FIX 2 this returned an
    /// empty vec, silently misleading the host into thinking there was
    /// nothing to replay when the log had actually gone sideways.
    async fn replay_since(
        &self,
        session_id: quanta_proto::ids::SessionId,
        since_seq: u64,
    ) -> Result<Vec<Envelope<Event>>, ReplayError> {
        match self.engine.replay_session(session_id).await {
            Ok(records) => Ok(records
                .into_iter()
                .map(|r| r.envelope)
                .filter(|env| env.monotonic_seq > since_seq)
                .collect()),
            Err(err) => {
                warn!(
                    %session_id,
                    ?err,
                    "replay_since: event log read failed; surfacing LogUnavailable"
                );
                Err(ReplayError::LogUnavailable {
                    reason: err.to_string(),
                })
            }
        }
    }
}
