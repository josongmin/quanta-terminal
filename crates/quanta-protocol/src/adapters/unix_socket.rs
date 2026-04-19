//! Unix-socket server for the control and event planes.
//!
//! One socket path, one control connection per client. After `Hello`/`Ready`
//! the server interleaves:
//! - newline-delimited JSON `ControlMessage` traffic (client requests, server
//!   responses, ping/pong) on the same socket.
//! - a `MessagePack` event stream — each frame length-prefixed — on the same
//!   socket interleaved with control responses.
//!
//! Because the two planes share bytes on the same stream, the wire format uses
//! a 1-byte channel marker per frame: `0x01` = control JSON line, `0x02` =
//! event `MessagePack` frame. The adapter inserts that marker; the in-memory
//! domain codec functions do not care.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use quanta_proto::protocol::{Incompatible, ProtocolVersion, Ready};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;
use tracing::{debug, warn};

/// Bound the initial `Hello` wait so a misbehaving or dead client cannot pin
/// a server connection indefinitely. 5 s is generous for local IPC; real
/// clients Hello in <1 ms after `connect()`.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Event pump polling cadence. Small enough to keep event latency under the
/// 20 ms ADR 0011 budget; large enough to avoid burning CPU when idle. The
/// ideal fix is `Notify`-based wakeups from the emitter (cross-scope — needs
/// the port to expose a change-notifier).
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Ceiling on the in-flight control-line buffer. A well-behaved client sends
/// short JSON lines. A misbehaving or adversarial client that streams
/// bytes without ever emitting a newline could otherwise drive our buffer
/// arbitrarily large; we cap it and disconnect once exceeded.
const MAX_CONTROL_LINE_BUFFER: usize = 1024 * 1024;

use crate::domain::{decode_control, encode_control, encode_event, ControlMessage};
use crate::ports::{ControlHandler, ProtocolError};

const CHANNEL_CONTROL: u8 = 0x01;
const CHANNEL_EVENT: u8 = 0x02;

/// A Unix-socket server bound to `path`, servicing `handler`.
pub struct UnixSocketServer {
    path: PathBuf,
    handler: Arc<dyn ControlHandler>,
}

impl std::fmt::Debug for UnixSocketServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UnixSocketServer")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl UnixSocketServer {
    pub fn new(path: impl AsRef<Path>, handler: Arc<dyn ControlHandler>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
            handler,
        }
    }

    /// Accept a single connection and service it until it closes. Tests use
    /// this to keep the example simple; production wires `accept` in a loop.
    pub async fn accept_one(self) -> Result<(), ProtocolError> {
        // Remove stale socket file if present.
        let _ = std::fs::remove_file(&self.path);
        let listener = UnixListener::bind(&self.path).map_err(ProtocolError::from)?;
        let (stream, _addr) = listener.accept().await.map_err(ProtocolError::from)?;
        handle_connection(stream, self.handler).await
    }

    /// Accept connections in a loop until cancelled externally.
    ///
    /// NOTE: the current design accepts multiple concurrent connections.
    /// Each connection runs in its own spawned task; join handles are NOT
    /// tracked here — graceful shutdown of the server is currently process
    /// termination. Callers that need bounded shutdown should instead use
    /// [`UnixSocketServer::serve_with_shutdown`].
    pub async fn serve(self) -> Result<(), ProtocolError> {
        self.serve_with_shutdown(std::future::pending::<()>()).await
    }

    /// Accept connections until `shutdown` resolves. On shutdown, the
    /// listener is dropped (releasing the socket path) and the function
    /// returns `Ok(())`. In-flight connection tasks are NOT joined — they
    /// wind down when the client disconnects or the process exits. Tracking
    /// per-connection handles is a follow-up (see ADR 0014 §Phase 2).
    pub async fn serve_with_shutdown<F: std::future::Future<Output = ()>>(
        self,
        shutdown: F,
    ) -> Result<(), ProtocolError> {
        let _ = std::fs::remove_file(&self.path);
        let listener = UnixListener::bind(&self.path).map_err(ProtocolError::from)?;
        tokio::pin!(shutdown);
        loop {
            tokio::select! {
                // biased: always poll shutdown first so an already-resolved
                // shutdown wins over a flood of pending connections.
                biased;
                () = &mut shutdown => {
                    tracing::info!(path = ?self.path, "unix socket server: shutdown signal received");
                    return Ok(());
                }
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => {
                        let handler = self.handler.clone();
                        tokio::spawn(async move {
                            if let Err(err) = handle_connection(stream, handler).await {
                                warn!(?err, "connection error");
                            }
                        });
                    }
                    Err(err) => {
                        tracing::error!(?err, "unix socket accept failed");
                        return Err(ProtocolError::from(err));
                    }
                }
            }
        }
    }
}

async fn handle_connection(
    stream: UnixStream,
    handler: Arc<dyn ControlHandler>,
) -> Result<(), ProtocolError> {
    let (mut reader, writer) = stream.into_split();
    let writer = Arc::new(Mutex::new(writer));

    // --- Handshake loop ---
    // Wait for Hello, respond with Ready/Incompatible. After Ready, spawn the
    // event pump and start accepting requests.
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];

    // Read until we see a full control line as the initial message. Bound the
    // wait so a silent client cannot hold the server hostage (ADR 0004).
    let hello = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        read_one_control(&mut reader, &mut buf, &mut tmp),
    )
    .await
    .map_err(|_| ProtocolError::Handshake("handshake timed out".into()))??;
    let ControlMessage::Hello(hello) = hello else {
        return Err(ProtocolError::Handshake(
            "expected Hello as first message".into(),
        ));
    };

    let our_ver = ProtocolVersion::CURRENT;
    if !hello.host_protocol_version.is_compatible_with(our_ver) {
        let resp = ControlMessage::Incompatible(Incompatible {
            reason: "protocol version mismatch".into(),
            core_protocol_version: our_ver,
        });
        write_control(&writer, &resp).await?;
        return Ok(());
    }

    let ready = ControlMessage::Ready(Ready {
        core_protocol_version: our_ver,
        core_version: env!("CARGO_PKG_VERSION").to_string(),
        sidecar_id: "quanta-core".into(),
        // Phase 1: resume via replay is available when the handler supports
        // it (ControlRegistry does). The handler itself may still return an
        // empty vec if the log is gone; the client treats that as "no
        // history" per ADR 0011.
        session_recovery_available: true,
    });
    write_control(&writer, &ready).await?;

    // --- Resume replay per ADR 0011 §Resume Cursor ---
    //
    // If the host sent `resume_cursors`, replay log events > cursor for each
    // session BEFORE the live broadcast pump starts. This closes the
    // reconnect gap where events emitted between disconnect and reconnect
    // would otherwise be lost to the UI (the durable log still has them).
    //
    // We encode and push these envelopes through the same event-plane frame
    // path as live events; the client cannot distinguish and doesn't need to.
    // The `monotonic_seq` on each envelope lets the client dedupe if it
    // happens to also receive an overlapping live event — standard
    // at-least-once semantics per ADR 0011 §Dedupe Windows.
    if !hello.resume_cursors.is_empty() {
        for (sid_str, since_seq) in &hello.resume_cursors {
            let Ok(session_id) = quanta_proto::ids::SessionId::parse(sid_str) else {
                tracing::warn!(
                    malformed_session_id = %sid_str,
                    "resume cursor has non-ULID session id; skipping",
                );
                continue;
            };
            let replayed = match handler.replay_since(session_id, *since_seq).await {
                Ok(v) => v,
                Err(err) => {
                    // FIX 2: a broken event log used to look identical to
                    // "cursor at head" (both an empty Vec). Now the handler
                    // distinguishes, and we must propagate that to the host
                    // so the UI can prompt "resume failed; please reconnect
                    // fresh" rather than silently showing an empty session.
                    tracing::warn!(
                        %session_id,
                        ?err,
                        "resume cursor: replay_since failed; notifying host"
                    );
                    let notice = ControlMessage::ReplayFailed {
                        session_id: session_id.to_string(),
                        reason: err.to_string(),
                    };
                    // Best-effort send: if this itself fails, the connection
                    // is already dead and we bail.
                    if write_control(&writer, &notice).await.is_err() {
                        return Ok(());
                    }
                    continue;
                }
            };
            tracing::info!(
                session_id = %session_id,
                since_seq = *since_seq,
                replayed_count = replayed.len(),
                "resume cursor: replaying events",
            );
            for env in replayed {
                // Envelope-level fields carried into every observability
                // record for this replay: session_id, event_id, seq,
                // causation_id so operators can triage a resume stall or
                // partial replay back to the specific envelope.
                let seq = env.monotonic_seq;
                let event_id = env.event_id;
                let causation_id = env.causation_id;
                match encode_event(&env) {
                    Ok(frame) => {
                        let mut w = writer.lock().await;
                        if w.write_all(&[CHANNEL_EVENT]).await.is_err()
                            || w.write_all(&frame).await.is_err()
                        {
                            tracing::warn!(
                                %session_id,
                                seq,
                                %event_id,
                                ?causation_id,
                                "resume cursor: client disconnected mid-replay; aborting",
                            );
                            return Ok(());
                        }
                    }
                    Err(err) => {
                        tracing::warn!(
                            %session_id,
                            seq,
                            %event_id,
                            ?causation_id,
                            ?err,
                            "resume cursor: encode failed; skipping envelope"
                        );
                    }
                }
            }
        }
    }

    // --- Event pump ---
    // NOTE: this is a polling pump against `next_event()`. A proper
    // `Notify`-style wakeup requires the `ControlHandler` port to expose a
    // change notifier — logged as cross-scope for Round 1. Polling cadence
    // below is tuned to keep event latency within the ADR 0011 budget without
    // burning a core when idle.
    let event_handler = handler.clone();
    let event_writer = writer.clone();
    let event_task = tokio::spawn(async move {
        loop {
            if let Some(envelope) = event_handler.next_event().await {
                // Capture envelope identity before move into `encode_event`
                // so error-path warnings carry enough context (session_id +
                // event_id + seq + causation_id) for after-the-fact triage.
                let session_id = envelope.session_id;
                let seq = envelope.monotonic_seq;
                let event_id = envelope.event_id;
                let causation_id = envelope.causation_id;
                match encode_event(&envelope) {
                    Ok(frame) => {
                        let mut w = event_writer.lock().await;
                        // frame already carries its own u32 prefix; we prepend
                        // the channel byte.
                        if w.write_all(&[CHANNEL_EVENT]).await.is_err()
                            || w.write_all(&frame).await.is_err()
                        {
                            break;
                        }
                    }
                    Err(err) => {
                        warn!(
                            %session_id,
                            seq,
                            %event_id,
                            ?causation_id,
                            ?err,
                            "event encode error"
                        );
                        break;
                    }
                }
            } else {
                tokio::time::sleep(EVENT_POLL_INTERVAL).await;
            }
        }
    });

    // --- Request loop ---
    loop {
        let msg = match read_one_control(&mut reader, &mut buf, &mut tmp).await {
            Ok(m) => m,
            Err(err) => {
                debug!(client_id = %hello.client_id, ?err, "protocol.socket: client disconnected");
                break;
            }
        };
        match msg {
            ControlMessage::Request(req) => {
                let resp = handler
                    .handle_rpc(req.request_id.clone(), req.payload)
                    .await;
                write_control(&writer, &ControlMessage::Response(resp)).await?;
            }
            ControlMessage::Ping { seq } => {
                write_control(&writer, &ControlMessage::Pong { seq }).await?;
            }
            ControlMessage::Goodbye { .. } => break,
            // An extra `Hello` from a client that retries the handshake on
            // the same connection. Per ADR 0004 the handshake is
            // one-shot-per-connection: we already sent Ready and the event
            // pump is running. Rejecting the duplicate with a warn keeps the
            // client responsive but ensures we don't double-install a pump
            // or flip any state.
            ControlMessage::Hello(_) => {
                tracing::warn!(
                    client_id = %hello.client_id,
                    "protocol.socket: duplicate Hello after handshake; ignoring",
                );
            }
            other => {
                debug!(
                    client_id = %hello.client_id,
                    ?other,
                    "protocol.socket: unexpected control message",
                );
            }
        }
    }

    event_task.abort();
    let _ = event_task.await;
    Ok(())
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

async fn read_one_control(
    reader: &mut tokio::net::unix::OwnedReadHalf,
    buf: &mut Vec<u8>,
    tmp: &mut [u8],
) -> Result<ControlMessage, ProtocolError> {
    // Read until we have a channel byte + newline-terminated JSON line.
    loop {
        // If we have a complete control line (channel byte + line to \n) in buf, return it.
        if let Some(msg) = try_take_control_line(buf)? {
            return Ok(msg);
        }
        // Cap the read buffer to defend against a client that streams bytes
        // indefinitely without ever emitting a newline. At the ceiling we
        // treat the stream as malformed and close the connection rather
        // than growing memory without bound.
        if buf.len() >= MAX_CONTROL_LINE_BUFFER {
            return Err(ProtocolError::Codec(format!(
                "control-line buffer exceeded {MAX_CONTROL_LINE_BUFFER} bytes without newline"
            )));
        }
        let n = reader.read(tmp).await.map_err(ProtocolError::from)?;
        if n == 0 {
            return Err(ProtocolError::Io("stream closed".into()));
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

fn try_take_control_line(buf: &mut Vec<u8>) -> Result<Option<ControlMessage>, ProtocolError> {
    if buf.is_empty() {
        return Ok(None);
    }
    // We expect a CHANNEL_CONTROL marker before the JSON line. If the marker
    // is not control, this is programmer error in the test harness; treat as
    // protocol error.
    if buf[0] != CHANNEL_CONTROL {
        return Err(ProtocolError::Codec(format!(
            "unexpected channel byte 0x{:02x} at head",
            buf[0]
        )));
    }
    if let Some(pos) = buf[1..].iter().position(|b| *b == b'\n') {
        let line_end = 1 + pos;
        let line = buf[1..line_end].to_vec();
        // Remove channel byte + line + newline.
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
    use quanta_proto::envelope::Envelope;
    use quanta_proto::events::Event;
    use quanta_proto::protocol::Hello;
    use quanta_proto::rpc::{RpcError, RpcMethod, RpcResponse, RpcResult};

    #[derive(Debug, Default)]
    struct StubHandler;

    #[async_trait]
    impl ControlHandler for StubHandler {
        async fn handle_rpc(
            &self,
            request_id: String,
            _method: RpcMethod,
        ) -> RpcResponse<serde_json::Value> {
            RpcResponse {
                request_id,
                result: RpcResult::Err {
                    error: RpcError {
                        code: "not_implemented".into(),
                        message: "stub".into(),
                    },
                },
            }
        }

        async fn next_event(&self) -> Option<Envelope<Event>> {
            None
        }
    }

    #[tokio::test]
    async fn hello_ready_handshake() {
        let tmp = tempfile::tempdir().unwrap();
        let sock = tmp.path().join("sock");
        let handler = Arc::new(StubHandler);
        let server = UnixSocketServer::new(&sock, handler);
        let accept = tokio::spawn(async move { server.accept_one().await });

        // Wait for the socket to appear.
        for _ in 0..50 {
            if sock.exists() {
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
        }

        let stream = UnixStream::connect(&sock).await.unwrap();
        let (mut r, mut w) = stream.into_split();

        // Send Hello.
        let hello = ControlMessage::Hello(Hello {
            host_protocol_version: ProtocolVersion::CURRENT,
            host_version: "test".into(),
            client_id: "c1".into(),
            resume_cursors: std::collections::HashMap::new(),
        });
        let mut bytes = vec![CHANNEL_CONTROL];
        bytes.extend_from_slice(&encode_control(&hello).unwrap());
        w.write_all(&bytes).await.unwrap();

        // Read Ready.
        let mut buf = Vec::new();
        let mut tmp_buf = [0u8; 4096];
        loop {
            let n = r.read(&mut tmp_buf).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp_buf[..n]);
            if buf.contains(&b'\n') {
                break;
            }
        }
        assert_eq!(buf[0], CHANNEL_CONTROL);
        let line_end = buf[1..].iter().position(|b| *b == b'\n').unwrap() + 1;
        let msg = decode_control(&buf[1..line_end]).unwrap();
        assert!(matches!(msg, ControlMessage::Ready(_)));

        // Close the client half so the server loop exits.
        drop(w);
        drop(r);
        // Give the server a moment; it may already be done.
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), accept).await;
    }
}
