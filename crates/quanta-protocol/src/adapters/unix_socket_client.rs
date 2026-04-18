//! Unix-socket client for the host side of the control + event planes.
//!
//! The server adapter (`UnixSocketServer`) binds the two planes onto a single
//! stream and interleaves frames with a 1-byte channel tag (`0x01` = control
//! JSON line, `0x02` = MessagePack event frame). This client is the dual: it
//! opens the socket, performs the `Hello` handshake, waits for `Ready`, and
//! then exposes:
//!
//! - a typed `call(request_id, method)` RPC helper that awaits the matching
//!   `RpcResponse`,
//! - an async event stream (`events()`) delivering every `Envelope<Event>` as
//!   it arrives from the server's event pump.
//!
//! The client is built for the Tauri host (per ADR 0004) but is transport-only
//! — it has no domain knowledge and doesn't know what events mean. The host
//! translates them into its own IPC topics.
//!
//! Concurrency model
//! -----------------
//! One I/O task owns the socket's read half and demultiplexes incoming frames
//! onto two channels:
//!   - `response_tx` (keyed by `request_id`) for control responses,
//!   - `event_tx` (broadcast) for event envelopes.
//!
//! The write half is serialized behind a `tokio::sync::Mutex`; callers can
//! issue concurrent RPCs safely. RPC timeouts are the caller's responsibility
//! (typically a `tokio::time::timeout` wrapper at the use-site).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::protocol::{Hello, ProtocolVersion, Ready};
use quanta_proto::rpc::{RpcMethod, RpcRequest, RpcResponse};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, warn};

use crate::domain::{decode_control, encode_control, ControlMessage};
use crate::ports::ProtocolError;

const CHANNEL_CONTROL: u8 = 0x01;
const CHANNEL_EVENT: u8 = 0x02;

/// Handshake must finish inside this budget; a dead or wrong server should
/// fail fast so the host can fall back or surface an error to the UI.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Bound on the per-request pending map. A well-behaved host issues tens of
/// requests at a time; an unbounded map is a DoS vector if the server never
/// responds. We cap it defensively.
const MAX_PENDING_REQUESTS: usize = 10_000;

type PendingMap = HashMap<String, oneshot::Sender<RpcResponse<serde_json::Value>>>;

/// A host-side client bound to the `quanta-core` Unix socket.
///
/// Drop the client to close the socket; the reader task exits on EOF.
pub struct UnixSocketClient {
    writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    pending: Arc<Mutex<PendingMap>>,
    event_rx: Arc<Mutex<Option<mpsc::Receiver<Envelope<Event>>>>>,
    reader_handle: Mutex<Option<JoinHandle<()>>>,
    /// Captured from the server's `Ready` for diagnostics / upgrade prompts.
    ready: Ready,
}

impl std::fmt::Debug for UnixSocketClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UnixSocketClient")
            .field("ready", &self.ready)
            .finish_non_exhaustive()
    }
}

impl UnixSocketClient {
    /// Connect to `socket_path`, perform the Hello/Ready handshake, and start
    /// the demux reader. Returns the live client on success.
    ///
    /// `client_id` is opaque to the server and used only for log correlation.
    /// `host_version` should be the host crate's `CARGO_PKG_VERSION`.
    pub async fn connect(
        socket_path: impl AsRef<Path>,
        client_id: impl Into<String>,
        host_version: impl Into<String>,
    ) -> Result<Self, ProtocolError> {
        Self::connect_with_resume(socket_path, client_id, host_version, HashMap::new()).await
    }

    /// Like [`connect`] but sends `resume_cursors` in the Hello (ADR 0011).
    pub async fn connect_with_resume(
        socket_path: impl AsRef<Path>,
        client_id: impl Into<String>,
        host_version: impl Into<String>,
        resume_cursors: HashMap<String, u64>,
    ) -> Result<Self, ProtocolError> {
        let stream = UnixStream::connect(socket_path.as_ref())
            .await
            .map_err(ProtocolError::from)?;
        let (mut reader, writer) = stream.into_split();
        let writer = Arc::new(Mutex::new(writer));

        // Send Hello.
        let hello = Hello {
            host_protocol_version: ProtocolVersion::CURRENT,
            host_version: host_version.into(),
            client_id: client_id.into(),
            resume_cursors,
        };
        write_control(&writer, &ControlMessage::Hello(hello)).await?;

        // Wait for Ready / Incompatible.
        let mut buf: Vec<u8> = Vec::with_capacity(4096);
        let mut tmp = [0u8; 4096];
        let ready = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            loop {
                // Try to peel a control frame out of `buf`.
                if let Some(msg) = try_take_control_line(&mut buf)? {
                    return match msg {
                        ControlMessage::Ready(r) => Ok::<Ready, ProtocolError>(r),
                        ControlMessage::Incompatible(inc) => Err(ProtocolError::Handshake(
                            format!("server rejected handshake: {}", inc.reason),
                        )),
                        other => Err(ProtocolError::Handshake(format!(
                            "unexpected control frame during handshake: {other:?}"
                        ))),
                    };
                }
                let n = reader.read(&mut tmp).await.map_err(ProtocolError::from)?;
                if n == 0 {
                    return Err(ProtocolError::Io(
                        "server closed stream before Ready".into(),
                    ));
                }
                buf.extend_from_slice(&tmp[..n]);
            }
        })
        .await
        .map_err(|_| ProtocolError::Handshake("handshake timed out".into()))??;

        // Spawn the demux reader task. It owns the read half for the lifetime
        // of the client; the `writer` half is used by callers serialized
        // behind the mutex.
        let pending: Arc<Mutex<PendingMap>> = Arc::new(Mutex::new(HashMap::new()));
        // mpsc with generous bound: event frames are tiny and the receiver
        // side is drained eagerly by the host bridge.
        let (event_tx, event_rx) = mpsc::channel::<Envelope<Event>>(1024);
        let pending_for_reader = pending.clone();
        let reader_handle = tokio::spawn(async move {
            reader_loop(reader, buf, pending_for_reader, event_tx).await;
        });

        Ok(Self {
            writer,
            pending,
            event_rx: Arc::new(Mutex::new(Some(event_rx))),
            reader_handle: Mutex::new(Some(reader_handle)),
            ready,
        })
    }

    /// Server's `Ready` as captured during handshake.
    #[must_use]
    pub fn ready(&self) -> &Ready {
        &self.ready
    }

    /// Issue an RPC and await the matching response.
    ///
    /// `request_id` must be unique across in-flight requests; the server
    /// echoes it verbatim and the client uses it to route the response.
    pub async fn call(
        &self,
        request_id: impl Into<String>,
        method: RpcMethod,
    ) -> Result<RpcResponse<serde_json::Value>, ProtocolError> {
        let request_id = request_id.into();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err(ProtocolError::Io(format!(
                    "pending-request ceiling of {MAX_PENDING_REQUESTS} reached; refusing new RPC"
                )));
            }
            pending.insert(request_id.clone(), tx);
        }
        let msg = ControlMessage::Request(RpcRequest {
            request_id: request_id.clone(),
            payload: method,
        });
        if let Err(err) = write_control(&self.writer, &msg).await {
            // Clean up the pending entry on send failure so we don't leak.
            self.pending.lock().await.remove(&request_id);
            return Err(err);
        }
        match rx.await {
            Ok(resp) => Ok(resp),
            Err(_) => Err(ProtocolError::Io(
                "client reader closed before response arrived".into(),
            )),
        }
    }

    /// Take ownership of the event receiver. Can only be called once per
    /// client; subsequent calls return `None`. The receiver stream ends when
    /// the socket is closed (e.g. the server exits).
    #[must_use]
    pub fn take_event_stream(&self) -> Option<mpsc::Receiver<Envelope<Event>>> {
        // `try_lock` is sufficient — the event_rx mutex is only held while we
        // swap the Option in/out, never across awaits.
        self.event_rx.try_lock().ok().and_then(|mut g| g.take())
    }

    /// Send a best-effort `Goodbye` control frame; the server closes the
    /// connection on receipt. Safe to call more than once.
    pub async fn goodbye(&self, reason: impl Into<String>) -> Result<(), ProtocolError> {
        write_control(
            &self.writer,
            &ControlMessage::Goodbye {
                reason: reason.into(),
            },
        )
        .await
    }
}

impl Drop for UnixSocketClient {
    fn drop(&mut self) {
        // Abort the reader task so pending `call()`s don't hang forever when
        // the client is dropped mid-flight. Dropping the `writer` Arc
        // eventually closes the socket; the reader is already woken by the
        // EOF, but aborting is deterministic.
        if let Ok(mut guard) = self.reader_handle.try_lock() {
            if let Some(handle) = guard.take() {
                handle.abort();
            }
        }
    }
}

async fn reader_loop(
    mut reader: tokio::net::unix::OwnedReadHalf,
    mut buf: Vec<u8>,
    pending: Arc<Mutex<PendingMap>>,
    event_tx: mpsc::Sender<Envelope<Event>>,
) {
    let mut tmp = [0u8; 8192];
    loop {
        // Try to peel one or more frames out of `buf` before reading more.
        loop {
            match try_take_frame(&mut buf) {
                Ok(Some(Frame::Control(msg))) => {
                    dispatch_control(msg, &pending).await;
                }
                Ok(Some(Frame::Event(env))) => {
                    if event_tx.send(env).await.is_err() {
                        // Receiver dropped — nothing is listening to events,
                        // but RPCs may still be in flight. Keep the reader
                        // alive so control responses still get delivered.
                    }
                }
                Ok(None) => break, // need more bytes
                Err(err) => {
                    warn!(?err, "unix_socket_client: frame decode failed; closing");
                    fail_all_pending(&pending).await;
                    return;
                }
            }
        }
        match reader.read(&mut tmp).await {
            Ok(0) => {
                debug!("unix_socket_client: server closed socket");
                fail_all_pending(&pending).await;
                return;
            }
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(err) => {
                warn!(?err, "unix_socket_client: socket read error");
                fail_all_pending(&pending).await;
                return;
            }
        }
    }
}

async fn dispatch_control(msg: ControlMessage, pending: &Arc<Mutex<PendingMap>>) {
    match msg {
        ControlMessage::Response(resp) => {
            let tx = pending.lock().await.remove(&resp.request_id);
            if let Some(tx) = tx {
                let _ = tx.send(resp);
            } else {
                warn!(
                    request_id = %resp.request_id,
                    "unix_socket_client: response for unknown request_id; dropping",
                );
            }
        }
        ControlMessage::Ping { seq } => {
            // We don't respond here — the client is not expected to drive
            // liveness from the server side. If we ever need bidirectional
            // pings, the host can issue them via `call`-style messaging.
            debug!(seq, "unix_socket_client: ignoring server Ping");
        }
        ControlMessage::Pong { .. }
        | ControlMessage::Hello(_)
        | ControlMessage::Ready(_)
        | ControlMessage::Incompatible(_)
        | ControlMessage::Request(_)
        | ControlMessage::Goodbye { .. } => {
            debug!(?msg, "unix_socket_client: unexpected control frame");
        }
    }
}

async fn fail_all_pending(pending: &Arc<Mutex<PendingMap>>) {
    // Drop every pending `oneshot::Sender`; the awaiting `call()` futures
    // will resolve with an `Err`.
    let mut guard = pending.lock().await;
    guard.clear();
}

/// Internal: one decoded frame off the wire.
enum Frame {
    Control(ControlMessage),
    Event(Envelope<Event>),
}

async fn write_control(
    writer: &Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    msg: &ControlMessage,
) -> Result<(), ProtocolError> {
    let body = encode_control(msg).map_err(|e| ProtocolError::Codec(e.to_string()))?;
    let mut w = writer.lock().await;
    w.write_all(&[CHANNEL_CONTROL])
        .await
        .map_err(ProtocolError::from)?;
    w.write_all(&body).await.map_err(ProtocolError::from)?;
    w.flush().await.map_err(ProtocolError::from)?;
    Ok(())
}

/// Peel one frame from `buf`. Returns `Ok(None)` if more bytes are needed.
fn try_take_frame(buf: &mut Vec<u8>) -> Result<Option<Frame>, ProtocolError> {
    if buf.is_empty() {
        return Ok(None);
    }
    match buf[0] {
        CHANNEL_CONTROL => {
            let Some(pos) = buf[1..].iter().position(|b| *b == b'\n') else {
                return Ok(None);
            };
            let line_end = 1 + pos;
            let line = buf[1..line_end].to_vec();
            buf.drain(..=line_end);
            let msg = decode_control(&line).map_err(|e| ProtocolError::Codec(e.to_string()))?;
            Ok(Some(Frame::Control(msg)))
        }
        CHANNEL_EVENT => {
            if buf.len() < 5 {
                return Ok(None);
            }
            let len = u32::from_be_bytes(
                buf[1..5]
                    .try_into()
                    .map_err(|_| ProtocolError::Codec("length prefix read failed".into()))?,
            ) as usize;
            if buf.len() < 5 + len {
                return Ok(None);
            }
            let body = buf[5..5 + len].to_vec();
            buf.drain(..5 + len);
            let env: Envelope<Event> =
                rmp_serde::from_slice(&body).map_err(|e| ProtocolError::Codec(e.to_string()))?;
            Ok(Some(Frame::Event(env)))
        }
        other => Err(ProtocolError::Codec(format!(
            "unknown channel byte 0x{other:02x}"
        ))),
    }
}

/// Sibling to `try_take_frame` for the handshake path, which only expects
/// control frames and should loudly reject event frames (they would mean the
/// server started broadcasting before `Ready`).
fn try_take_control_line(buf: &mut Vec<u8>) -> Result<Option<ControlMessage>, ProtocolError> {
    if buf.is_empty() {
        return Ok(None);
    }
    if buf[0] != CHANNEL_CONTROL {
        return Err(ProtocolError::Codec(format!(
            "expected control channel during handshake; got 0x{:02x}",
            buf[0]
        )));
    }
    if let Some(pos) = buf[1..].iter().position(|b| *b == b'\n') {
        let line_end = 1 + pos;
        let line = buf[1..line_end].to_vec();
        buf.drain(..=line_end);
        let msg = decode_control(&line).map_err(|e| ProtocolError::Codec(e.to_string()))?;
        Ok(Some(msg))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use quanta_proto::envelope::{Producer, SchemaVersion};
    use quanta_proto::events::{BlockCreated, CwdSource, InputKind};
    use quanta_proto::ids::{BlockId, SessionId};
    use quanta_proto::rpc::{RpcError, RpcResponse, RpcResult};
    use std::sync::atomic::{AtomicU64, Ordering};

    use crate::adapters::UnixSocketServer;
    use crate::ports::ControlHandler;

    /// Minimal handler used by unit tests. Answers every RPC with a single
    /// `Ok(Value::Null)` and emits a canned `BlockCreated` on first `next_event`
    /// so the client's event stream has something to observe.
    #[derive(Debug)]
    struct ScriptedHandler {
        emit_once: AtomicU64,
        session_id: SessionId,
    }

    impl ScriptedHandler {
        fn new() -> Self {
            Self {
                emit_once: AtomicU64::new(0),
                session_id: SessionId::new(),
            }
        }
    }

    #[async_trait]
    impl ControlHandler for ScriptedHandler {
        async fn handle_rpc(
            &self,
            request_id: String,
            method: RpcMethod,
        ) -> RpcResponse<serde_json::Value> {
            // Echo the request_id with a shaped response keyed on method.
            match method {
                RpcMethod::CreateSession(_) => RpcResponse {
                    request_id,
                    result: RpcResult::Ok {
                        value: serde_json::json!({ "session_id": self.session_id.to_string() }),
                    },
                },
                _ => RpcResponse {
                    request_id,
                    result: RpcResult::Err {
                        error: RpcError {
                            code: "not_implemented".into(),
                            message: "stub".into(),
                        },
                    },
                },
            }
        }

        async fn next_event(&self) -> Option<Envelope<Event>> {
            if self.emit_once.fetch_add(1, Ordering::SeqCst) != 0 {
                // Sleep a touch so the server's polling loop yields.
                tokio::time::sleep(Duration::from_millis(10)).await;
                return None;
            }
            Some(Envelope::new(
                self.session_id,
                1,
                Producer::Block,
                SchemaVersion::ONE,
                Event::BlockCreated(BlockCreated {
                    block_id: BlockId::new(),
                    ordinal: 0,
                    input_text: "echo hi".into(),
                    input_kind: InputKind::Shell,
                    cwd: "/tmp".into(),
                    cwd_source: CwdSource::Launch,
                    is_compound: false,
                }),
            ))
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handshake_then_call_and_event_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let sock = tmp.path().join("sock");
        let handler = Arc::new(ScriptedHandler::new());
        let server = UnixSocketServer::new(&sock, handler);
        let server_task = tokio::spawn(async move { server.serve().await });
        // Wait for the bind.
        for _ in 0..50 {
            if sock.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let client = UnixSocketClient::connect(&sock, "test-client", "0.0.0")
            .await
            .expect("connect");
        assert_eq!(client.ready().sidecar_id, "quanta-core");

        // Issue a CreateSession RPC.
        let resp = client
            .call(
                "req-1",
                RpcMethod::CreateSession(quanta_proto::rpc::CreateSession {
                    shell: Some("/bin/sh".into()),
                    cwd: None,
                    cols: 80,
                    rows: 24,
                }),
            )
            .await
            .expect("rpc");
        assert_eq!(resp.request_id, "req-1");
        match resp.result {
            RpcResult::Ok { value } => assert!(value.get("session_id").is_some()),
            RpcResult::Err { error } => panic!("expected Ok, got {error:?}"),
        }

        // Drain at least one event.
        let mut rx = client.take_event_stream().expect("stream once");
        let env = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("event deadline")
            .expect("event arrives");
        match env.payload {
            Event::BlockCreated(b) => assert_eq!(b.input_text, "echo hi"),
            other => panic!("unexpected event: {other:?}"),
        }

        // Clean shutdown.
        drop(client);
        server_task.abort();
        let _ = server_task.await;
    }

    #[tokio::test]
    async fn connect_refuses_missing_socket() {
        let tmp = tempfile::tempdir().unwrap();
        let nonexistent = tmp.path().join("does-not-exist");
        let err = UnixSocketClient::connect(&nonexistent, "c", "0").await;
        assert!(err.is_err(), "expected connect to fail on missing socket");
    }
}
