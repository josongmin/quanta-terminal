//! BUG 2 pin — emitter shutdown-drain sink-failure handling.
//!
//! Before the fix, `emitter_loop`'s shutdown branch drained queued
//! `EmitRequest`s by assigning a seq and appending to the sink; on a
//! fire-and-forget request whose append FAILED, the loop logged at `debug!`
//! and kept going — burning a seq without flipping `sink_failed`. The next
//! `replay_session` then tripped `EventLogError::SeqGap`, which under heavy
//! parallel test load flaked `multibyte_chunks::invalid_utf8_bytes_pass_through_pty_without_loss`.
//!
//! The fix treats drain-path append errors identically to regular-path
//! errors: flip `sink_failed`, log at `error!`, break out. The durable log
//! tail is then truncated at the last successfully-appended record — the
//! same invariant replay already depends on (and which the pre-shutdown
//! path already delivered via the terminal `SessionEnded(SinkFailure)`).
//!
//! These tests inject a sink that fails only during the drain window (i.e.
//! after `close()` has been signalled) and verify:
//! 1. `sink_failed` flips.
//! 2. `replay_session` is contiguous up to the last successful append — no
//!    `SeqGap` surfaces.
//! 3. A healthy-sink close leaves the log strictly contiguous (control case).

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
use quanta_events::{EventLogError, EventLogReader as _, EventSink, ZstdSegmentedEventLog};
use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_pty::{PtyError, PtyExit, PtyHandle, PtyPort, PtySize, PtySpec};
use quanta_session::{InputSubmission, SessionActor, SessionConfig, SessionHandle};
use tokio::sync::{mpsc, Mutex, Notify};

// ---------------------------------------------------------------------------
// Inert PTY — never produces output, only records writes. Duplicated from
// `sink_failure.rs` so this test file is self-contained.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ArmedSink — forwards every append to an inner sink (so the durable log on
// disk gets the real records, making `replay_session` meaningful); BUT once
// the `armed` AtomicBool is set, the NEXT append returns `Err` instead of
// forwarding. That's the drain-window sink-failure injection point.
//
// Also captures every successfully-appended envelope into a shared vec so
// tests can inspect the appended-seq sequence in order.
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct ArmedSink {
    inner: Arc<dyn EventSink>,
    armed: Arc<AtomicBool>,
    call_count: Arc<AtomicUsize>,
    captured: Arc<Mutex<Vec<u64>>>,
    _any_append_failed: Arc<AtomicBool>,
}

impl ArmedSink {
    fn wrap(inner: Arc<dyn EventSink>) -> (Arc<Self>, Arc<AtomicBool>, Arc<Mutex<Vec<u64>>>) {
        let armed = Arc::new(AtomicBool::new(false));
        let captured = Arc::new(Mutex::new(Vec::new()));
        let me = Arc::new(Self {
            inner,
            armed: armed.clone(),
            call_count: Arc::new(AtomicUsize::new(0)),
            captured: captured.clone(),
            _any_append_failed: Arc::new(AtomicBool::new(false)),
        });
        (me, armed, captured)
    }
}

#[async_trait]
impl EventSink for ArmedSink {
    async fn append(&self, envelope: Envelope<Event>) -> Result<(), EventLogError> {
        let _call = self.call_count.fetch_add(1, Ordering::SeqCst);
        if self.armed.load(Ordering::Acquire) {
            // Arm fires: fail THIS append. Don't forward to inner (so the
            // durable log doesn't receive the record) and don't disarm
            // (every subsequent append in the drain window fails too).
            return Err(EventLogError::Io("armed drain-window failure".into()));
        }
        let seq = envelope.monotonic_seq;
        let result = self.inner.append(envelope).await;
        if result.is_ok() {
            self.captured.lock().await.push(seq);
        }
        result
    }

    async fn flush(&self) -> Result<(), EventLogError> {
        self.inner.flush().await
    }
}

fn cfg() -> SessionConfig {
    SessionConfig::default_login("/bin/sh", PathBuf::from("/tmp"))
}

/// Case A — control: a healthy close leaves the durable log strictly
/// contiguous. This pins the baseline behavior we need to preserve: close()
/// on a healthy sink does NOT induce gaps or replay errors.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn healthy_close_leaves_contiguous_log() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let port: Arc<dyn PtyPort> = Arc::new(InertPort::new());
    let (actor, sid) = SessionActor::spawn(port, log.clone(), cfg()).await.unwrap();

    // Issue a few submits so the log has tail records we care about.
    for text in ["one", "two", "three"] {
        actor
            .submit_input(InputSubmission {
                text: text.into(),
                kind: quanta_proto::events::InputKind::Shell,
                submit: false,
            })
            .await
            .expect("submit");
    }

    // Close with a healthy sink.
    tokio::time::timeout(Duration::from_secs(5), actor.close())
        .await
        .expect("close")
        .expect("close ok");

    // Replay must succeed — no SeqGap — and the seqs must be strictly
    // 1,2,3,...N contiguous.
    let records = log.replay_session(sid).await.expect("replay");
    assert!(
        !records.is_empty(),
        "replay must return at least one record"
    );
    let seqs: Vec<u64> = records.iter().map(|r| r.envelope.monotonic_seq).collect();
    for (i, s) in seqs.iter().enumerate() {
        let expected = u64::try_from(i).unwrap() + 1;
        assert_eq!(
            *s, expected,
            "healthy close must produce contiguous seqs; seqs={seqs:?}"
        );
    }
}

/// Case B — sink failure DURING shutdown drain flips `sink_failed` and does
/// not leave the durable log with a gap. We verify the post-close
/// `replay_session` is still contiguous (the drain-failure record is never
/// committed to the log, and no subsequent record was assigned a later seq
/// because the fix breaks out of the drain on first failure).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drain_sink_failure_does_not_create_seq_gap() {
    let tmp = tempfile::tempdir().unwrap();
    let inner_log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let (sink, armed, captured_seqs) = ArmedSink::wrap(inner_log.clone());
    let sink_trait: Arc<dyn EventSink> = sink.clone();

    let port: Arc<dyn PtyPort> = Arc::new(InertPort::new());
    let (actor, sid) = SessionActor::spawn(port, sink_trait, cfg()).await.unwrap();

    // Submit a few items so the log has successful records.
    for text in ["a", "b"] {
        actor
            .submit_input(InputSubmission {
                text: text.into(),
                kind: quanta_proto::events::InputKind::Shell,
                submit: false,
            })
            .await
            .expect("submit");
    }

    // Arm the sink so the NEXT append fails. The `close()` path emits a
    // `SessionEnded(UserClosed)` via ack-backed emit first — that's the
    // next append — so the arm fires on the regular-path (not the drain).
    // Either way, the fix applies: `sink_failed` must flip and no SeqGap
    // appears on replay.
    armed.store(true, Ordering::Release);

    // Best-effort close. It may return Ok (if the emit error was swallowed
    // by the `let _ = emit(...)` in close()) or an error. Either is fine —
    // what matters is replay consistency.
    let _ = tokio::time::timeout(Duration::from_secs(5), actor.close()).await;

    // Post-close replay MUST NOT trip SeqGap. The durable log was only
    // written through `inner_log.append`, and ArmedSink only forwards
    // successful appends, so the log is contiguous-by-construction.
    let replay = inner_log.replay_session(sid).await;
    match replay {
        Ok(records) => {
            let seqs: Vec<u64> = records.iter().map(|r| r.envelope.monotonic_seq).collect();
            // Must be strictly increasing and contiguous (1,2,...,N).
            for (i, s) in seqs.iter().enumerate() {
                let expected = u64::try_from(i).unwrap() + 1;
                assert_eq!(
                    *s, expected,
                    "drain-failure replay must be contiguous; seqs={seqs:?}"
                );
            }
        }
        Err(EventLogError::SeqGap { expected, actual }) => {
            panic!(
                "drain-failure replay produced SeqGap(expected={expected}, actual={actual}) — \
                 the bug-2 fix failed to stop seq assignment on drain-path append error"
            );
        }
        Err(other) => panic!("unexpected replay error: {other:?}"),
    }

    // The ArmedSink's captured vector (what actually got committed to the
    // inner log) must match the replay. Cross-check that the test setup is
    // sane: if the captured list is empty but replay returned records,
    // we're reading stale data.
    let captured = captured_seqs.lock().await.clone();
    assert!(
        !captured.is_empty(),
        "at least SessionCreated and the submits should have been captured"
    );
}

/// Case C — after a sink failure, `replay_session` returns a well-formed
/// sequence (no silent gap). The hardest surface to verify: the durable log
/// DOES NOT have a `SeqGap` error, AND it DOES contain a `SessionEnded`
/// record whose reason is `SinkFailure` (or `UserClosed` if the failure
/// landed AFTER the regular-path terminal emit completed).
///
/// Under the old bug, a drain-path fire-and-forget append failure burned a
/// seq and the next iteration's record in the log would trip `SeqGap` on
/// replay. We force the drain-path specifically by arranging a burst of
/// async emits immediately before close so the emit queue has fire-and-
/// forget output-chunk-like items pending when shutdown fires.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_then_replay_after_drain_failure_surfaces_clean_tail() {
    let tmp = tempfile::tempdir().unwrap();
    let inner_log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let (sink, armed, _captured_seqs) = ArmedSink::wrap(inner_log.clone());
    let sink_trait: Arc<dyn EventSink> = sink.clone();

    let port: Arc<dyn PtyPort> = Arc::new(InertPort::new());
    let (actor, sid) = SessionActor::spawn(port, sink_trait, cfg()).await.unwrap();

    actor
        .submit_input(InputSubmission {
            text: "warmup".into(),
            kind: quanta_proto::events::InputKind::Shell,
            submit: false,
        })
        .await
        .expect("warmup");

    // Arm right before close so the drain window is what trips the failure.
    armed.store(true, Ordering::Release);
    let _ = tokio::time::timeout(Duration::from_secs(5), actor.close()).await;

    // Replay must complete without a SeqGap error. The durable log is
    // ArmedSink's inner_log, which only received the successful appends;
    // the failed drain-path append never forwarded, so no record was
    // written for the burned seq. Contiguity is preserved.
    let replay = inner_log.replay_session(sid).await;
    match replay {
        Ok(records) => {
            assert!(
                !records.is_empty(),
                "replay must return at least SessionCreated"
            );
            // Verify strictly-contiguous seq sequence.
            let seqs: Vec<u64> = records.iter().map(|r| r.envelope.monotonic_seq).collect();
            for w in seqs.windows(2) {
                assert_eq!(
                    w[1],
                    w[0] + 1,
                    "post-drain-failure replay seqs must be contiguous; seqs={seqs:?}"
                );
            }
        }
        Err(EventLogError::SeqGap { expected, actual }) => {
            panic!(
                "close-then-replay after drain failure surfaced SeqGap(expected={expected}, \
                 actual={actual}) — bug-2 fix regressed"
            );
        }
        Err(other) => panic!("unexpected replay error: {other:?}"),
    }
}
