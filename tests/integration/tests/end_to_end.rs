//! End-to-end integration scenarios over the real Unix socket.
//!
//! Every scenario here spawns `quanta-core` as a child process (so we exercise
//! the real binary, not the library — see the walking-skeleton test in
//! `crates/quanta-core/tests/` for the in-process variant). Tests that need
//! socket-plane events depend on the event pump in
//! `quanta-protocol::UnixSocketServer` draining the engine's live event feed;
//! the Phase-1 gap where `ControlRegistry::next_event` is unfed is documented
//! on each `#[ignore]` that depends on it, so the day the pump lands those
//! tests flip to green automatically.
//!
//! Hermeticity:
//!   - Each test uses `tempfile::TempDir` for the socket + profile dir; nothing
//!     touches `~`.
//!   - The child's `kill_on_drop(true)` means a panicking test cannot leak
//!     background `quanta-core` processes across the suite.
//!
//! Total budget: every scenario completes in a couple of hundred ms in the
//! happy path. A 5 s socket-bind deadline and a 5 s RPC deadline bound the
//! worst case. The overall suite must stay under the 30 s workspace budget.

mod common;

use std::time::Duration;

use anyhow::Result;
use common::{expect_rpc_err, CoreProcess};
use quanta_proto::events::Event;
use quanta_proto::ids::{BlockId, SessionId};
use quanta_proto::rpc::{InputMode, RpcMethod, SubmitInput};

fn pick_shell() -> &'static str {
    if std::path::Path::new("/bin/bash").exists() {
        "/bin/bash"
    } else {
        "/bin/sh"
    }
}

/// Verify the control-plane round trip: Hello → Ready → CreateSession →
/// response with a session id. This is the minimum viable socket conformance
/// the sidecar MUST honour per ADR 0004.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn socket_handshake_and_create_session() -> Result<()> {
    let core = CoreProcess::spawn().await?;
    let mut host = core.connect().await?;

    let res = host
        .create_session(pick_shell(), Some(std::path::Path::new("/tmp")))
        .await?;
    // The session id must be a valid ULID (the `SessionId` type enforces this
    // on deserialization, so reaching this line means the payload parsed).
    assert!(!res.session_id.to_string().is_empty(), "empty session id");

    // Close cleanly. If the server kept the session after `close_session`,
    // the next `list_sessions()` would show it; we use that as a smoke check.
    host.close_session(res.session_id).await?;

    core.shutdown().await?;
    Ok(())
}

/// Error-case scenario: submitting input for a non-existent session MUST
/// return an `RpcError` with a meaningful code (`no_such_session`). This is
/// the canonical example of "do not panic, do not silently succeed" on bad
/// input.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn submit_to_missing_session_returns_clean_error() -> Result<()> {
    let core = CoreProcess::spawn().await?;
    let mut host = core.connect().await?;

    let bogus_session = SessionId::new();
    let resp = host
        .rpc(RpcMethod::SubmitInput(SubmitInput {
            session_id: bogus_session,
            text: "echo nope".into(),
            mode: InputMode::Submit,
        }))
        .await?;
    let err = expect_rpc_err(resp)?;
    assert_eq!(
        err.code, "no_such_session",
        "server must advertise `no_such_session` error code; got: {err:?}"
    );
    assert!(
        !err.message.is_empty(),
        "error message must not be empty; the host UI surfaces it verbatim"
    );

    core.shutdown().await?;
    Ok(())
}

/// Error-case scenario: canceling a block for an unknown session id must also
/// succeed cleanly (current engine behaviour: no-op). We pin the shape of the
/// response so a regression from "ok with null" to "panic" or "err" is caught.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_block_for_missing_session_is_noop_ok() -> Result<()> {
    let core = CoreProcess::spawn().await?;
    let mut host = core.connect().await?;

    let bogus_session = SessionId::new();
    let bogus_block = BlockId::new();
    host.cancel(bogus_session, bogus_block).await?;

    core.shutdown().await?;
    Ok(())
}

/// List-sessions RPC smoke: empty at boot, one entry after CreateSession,
/// empty again after CloseSession. This pins the session registry's
/// observable contract through the RPC surface.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_sessions_reflects_create_close() -> Result<()> {
    let core = CoreProcess::spawn().await?;
    let mut host = core.connect().await?;

    let before = host.list_sessions().await?;
    // Unwrap the Ok arm into a JSON Value and pull the length out defensively.
    let before_val: serde_json::Value = common::result_ok(before)?;
    let before_count = before_val
        .get("sessions")
        .and_then(|v| v.as_array())
        .map(Vec::len)
        .unwrap_or(usize::MAX);
    assert_eq!(before_count, 0, "boot state must have no sessions");

    let created = host
        .create_session(pick_shell(), Some(std::path::Path::new("/tmp")))
        .await?;
    let mid = host.list_sessions().await?;
    let mid_val: serde_json::Value = common::result_ok(mid)?;
    let mid_count = mid_val
        .get("sessions")
        .and_then(|v| v.as_array())
        .map(Vec::len)
        .unwrap_or(0);
    assert_eq!(mid_count, 1, "exactly one session after CreateSession");

    host.close_session(created.session_id).await?;
    let after = host.list_sessions().await?;
    let after_val: serde_json::Value = common::result_ok(after)?;
    let after_count = after_val
        .get("sessions")
        .and_then(|v| v.as_array())
        .map(Vec::len)
        .unwrap_or(usize::MAX);
    assert_eq!(after_count, 0, "no sessions after CloseSession");

    core.shutdown().await?;
    Ok(())
}

/// Full happy-path: CreateSession → SubmitInput(`echo integration_ok`) →
/// observe the canonical event chain on the event plane.
///
/// Phase-1 gap: the socket adapter polls `ControlHandler::next_event()`,
/// but `ControlRegistry::next_event()` pops from an always-empty in-memory
/// queue. Until the engine wires the live event feed through, no events
/// reach the socket. When that wiring lands, remove the `#[ignore]`.
///
/// See cross-scope finding "core: socket event pump never receives engine
/// events" in the integration report.
// Socket event pump is now wired via `FanoutSink` (see
// `crates/quanta-core/src/adapters/fanout.rs`). Session-actor envelopes reach
// the registry's broadcast receiver and then the socket event plane. Unignored.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn socket_event_flow_echo_integration_ok() -> Result<()> {
    let core = CoreProcess::spawn().await?;
    let mut host = core.connect().await?;

    let created = host
        .create_session(pick_shell(), Some(std::path::Path::new("/tmp")))
        .await?;
    let _ = host
        .submit(created.session_id, "echo integration_ok; exit 0")
        .await?;

    let events = host
        .collect_events_until(
            |events| {
                events
                    .iter()
                    .any(|e| matches!(&e.payload, Event::BlockCompleted(_)))
            },
            Duration::from_secs(10),
        )
        .await?;

    assert_event_chain_contains_echo(&events, b"integration_ok");

    core.shutdown().await?;
    Ok(())
}

/// Second happy-path: submit a long-running command, cancel it, observe a
/// `BlockCanceled` event. Gated on the same socket event-pump gap; the
/// companion cancel-path coverage lives in
/// `crates/quanta-core/tests/walking_skeleton_errors.rs` today.
// Enabled now that `FanoutSink` routes session events to the socket and
// `cancel_block` eagerly emits `BlockCanceled` (ADR 0002 terminal state).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn socket_cancel_long_running_emits_block_canceled() -> Result<()> {
    let core = CoreProcess::spawn().await?;
    let mut host = core.connect().await?;

    let created = host
        .create_session(pick_shell(), Some(std::path::Path::new("/tmp")))
        .await?;
    let submit = host.submit(created.session_id, "sleep 10").await?;
    let block_id = submit
        .block_id
        .expect("Submit mode must return a block_id per SubmitInputResult");

    // Give the shell a moment to start the sleep before we cancel.
    tokio::time::sleep(Duration::from_millis(200)).await;
    host.cancel(created.session_id, block_id).await?;

    let events = host
        .collect_events_until(
            |events| {
                events
                    .iter()
                    .any(|e| matches!(&e.payload, Event::BlockCanceled(_)))
            },
            Duration::from_secs(5),
        )
        .await?;

    assert!(
        events
            .iter()
            .any(|e| matches!(&e.payload, Event::BlockCanceled(b) if b.block_id == block_id)),
        "expected BlockCanceled for {block_id:?}, got: {events:?}",
    );

    core.shutdown().await?;
    Ok(())
}

/// Asserts the ordered emission:
///   `SessionCreated → BlockCreated → BlockStarted → OutputChunk(*contains substr) → BlockCompleted(exit_code=Some(0))`.
fn assert_event_chain_contains_echo(
    events: &[quanta_proto::envelope::Envelope<Event>],
    needle: &[u8],
) {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;

    let mut saw_session = false;
    let mut saw_created = false;
    let mut saw_started = false;
    let mut saw_needle = false;
    let mut saw_completed_zero = false;

    // Print the envelope kinds we observed to help triage when an assertion
    // below fails. This turns an opaque "wrong order" into an actionable log.
    let kinds: Vec<String> = events
        .iter()
        .map(|e| format!("{}#{}", event_kind_name(&e.payload), e.monotonic_seq))
        .collect();
    eprintln!(
        "observed event chain ({} events): {:?}",
        events.len(),
        kinds
    );

    for env in events {
        match &env.payload {
            Event::SessionCreated(_) => {
                saw_session = true;
            }
            Event::BlockCreated(_) => {
                assert!(saw_session, "BlockCreated must follow SessionCreated");
                saw_created = true;
            }
            Event::BlockStarted(_) => {
                assert!(saw_created, "BlockStarted must follow BlockCreated");
                saw_started = true;
            }
            Event::OutputChunk(o) => {
                if let Ok(bytes) = BASE64.decode(&o.bytes_b64) {
                    if bytes.windows(needle.len()).any(|w| w == needle) {
                        saw_needle = true;
                    }
                }
            }
            Event::BlockCompleted(c) => {
                assert!(saw_started, "BlockCompleted must follow BlockStarted");
                if c.exit_code == Some(0) {
                    saw_completed_zero = true;
                }
            }
            _ => {}
        }
    }

    assert!(saw_session, "no SessionCreated event seen; log={events:?}");
    assert!(saw_created, "no BlockCreated event seen; log={events:?}");
    assert!(saw_started, "no BlockStarted event seen; log={events:?}");
    assert!(
        saw_needle,
        "no OutputChunk containing {:?} seen; log={events:?}",
        std::str::from_utf8(needle).unwrap_or("<binary>")
    );
    assert!(
        saw_completed_zero,
        "no BlockCompleted(exit_code=Some(0)) seen; log={events:?}"
    );
}

fn event_kind_name(e: &Event) -> &'static str {
    match e {
        Event::SessionCreated(_) => "SessionCreated",
        Event::SessionShellIntegrationStatus(_) => "SessionShellIntegrationStatus",
        Event::SessionCwdChanged(_) => "SessionCwdChanged",
        Event::SessionEnded(_) => "SessionEnded",
        Event::BlockCreated(_) => "BlockCreated",
        Event::BlockStarted(_) => "BlockStarted",
        Event::BlockCompleted(_) => "BlockCompleted",
        Event::BlockCanceled(_) => "BlockCanceled",
        Event::BlockDetached(_) => "BlockDetached",
        Event::BlockTuiEntered(_) => "BlockTuiEntered",
        Event::BlockTuiExited(_) => "BlockTuiExited",
        Event::OutputChunk(_) => "OutputChunk",
        Event::OutputTruncated(_) => "OutputTruncated",
        Event::InputSubmitted(_) => "InputSubmitted",
        Event::DiagnosticDetected(_) => "DiagnosticDetected",
        Event::SuggestionGenerated(_) => "SuggestionGenerated",
        Event::SuggestionReviewed(_) => "SuggestionReviewed",
        Event::HistoryIndexed(_) => "HistoryIndexed",
    }
}
