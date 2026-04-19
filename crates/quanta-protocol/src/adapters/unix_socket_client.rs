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
use std::sync::{Arc, Mutex as StdMutex};
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
    /// `std::sync::Mutex` because every critical section here is a pure
    /// hashmap op (insert / remove / count) with no `.await` inside it, AND
    /// the scope-guard in [`PendingGuard`] must be callable from `Drop`,
    /// which is strictly synchronous. `tokio::sync::Mutex::blocking_lock`
    /// panics inside an async context, so we use `std::sync` here.
    pending: Arc<StdMutex<PendingMap>>,
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
        let pending: Arc<StdMutex<PendingMap>> = Arc::new(StdMutex::new(HashMap::new()));
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
    ///
    /// The pending-map entry is cleaned up on ALL exit paths (success, rx
    /// error from reader-task abort, send failure, drop) via [`PendingGuard`].
    /// Before this guard existed, a mid-flight socket drop that tore down the
    /// reader task after insertion but before delivery would leave a dead
    /// `Sender` wedged in the map — subsequent requests reusing the id would
    /// match and be silently dropped by the shadow entry.
    pub async fn call(
        &self,
        request_id: impl Into<String>,
        method: RpcMethod,
    ) -> Result<RpcResponse<serde_json::Value>, ProtocolError> {
        let request_id = request_id.into();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().expect("pending map mutex poisoned");
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err(ProtocolError::Io(format!(
                    "pending-request ceiling of {MAX_PENDING_REQUESTS} reached; refusing new RPC"
                )));
            }
            pending.insert(request_id.clone(), tx);
        }
        // Install the cleanup guard AFTER the insert so drop always removes
        // exactly one entry we own. Every early return below (send failure,
        // rx closed, success) drops the guard and frees the map slot.
        let _guard = PendingGuard {
            pending: self.pending.clone(),
            id: request_id.clone(),
        };
        let msg = ControlMessage::Request(RpcRequest {
            request_id: request_id.clone(),
            payload: method,
        });
        write_control(&self.writer, &msg).await?;
        rx.await
            .map_err(|_| ProtocolError::Io("client reader closed before response arrived".into()))
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

/// Scope-guard that removes a pending-request entry on Drop.
///
/// Held by [`UnixSocketClient::call`] for the lifetime of the RPC. Covers
/// every exit path — success (the `Ok(resp)` return drops the guard after the
/// reader already consumed the sender), rx closed (reader aborted without
/// delivering), write error, cancellation/drop of the future. Without this,
/// a mid-flight socket drop leaks the pending entry and subsequent RPCs
/// reusing the id silently match the dead shadow sender.
///
/// Uses `std::sync::Mutex` (not `tokio::sync::Mutex`) because `Drop` is
/// synchronous and `tokio::sync::Mutex::blocking_lock` panics inside an
/// async context. The critical section is a single `HashMap::remove`, which
/// is short enough that blocking on a poisoned `std::sync::Mutex` is
/// acceptable.
struct PendingGuard {
    pending: Arc<StdMutex<PendingMap>>,
    id: String,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        // Poisoning cannot drop the sender any less: if the lock is poisoned
        // we still attempt the remove to avoid leaking. `into_inner`-style
        // recovery would be overkill for a cleanup op.
        if let Ok(mut map) = self.pending.lock() {
            map.remove(&self.id);
        }
    }
}

async fn reader_loop(
    mut reader: tokio::net::unix::OwnedReadHalf,
    mut buf: Vec<u8>,
    pending: Arc<StdMutex<PendingMap>>,
    event_tx: mpsc::Sender<Envelope<Event>>,
) {
    let mut tmp = [0u8; 8192];
    loop {
        // Try to peel one or more frames out of `buf` before reading more.
        loop {
            match try_take_frame(&mut buf) {
                Ok(Some(Frame::Control(msg))) => {
                    dispatch_control(msg, &pending);
                }
                Ok(Some(Frame::Event(env))) => {
                    if event_tx.send(*env).await.is_err() {
                        // Receiver dropped — nothing is listening to events,
                        // but RPCs may still be in flight. Keep the reader
                        // alive so control responses still get delivered.
                    }
                }
                Ok(None) => break, // need more bytes
                Err(err) => {
                    warn!(?err, "unix_socket_client: frame decode failed; closing");
                    fail_all_pending(&pending);
                    return;
                }
            }
        }
        match reader.read(&mut tmp).await {
            Ok(0) => {
                debug!("unix_socket_client: server closed socket");
                fail_all_pending(&pending);
                return;
            }
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(err) => {
                warn!(?err, "unix_socket_client: socket read error");
                fail_all_pending(&pending);
                return;
            }
        }
    }
}

fn dispatch_control(msg: ControlMessage, pending: &Arc<StdMutex<PendingMap>>) {
    match msg {
        ControlMessage::Response(resp) => {
            let tx = pending
                .lock()
                .expect("pending map mutex poisoned")
                .remove(&resp.request_id);
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
        ControlMessage::ReplayFailed {
            ref session_id,
            ref reason,
        } => {
            // The server flags a corrupted / unavailable event log for this
            // session. Subsequent resume attempts should be treated as
            // fresh-session. The host UI layer listens for this via the log
            // and can surface it — emitting an event variant would require
            // a proto change; for now a warn gets operators unstuck.
            warn!(
                %session_id,
                %reason,
                "unix_socket_client: server reports replay failed; resume impossible"
            );
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

fn fail_all_pending(pending: &Arc<StdMutex<PendingMap>>) {
    // Drop every pending `oneshot::Sender`; the awaiting `call()` futures
    // will resolve with an `Err`. The `PendingGuard` on each live call will
    // then run its own cleanup on Drop, which is a no-op because we already
    // emptied the map — correct by idempotence.
    let mut guard = pending.lock().expect("pending map mutex poisoned");
    guard.clear();
}

/// Internal: one decoded frame off the wire.
///
/// `Envelope<Event>` is ~320 B once the `Event` enum carries grid payloads;
/// a direct variant would force every `Frame` stack slot to reserve that
/// much even for the ~112 B `Control` variant. Boxing the event keeps the
/// enum compact and makes the cost explicit at dispatch time.
enum Frame {
    Control(ControlMessage),
    Event(Box<Envelope<Event>>),
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
            Ok(Some(Frame::Event(Box::new(env))))
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

    /// Regression: before the `PendingGuard` fix, a reader-task abort (socket
    /// dropped mid-flight) left the pending-map entry behind. The `call()`
    /// returned Err, but the dead `oneshot::Sender` stayed in the map, so a
    /// subsequent response re-using the same `request_id` would be routed to
    /// the dead shadow and silently dropped.
    ///
    /// This test abuses the internals: a server that accepts Hello, sends
    /// Ready, then abruptly closes the connection. The client's `call` then
    /// observes rx closed (reader hit EOF and exited). We assert the pending
    /// map is empty after the call — pre-fix this would be 1.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn call_cleans_pending_map_when_reader_aborts_mid_flight() {
        use tokio::io::AsyncReadExt;

        let tmp = tempfile::tempdir().unwrap();
        let sock = tmp.path().join("sock");

        // Hand-rolled minimal server: accept, read Hello, write Ready, then
        // CLOSE the socket (tearing down the client's reader before it can
        // deliver a response for the forthcoming RPC).
        let sock_path = sock.clone();
        let server_task = tokio::spawn(async move {
            let listener = tokio::net::UnixListener::bind(&sock_path).unwrap();
            let (mut stream, _) = listener.accept().await.unwrap();
            // Read Hello (channel byte + JSON line terminated by \n).
            let mut buf = [0u8; 4096];
            let mut accumulated = Vec::new();
            while !accumulated.contains(&b'\n') {
                let n = stream.read(&mut buf).await.unwrap();
                if n == 0 {
                    return;
                }
                accumulated.extend_from_slice(&buf[..n]);
            }
            // Encode a Ready and ship it.
            let ready = ControlMessage::Ready(Ready {
                core_protocol_version: ProtocolVersion::CURRENT,
                core_version: "0.0.0".into(),
                sidecar_id: "quanta-core".into(),
                session_recovery_available: false,
            });
            let body = encode_control(&ready).unwrap();
            let mut out = vec![CHANNEL_CONTROL];
            out.extend_from_slice(&body);
            use tokio::io::AsyncWriteExt as _;
            stream.write_all(&out).await.unwrap();
            stream.flush().await.unwrap();
            // Pause long enough for the client to finish handshake and
            // enter `call`, then drop the stream — this is the "mid-flight
            // reader abort" the fix guards against.
            tokio::time::sleep(Duration::from_millis(100)).await;
            drop(stream);
        });

        // Wait for the socket to appear.
        for _ in 0..50 {
            if sock.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let client = UnixSocketClient::connect(&sock, "t", "0.0.0")
            .await
            .expect("connect");

        // Fire an RPC. The server will close before responding, so this
        // must return Err and — crucially — the pending entry must be
        // gone afterwards.
        let err = client
            .call(
                "req-abort",
                RpcMethod::CreateSession(quanta_proto::rpc::CreateSession {
                    shell: None,
                    cwd: None,
                    cols: 80,
                    rows: 24,
                }),
            )
            .await;
        assert!(err.is_err(), "expected rx-closed error");

        // The fix guarantees cleanup on ALL exit paths.
        let remaining = client.pending.lock().expect("pending mutex").len();
        assert_eq!(
            remaining, 0,
            "pending map must be empty after reader-abort; leak would let a stale response silently swallow a later RPC"
        );

        drop(client);
        let _ = server_task.await;
    }
}
