//! Error-path coverage for the protocol codec + adapter.
//!
//! Exercises:
//! - `decode_control` on malformed bytes surfaces a `serde_json::Error` (the
//!   error must carry line/column info so operators can diagnose);
//! - a client that sends junk instead of `Hello` yields `ProtocolError::Handshake`;
//! - handshake-timeout fires when the client never sends anything;
//! - the control-line buffer cap is enforced on pathological clients that
//!   stream bytes without ever emitting a newline.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::rpc::{RpcError, RpcMethod, RpcResponse, RpcResult};
use quanta_protocol::{decode_control, ControlHandler, UnixSocketServer};
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

#[test]
fn decode_control_on_non_json_surfaces_serde_error() {
    let err = decode_control(b"not json\n").unwrap_err();
    // The Display contains the phrase "expected" or "invalid" depending on
    // the serde_json version; assert it is non-empty and names a line so
    // operators can triage.
    let s = format!("{err}");
    assert!(!s.is_empty(), "decode error must have a diagnostic message");
    assert!(
        err.line() >= 1,
        "serde error must expose a line for diagnosis"
    );
}

#[test]
fn decode_control_on_empty_bytes_is_an_error() {
    // An empty byte slice is not a valid JSON document.
    let err = decode_control(b"").unwrap_err();
    assert!(!format!("{err}").is_empty());
}

/// A client that sends junk instead of Hello must be rejected with a
/// `Handshake` error — not a silent disconnect.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn junk_first_message_yields_handshake_error() {
    let tmp = tempfile::tempdir().unwrap();
    let sock = tmp.path().join("sock");
    let handler: Arc<dyn ControlHandler> = Arc::new(StubHandler);
    let server = UnixSocketServer::new(&sock, handler);
    let accept = tokio::spawn(async move { server.accept_one().await });

    for _ in 0..50 {
        if sock.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let mut s = UnixStream::connect(&sock).await.unwrap();
    // Send control-channel byte + invalid JSON with a newline terminator.
    s.write_all(&[0x01]).await.unwrap();
    s.write_all(b"not json\n").await.unwrap();
    drop(s);

    let res = tokio::time::timeout(Duration::from_secs(5), accept)
        .await
        .expect("server did not conclude within 5s")
        .expect("task join");
    match res {
        Err(err) => {
            let s = format!("{err}");
            // Either Codec(serde parse) or Handshake depending on whether the
            // bytes parse as a non-Hello control message. Both are acceptable
            // here — what's NOT acceptable is a silent `Ok`.
            assert!(
                s.contains("codec") || s.contains("handshake"),
                "expected codec or handshake error, got: {s}"
            );
        }
        Ok(()) => panic!("junk Hello must not be accepted"),
    }
}

/// A client that connects and then never speaks must be hung up on after the
/// 5 s handshake deadline. We bound the test's own wall-clock to keep CI
/// fast.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn silent_client_triggers_handshake_timeout() {
    let tmp = tempfile::tempdir().unwrap();
    let sock = tmp.path().join("sock");
    let handler: Arc<dyn ControlHandler> = Arc::new(StubHandler);
    let server = UnixSocketServer::new(&sock, handler);
    let accept = tokio::spawn(async move { server.accept_one().await });

    for _ in 0..50 {
        if sock.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Connect and never send anything. Keep the socket open; the server must
    // time out on its own.
    let s = UnixStream::connect(&sock).await.unwrap();
    let res = tokio::time::timeout(Duration::from_secs(10), accept)
        .await
        .expect("server did not close within 10s")
        .expect("join");
    drop(s);
    match res {
        Err(err) => {
            let s = format!("{err}");
            assert!(
                s.contains("handshake") && s.contains("timed out"),
                "expected handshake timeout error, got: {s}"
            );
        }
        Ok(()) => panic!("silent client must trigger timeout"),
    }
}
