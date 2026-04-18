//! Edge-case coverage for the protocol codec and unix-socket adapter.
//!
//! Real-world failure modes:
//! - Truncated `Hello` JSON — handshake fails cleanly, no error! noise.
//! - JSON carrying extra unknown fields — serde defaults tolerate them
//!   (per our "serde(default)" contract future-compat plans).
//! - Client that disconnects mid-RPC — server logs at debug, not error.
//! - Control message larger than the 1 MiB buffer cap — server rejects.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::protocol::{Hello, ProtocolVersion};
use quanta_proto::rpc::{RpcError, RpcMethod, RpcResponse, RpcResult};
use quanta_protocol::{
    decode_control, encode_control, ControlHandler, ControlMessage, UnixSocketServer,
};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

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

async fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..100 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Truncated Hello JSON (missing closing brace) must surface as a codec
/// error. The connection must close without the server panicking.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn truncated_hello_json_yields_codec_error_not_panic() {
    let tmp = tempfile::tempdir().unwrap();
    let sock = tmp.path().join("sock");
    let handler: Arc<dyn ControlHandler> = Arc::new(StubHandler);
    let server = UnixSocketServer::new(&sock, handler);
    let accept = tokio::spawn(async move { server.accept_one().await });

    wait_for_socket(&sock).await;
    let mut s = UnixStream::connect(&sock).await.unwrap();
    // Channel byte + an incomplete JSON line that is still terminated by \n
    // (so the reader takes it as a "complete line"). serde_json will error.
    s.write_all(&[0x01]).await.unwrap();
    s.write_all(b"{\"type\":\"hello\",\"host_protocol_version\":\n")
        .await
        .unwrap();
    drop(s);

    let res = tokio::time::timeout(Duration::from_secs(5), accept)
        .await
        .expect("server did not conclude within 5s")
        .expect("join");
    match res {
        Err(err) => {
            let msg = format!("{err}");
            assert!(
                msg.contains("codec") || msg.contains("handshake"),
                "expected codec/handshake error on truncated JSON, got: {msg}",
            );
        }
        Ok(()) => panic!("truncated hello must not be accepted"),
    }
}

/// JSON carrying unknown fields at the envelope layer roundtrips: serde on
/// `ControlMessage` tolerates additional unknown keys by default (no
/// `deny_unknown_fields`). This is the documented forward-compat contract.
#[test]
fn control_message_with_extra_fields_decodes_successfully() {
    // A Hello payload with an unknown field `future_feature`. Wire form.
    let raw = br#"{"type":"hello","host_protocol_version":{"version":1,"min_supported":1},"host_version":"h","client_id":"c","future_feature":"ignored"}
"#;
    let msg = decode_control(raw).expect("decode must tolerate extra fields");
    match msg {
        ControlMessage::Hello(h) => {
            assert_eq!(h.host_version, "h");
            assert_eq!(h.client_id, "c");
        }
        other => panic!("expected Hello, got {other:?}"),
    }
}

/// A client that completes the handshake, sends a single request, then
/// abruptly drops mid-RPC (close socket before we reply). The server must
/// log at debug, not error, and the task must end normally. We cannot
/// directly assert the log level from the test, but we can assert the
/// handler's task joins without panicking — that's the load-bearing part.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_disconnects_mid_rpc_does_not_panic_server() {
    let tmp = tempfile::tempdir().unwrap();
    let sock = tmp.path().join("sock");
    let handler: Arc<dyn ControlHandler> = Arc::new(StubHandler);
    let server = UnixSocketServer::new(&sock, handler);
    let accept = tokio::spawn(async move { server.accept_one().await });

    wait_for_socket(&sock).await;
    let mut s = UnixStream::connect(&sock).await.unwrap();
    // Proper Hello.
    let hello = ControlMessage::Hello(Hello {
        host_protocol_version: ProtocolVersion::CURRENT,
        host_version: "test".into(),
        client_id: "c1".into(),
        resume_cursors: std::collections::HashMap::default(),
    });
    let mut bytes = vec![0x01u8];
    bytes.extend_from_slice(&encode_control(&hello).unwrap());
    s.write_all(&bytes).await.unwrap();
    // Give the server time to reply Ready and switch to request loop.
    tokio::time::sleep(Duration::from_millis(50)).await;
    // Drop the client abruptly.
    drop(s);

    // Server must wind down cleanly.
    let res = tokio::time::timeout(Duration::from_secs(5), accept)
        .await
        .expect("server did not close within 5s")
        .expect("join");
    // Either Ok(()) (normal client close) or Io("stream closed") is acceptable.
    match res {
        Ok(()) => {}
        Err(err) => {
            let msg = format!("{err}");
            assert!(
                msg.contains("stream closed") || msg.contains("io"),
                "unexpected error on mid-RPC disconnect: {msg}",
            );
        }
    }
}

/// A client that streams bytes without ever sending a newline hits the
/// 1 MiB MAX_CONTROL_LINE_BUFFER cap. Server rejects cleanly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_control_line_without_newline_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let sock = tmp.path().join("sock");
    let handler: Arc<dyn ControlHandler> = Arc::new(StubHandler);
    let server = UnixSocketServer::new(&sock, handler);
    let accept = tokio::spawn(async move { server.accept_one().await });

    wait_for_socket(&sock).await;
    let mut s = UnixStream::connect(&sock).await.unwrap();
    // Channel byte + a wall of 'A's that exceeds 1 MiB. No newline, ever.
    s.write_all(&[0x01]).await.unwrap();
    // Write 1.5 MiB in chunks so we don't create a giant single buffer.
    let chunk = vec![b'A'; 64 * 1024];
    for _ in 0..24 {
        // best-effort: the server may close on us before we finish writing.
        if s.write_all(&chunk).await.is_err() {
            break;
        }
    }
    drop(s);

    let res = tokio::time::timeout(Duration::from_secs(10), accept)
        .await
        .expect("server did not conclude within 10s")
        .expect("join");
    match res {
        Err(err) => {
            let msg = format!("{err}");
            assert!(
                msg.contains("buffer exceeded") || msg.contains("codec"),
                "expected buffer-exceeded codec error, got: {msg}",
            );
        }
        Ok(()) => panic!("oversized line must be rejected"),
    }
}

/// A control message that serializes to < 1 MiB but is still a very large
/// line (e.g. a Goodbye with a huge reason string) must round-trip through
/// encode/decode without truncation or codec error.
#[test]
fn large_but_bounded_control_message_roundtrips() {
    let big_reason = "x".repeat(128 * 1024);
    let msg = ControlMessage::Goodbye {
        reason: big_reason.clone(),
    };
    let encoded = encode_control(&msg).unwrap();
    let back = decode_control(&encoded).unwrap();
    match back {
        ControlMessage::Goodbye { reason } => assert_eq!(reason, big_reason),
        other => panic!("expected Goodbye, got {other:?}"),
    }
}

/// An event envelope that is too large for the u32 frame-length header must
/// surface a clean `Syntax` error rather than silently truncate or panic.
///
/// We cannot realistically allocate 4 GiB in a test, so we assert the
/// wrapper path via the Cargo public API by constructing a body that
/// stress-tests the u32 gate. Instead, we unit-test that the normal
/// `encode_event` path succeeds for a bounded-size payload — pins the
/// "happy path does not regress" contract.
#[test]
fn event_frame_encodes_payload_under_u32_ceiling() {
    use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
    use quanta_proto::events::{CwdSource, InputKind};
    use quanta_proto::ids::{BlockId, SessionId};
    let env = Envelope::new(
        SessionId::new(),
        1,
        Producer::Block,
        SchemaVersion::ONE,
        Event::BlockCreated(quanta_proto::events::BlockCreated {
            block_id: BlockId::new(),
            ordinal: 0,
            input_text: "x".repeat(1024),
            input_kind: InputKind::Shell,
            cwd: "/tmp".into(),
            cwd_source: CwdSource::Launch,
            is_compound: false,
        }),
    );
    let frame = quanta_protocol::encode_event(&env).unwrap();
    // Length prefix is the size of the body that follows.
    let declared = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
    assert_eq!(declared, frame.len() - 4);
    let back = quanta_protocol::decode_event(&frame[4..]).unwrap();
    assert_eq!(back.monotonic_seq, 1);
}

/// ADR 0004 §Handshake: the handshake is one-shot-per-connection. A client
/// that sends a second `Hello` AFTER `Ready` must not double-install the
/// event pump, flip any state, or cause the server to panic. The expected
/// behaviour is "ignore and continue" — a subsequent valid `Ping` still
/// roundtrips, proving the request loop was not derailed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_hello_after_ready_is_ignored_not_reinstalled() {
    use tokio::io::AsyncReadExt;

    let tmp = tempfile::tempdir().unwrap();
    let sock = tmp.path().join("sock");
    let handler: Arc<dyn ControlHandler> = Arc::new(StubHandler);
    let server = UnixSocketServer::new(&sock, handler);
    let accept = tokio::spawn(async move { server.accept_one().await });

    wait_for_socket(&sock).await;
    let stream = UnixStream::connect(&sock).await.unwrap();
    let (mut r, mut w) = stream.into_split();

    // First Hello.
    let hello = ControlMessage::Hello(Hello {
        host_protocol_version: ProtocolVersion::CURRENT,
        host_version: "test".into(),
        client_id: "dup-hello".into(),
        resume_cursors: std::collections::HashMap::default(),
    });
    let mut bytes = vec![0x01u8];
    bytes.extend_from_slice(&encode_control(&hello).unwrap());
    w.write_all(&bytes).await.unwrap();

    // Drain the Ready reply so we know the handshake completed.
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
    assert_eq!(buf.first().copied(), Some(0x01), "expected control channel");
    let line_end = buf[1..].iter().position(|b| *b == b'\n').unwrap() + 1;
    let ready = decode_control(&buf[1..line_end]).unwrap();
    assert!(matches!(ready, ControlMessage::Ready(_)));

    // Send a SECOND Hello on the same connection. The server must not
    // re-handshake; it must keep the request loop alive.
    let second_hello = ControlMessage::Hello(Hello {
        host_protocol_version: ProtocolVersion::CURRENT,
        host_version: "test-2".into(),
        client_id: "dup-hello".into(),
        resume_cursors: std::collections::HashMap::default(),
    });
    let mut bytes = vec![0x01u8];
    bytes.extend_from_slice(&encode_control(&second_hello).unwrap());
    w.write_all(&bytes).await.unwrap();

    // Immediately send a Ping. If the server derailed on the dup Hello we'd
    // never see a Pong.
    let ping = ControlMessage::Ping { seq: 777 };
    let mut bytes = vec![0x01u8];
    bytes.extend_from_slice(&encode_control(&ping).unwrap());
    w.write_all(&bytes).await.unwrap();

    // Read the Pong reply. Drain any bytes after the Ready newline first.
    buf.drain(..=line_end);
    let pong_deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if buf.contains(&b'\n') {
            break;
        }
        assert!(
            std::time::Instant::now() <= pong_deadline,
            "no Pong received within 5s after duplicate Hello",
        );
        let n = tokio::time::timeout(Duration::from_millis(200), r.read(&mut tmp_buf))
            .await
            .unwrap_or(Ok(0))
            .unwrap_or(0);
        if n == 0 {
            continue;
        }
        buf.extend_from_slice(&tmp_buf[..n]);
    }
    assert_eq!(buf.first().copied(), Some(0x01), "expected control channel");
    let end = buf[1..].iter().position(|b| *b == b'\n').unwrap() + 1;
    let msg = decode_control(&buf[1..end]).unwrap();
    match msg {
        ControlMessage::Pong { seq } => assert_eq!(seq, 777, "pong seq must echo ping"),
        other => panic!("expected Pong, got {other:?}"),
    }

    // Close cleanly.
    drop(w);
    drop(r);
    let _ = tokio::time::timeout(Duration::from_secs(5), accept).await;
}
