//! FIX 1 — actor fail-closed behavior on sink append errors.
//!
//! These tests pin the protocol described in
//! [`SessionActor::spawn_with_detector`] and the `emitter_loop` doc: once the
//! durable sink rejects an append, the actor must:
//!
//! 1. Attempt a best-effort terminal `SessionEnded { SinkFailure }` record.
//! 2. Surface `SessionError::Closed` on every subsequent `submit_input` so
//!    callers stop queueing writes against a corrupted log.
//! 3. Keep `close()` idempotent — the second caller observes `Ok(())` without
//!    triggering a second emit / join pass.
//!
//! The sink used here is a test-local `FailingSink` that fails a specific
//! nth append; no real disk IO. A separate in-memory capture lets tests
//! inspect what DID get appended (the actor is expected to commit a terminal
//! `SessionEnded(SinkFailure)` even after the first failure — the sink injects
//! the failure on the FIRST `submit_input` ack-backed append, not on the
//! terminal one).

#![allow(
    clippy::doc_markdown,
    clippy::match_same_arms,
    clippy::type_complexity,
    clippy::redundant_closure_for_method_calls,
    reason = "test file uses inline ADR mentions in prose and minor pattern duplication for clarity"
)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use quanta_events::{EventLogError, EventSink};
use quanta_proto::envelope::Envelope;
use quanta_proto::events::{Event, InputKind, SessionEndReason};
use quanta_pty::{PtyError, PtyExit, PtyHandle, PtyPort, PtySize, PtySpec};
use quanta_session::{InputSubmission, SessionActor, SessionConfig, SessionError, SessionHandle};
use tokio::sync::{mpsc, Mutex, Notify};

/// A mock PTY handle that never produces output and only records writes.
/// Mirrors the minimal one in `stress_actor.rs` — duplicated here so this
/// test file can live in its own crate test target without an integration
/// binary dependency on the other file.
#[derive(Debug)]
struct InertPty {
    read_rx: Mutex<mpsc::UnboundedReceiver<Vec<u8>>>,
    closed: Arc<Notify>,
    is_closed: Arc<tokio::sync::Mutex<bool>>,
}

#[async_trait]
impl PtyHandle for InertPty {
    async fn read(&mut self, _buf: &mut [u8]) -> Result<usize, PtyError> {
        if *self.is_closed.lock().await {
            return Err(PtyError::Closed);
        }
        let mut guard = self.read_rx.lock().await;
        match tokio::time::timeout(Duration::from_millis(25), guard.recv()).await {
            Ok(Some(_)) => Ok(0),
            Ok(None) => Err(PtyError::Closed),
            Err(_) => Ok(0),
        }
    }

    async fn write_all(&mut self, _data: &[u8]) -> Result<(), PtyError> {
        Ok(())
    }

    async fn resize(&mut self, _size: PtySize) -> Result<(), PtyError> {
        Ok(())
    }

    async fn wait(&mut self) -> Result<PtyExit, PtyError> {
        if *self.is_closed.lock().await {
            return Ok(PtyExit::code(0));
        }
        self.closed.notified().await;
        Ok(PtyExit::code(0))
    }

    async fn kill(&mut self) -> Result<(), PtyError> {
        *self.is_closed.lock().await = true;
        self.closed.notify_waiters();
        Ok(())
    }

    fn pid(&self) -> Option<u32> {
        None
    }
}

#[derive(Debug)]
struct InertPort {
    inner: Mutex<
        Option<(
            mpsc::UnboundedReceiver<Vec<u8>>,
            Arc<Notify>,
            Arc<tokio::sync::Mutex<bool>>,
        )>,
    >,
}

impl InertPort {
    fn new() -> Self {
        let (_tx, rx) = mpsc::unbounded_channel();
        let closed = Arc::new(Notify::new());
        let is_closed = Arc::new(tokio::sync::Mutex::new(false));
        Self {
            inner: Mutex::new(Some((rx, closed, is_closed))),
        }
    }
}

#[async_trait]
impl PtyPort for InertPort {
    async fn open(&self, _spec: PtySpec) -> Result<Box<dyn PtyHandle>, PtyError> {
        let (rx, closed, is_closed) = self
            .inner
            .lock()
            .await
            .take()
            .ok_or_else(|| PtyError::Spawn("inert port: already opened".into()))?;
        Ok(Box::new(InertPty {
            read_rx: Mutex::new(rx),
            closed,
            is_closed,
        }))
    }
}

/// A sink that succeeds until its internal counter hits `fail_at`, then fails
/// the next N appends (configurable), then continues succeeding. Captures all
/// appended envelopes into a shared vec so tests can inspect what landed.
///
/// The terminal `SessionEnded(SinkFailure)` that the actor tries after the
/// first failure should still succeed — this pins the protocol: the durable
/// log gets a clean boundary marker even after a mid-session sink failure.
#[derive(Debug)]
struct FailingSink {
    fail_at: usize,
    fail_count: usize,
    call_count: Arc<AtomicUsize>,
    captured: Arc<Mutex<Vec<Envelope<Event>>>>,
    any_append_failed: Arc<AtomicBool>,
}

impl FailingSink {
    fn new(fail_at: usize, fail_count: usize) -> Arc<Self> {
        Arc::new(Self {
            fail_at,
            fail_count,
            call_count: Arc::new(AtomicUsize::new(0)),
            captured: Arc::new(Mutex::new(Vec::new())),
            any_append_failed: Arc::new(AtomicBool::new(false)),
        })
    }

    fn captured(&self) -> Arc<Mutex<Vec<Envelope<Event>>>> {
        self.captured.clone()
    }
}

#[async_trait]
impl EventSink for FailingSink {
    async fn append(&self, envelope: Envelope<Event>) -> Result<(), EventLogError> {
        let call = self.call_count.fetch_add(1, Ordering::SeqCst);
        if call >= self.fail_at && call < self.fail_at + self.fail_count {
            self.any_append_failed.store(true, Ordering::SeqCst);
            return Err(EventLogError::Io(format!(
                "injected sink failure at call {call}"
            )));
        }
        self.captured.lock().await.push(envelope);
        Ok(())
    }

    async fn flush(&self) -> Result<(), EventLogError> {
        Ok(())
    }
}

fn cfg() -> SessionConfig {
    SessionConfig::default_login("/bin/sh", PathBuf::from("/tmp"))
}

/// Core invariant: when the sink fails on the 3rd append, the actor must
/// emit a terminal `SessionEnded { SinkFailure }` (best-effort, on the 4th
/// append which succeeds) and subsequent `submit_input` calls must return
/// `SessionError::Closed` — NOT hang forever.
///
/// We arrange the fail window to cover exactly the 3rd append. The first
/// two appends are:
///   1. `SessionCreated` (on spawn)
///   2. `InputSubmitted` for the first passthrough submit
/// The 3rd append is the ack-backed one for the second submit; that's where
/// we inject the failure. The emitter then tries to append
/// `SessionEnded(SinkFailure)` — which is call #4 and NOT in the fail window,
/// so it lands in the capture vec.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sink_failure_on_third_append_emits_sink_failure_and_closes() {
    let sink = FailingSink::new(2, 1);
    let captured = sink.captured();
    let sink_trait: Arc<dyn EventSink> = sink.clone();
    let port: Arc<dyn PtyPort> = Arc::new(InertPort::new());
    let (actor, _sid) = SessionActor::spawn(port, sink_trait, cfg()).await.unwrap();

    // First submit — append index 1 (InputSubmitted) — succeeds.
    actor
        .submit_input(InputSubmission {
            text: "first".into(),
            kind: InputKind::Shell,
            submit: false,
        })
        .await
        .expect("first submit must succeed");

    // Second submit — append index 2 (InputSubmitted) — fails. The actor
    // must surface the sink error to the caller (it's ack-backed).
    let err = actor
        .submit_input(InputSubmission {
            text: "second".into(),
            kind: InputKind::Shell,
            submit: false,
        })
        .await
        .expect_err("second submit must surface the sink error");
    match err {
        SessionError::EventLog(EventLogError::Io(msg)) => {
            assert!(
                msg.contains("injected"),
                "expected injected-failure message, got: {msg}"
            );
        }
        other => panic!("expected EventLog(Io) from injected failure; got {other:?}"),
    }

    // Give the emitter a moment to flush its terminal SessionEnded.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Third submit — must return Closed immediately.
    let err = actor
        .submit_input(InputSubmission {
            text: "third".into(),
            kind: InputKind::Shell,
            submit: false,
        })
        .await
        .expect_err("post-failure submit must fast-fail");
    assert!(
        matches!(err, SessionError::Closed),
        "expected Closed; got {err:?}"
    );

    // The captured vec must include a SessionEnded(SinkFailure).
    let envs = captured.lock().await.clone();
    let sink_failure_count = envs
        .iter()
        .filter(|e| {
            matches!(
                e.payload,
                Event::SessionEnded(ref s) if matches!(s.reason, SessionEndReason::SinkFailure)
            )
        })
        .count();
    assert_eq!(
        sink_failure_count, 1,
        "expected exactly one SessionEnded(SinkFailure); captured: {envs:#?}"
    );

    // Cleanup.
    tokio::time::timeout(Duration::from_secs(5), actor.close())
        .await
        .expect("close must not hang post-failure")
        .expect("close must return Ok even on a failed session");
}

/// The `monotonic_seq` counter must NOT double-increment: the failed append's
/// seq is burned, and the terminal `SessionEnded(SinkFailure)` takes the next
/// one. So the captured records' seqs are a strictly-increasing sequence
/// with exactly one gap (at the failed-index position).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sink_failure_does_not_double_increment_seq() {
    let sink = FailingSink::new(2, 1);
    let captured = sink.captured();
    let sink_trait: Arc<dyn EventSink> = sink.clone();
    let port: Arc<dyn PtyPort> = Arc::new(InertPort::new());
    let (actor, _sid) = SessionActor::spawn(port, sink_trait, cfg()).await.unwrap();

    actor
        .submit_input(InputSubmission {
            text: "first".into(),
            kind: InputKind::Shell,
            submit: false,
        })
        .await
        .expect("first submit");

    let _ = actor
        .submit_input(InputSubmission {
            text: "second".into(),
            kind: InputKind::Shell,
            submit: false,
        })
        .await;

    tokio::time::sleep(Duration::from_millis(50)).await;

    let envs = captured.lock().await.clone();
    // Envelope seqs we observe are 1 (SessionCreated), 2 (InputSubmitted for
    // "first"), and 4 (SessionEnded(SinkFailure) — because 3 was burned).
    // That's a single-unit gap between 2 and 4, which is exactly the
    // protocol: "assigned seq → attempt append → on fail, fail the session".
    let seqs: Vec<u64> = envs.iter().map(|e| e.envelope_seq()).collect();
    assert!(!seqs.is_empty(), "some envelopes must have been captured");
    // Strictly increasing:
    for pair in seqs.windows(2) {
        assert!(
            pair[1] > pair[0],
            "seqs must be strictly increasing: {pair:?}"
        );
    }
    // Exactly one gap, and the gap is exactly 1 wide (the burned seq).
    let gaps: Vec<u64> = seqs
        .windows(2)
        .filter_map(|p| {
            let d = p[1] - p[0];
            if d > 1 {
                Some(d)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        gaps.len(),
        1,
        "expected exactly one gap (the burned seq); seqs={seqs:?}"
    );
    assert_eq!(
        gaps[0], 2,
        "the gap must be width 2 (next - prev), i.e. one burned seq; seqs={seqs:?}"
    );

    let _ = tokio::time::timeout(Duration::from_secs(5), actor.close()).await;
}

/// `close()` after a sink-induced fail-closed must still return `Ok(())`.
/// Pins the idempotency contract: a UI / supervisor racing to clean up a
/// failed session should never see an error that would re-trigger close.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_after_sink_failure_is_idempotent() {
    let sink = FailingSink::new(2, 1);
    let sink_trait: Arc<dyn EventSink> = sink.clone();
    let port: Arc<dyn PtyPort> = Arc::new(InertPort::new());
    let (actor, _sid) = SessionActor::spawn(port, sink_trait, cfg()).await.unwrap();

    actor
        .submit_input(InputSubmission {
            text: "first".into(),
            kind: InputKind::Shell,
            submit: false,
        })
        .await
        .expect("first submit");
    let _ = actor
        .submit_input(InputSubmission {
            text: "second".into(),
            kind: InputKind::Shell,
            submit: false,
        })
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    // First close must succeed (idempotent with the fail-closed path).
    tokio::time::timeout(Duration::from_secs(5), actor.close())
        .await
        .expect("first close must not hang")
        .expect("first close must return Ok");

    // Second close must also succeed — documented idempotency.
    tokio::time::timeout(Duration::from_secs(5), actor.close())
        .await
        .expect("second close must not hang")
        .expect("second close must also return Ok");
}

// Extension trait: expose envelope.monotonic_seq via a stable name for the
// test above without pulling the raw field import path into scope. The
// `Envelope<Event>` type is public in `quanta_proto::envelope` but the
// monotonic_seq field uses the obvious name — we alias via a small helper.
trait EnvelopeSeqExt {
    fn envelope_seq(&self) -> u64;
}

impl EnvelopeSeqExt for Envelope<Event> {
    fn envelope_seq(&self) -> u64 {
        self.monotonic_seq
    }
}
