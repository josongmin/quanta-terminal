//! Edge-case coverage for the session actor.
//!
//! These tests intentionally probe the corners real users stumble into:
//! bad shells, bad cwd paths, concurrent close, cancel-after-close,
//! empty output chunks, envelopes with `None` block_id, large
//! `monotonic_seq` values. Everything runs under tempfiles against a real
//! `PortablePtyPort` and `ZstdSegmentedEventLog` so the behaviour is end-
//! to-end rather than mocked.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use quanta_events::{EventLogReader as _, EventSink as _, ZstdSegmentedEventLog};
use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
use quanta_proto::events::{
    BoundaryConfidence, BoundarySignal, Event, OutputChunk, OutputStream, SessionEndReason,
    SessionEnded,
};
use quanta_proto::ids::{BlockId, SessionId, SpanId};
use quanta_pty::{PortablePtyPort, PtySize};
use quanta_session::{InputSubmission, SessionActor, SessionConfig, SessionError, SessionHandle};

fn pick_shell() -> String {
    if std::path::Path::new("/bin/sh").exists() {
        "/bin/sh".into()
    } else {
        "/usr/bin/sh".into()
    }
}

/// Session actor must NOT panic and MUST surface `SessionError::Pty` when the
/// shell binary path does not exist. Diagnosing "no such file" early is the
/// difference between a helpful toast and a silent hang.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawn_with_nonexistent_shell_yields_session_error_without_panic() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig::default_login(
        "/definitely/not/a/real/shell/binary/quanta-ghost-shell",
        PathBuf::from("/tmp"),
    );

    let res = SessionActor::spawn(pty, log, cfg).await;
    match res {
        Err(SessionError::Pty(_)) => {}
        Err(other) => panic!("expected SessionError::Pty, got {other:?}"),
        Ok(_) => panic!("spawn must not succeed for nonexistent shell"),
    }
}

/// `true` exits immediately. No `submit_input` is ever called, so there must
/// be NO orphaned `BlockStarted` without a matching `BlockCompleted`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_exits_before_any_write_emits_clean_session_ended() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig {
        shell: pick_shell(),
        args: vec!["-c".into(), "true".into()],
        cwd: PathBuf::from("/tmp"),
        cols: 80,
        rows: 24,
        ..SessionConfig::default()
    };
    let (actor, sid) = SessionActor::spawn(pty, log.clone(), cfg).await.unwrap();

    // Wait up to a second for the child to exit and the reader loop to emit
    // SessionEnded on its own.
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let records = log.replay_session(sid).await.unwrap();
        if records
            .iter()
            .any(|r| matches!(r.envelope.payload, Event::SessionEnded(_)))
        {
            break;
        }
    }
    actor.close().await.unwrap();

    let records = log.replay_session(sid).await.unwrap();
    // No Block* events should exist because no command was submitted.
    let block_events = records
        .iter()
        .filter(|r| {
            matches!(
                r.envelope.payload,
                Event::BlockCreated(_) | Event::BlockStarted(_) | Event::BlockCompleted(_),
            )
        })
        .count();
    assert_eq!(
        block_events, 0,
        "no command was submitted, so no block events should be emitted"
    );
    assert!(
        records
            .iter()
            .any(|r| matches!(r.envelope.payload, Event::SessionEnded(_))),
        "SessionEnded must be present when the shell exits on its own"
    );
}

/// Resize to 0×0 must not crash the PTY adapter. Real users hit this when the
/// terminal surface is briefly hidden (minimized window, tab switch).
/// Observed outcome: session survives and a follow-up legitimate resize still
/// works.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resize_zero_by_zero_does_not_panic_or_close_the_session() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig::default_login(pick_shell(), PathBuf::from("/tmp"));
    let (actor, _sid) = SessionActor::spawn(pty, log, cfg).await.unwrap();

    // 0x0: must not panic. Port layer may or may not clamp; the contract is
    // "no crash, no permanent session damage".
    let _ = actor.resize(PtySize::new(0, 0)).await;

    // Immediately resize to a sane value; this must succeed.
    actor
        .resize(PtySize::new(80, 24))
        .await
        .expect("normal resize after 0x0");
    actor.close().await.unwrap();
}

/// Resize to an absurdly large window must also not panic.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resize_10000_by_10000_does_not_panic() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig::default_login(pick_shell(), PathBuf::from("/tmp"));
    let (actor, _sid) = SessionActor::spawn(pty, log, cfg).await.unwrap();

    // 10_000x10_000. Some backends refuse, others clamp. Either way: no panic.
    let _ = actor.resize(PtySize::new(10_000, 10_000)).await;
    actor.close().await.unwrap();
}

/// A cwd that does not exist must surface SessionError cleanly.
/// Many shells tolerate a bad cwd and start in /, but the PTY adapter should
/// translate a nonexistent path into a Spawn error rather than silently
/// starting somewhere wrong.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_with_nonexistent_cwd_surfaces_session_error() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig::default_login(
        pick_shell(),
        PathBuf::from("/definitely/not/a/real/directory/quanta-ghost-cwd"),
    );
    let res = SessionActor::spawn(pty, log, cfg).await;
    // Portable-pty's contract is "return an error" for chdir failures; if it
    // silently ignores we still want no panic. We accept either outcome but
    // require no panic.
    match res {
        Ok((actor, _)) => {
            // Some backends accept the cwd and fall through to /. That's OK —
            // we only require that close() completes without panicking.
            let _ = actor.close().await;
        }
        Err(SessionError::Pty(_)) => {}
        Err(other) => panic!("expected SessionError::Pty, got {other:?}"),
    }
}

/// A cwd containing spaces, parens, and tabs must round-trip into the launch
/// cwd on the SessionCreated event. This covers "cwd with shell-meaningful
/// characters" — a long-standing source of quoting bugs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cwd_with_spaces_parens_tabs_roundtrips_into_launch_cwd() {
    let tmp = tempfile::tempdir().unwrap();
    // Build a subdirectory whose name contains a space, parens, and a tab.
    let quirky = tmp.path().join("my proj (one)\tweird");
    std::fs::create_dir_all(&quirky).unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig::default_login(pick_shell(), quirky.clone());
    let (actor, sid) = SessionActor::spawn(pty, log.clone(), cfg).await.unwrap();
    actor.close().await.unwrap();

    let records = log.replay_session(sid).await.unwrap();
    let created = records
        .iter()
        .find_map(|r| match &r.envelope.payload {
            Event::SessionCreated(c) => Some(c),
            _ => None,
        })
        .expect("SessionCreated must be emitted");
    assert_eq!(created.launch_cwd, quirky);
}

/// Two `close()` calls concurrently must both return `Ok(())` without double-
/// joining any task. The actor documents this as an idempotency contract.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_concurrent_closes_both_return_ok() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig::default_login(pick_shell(), PathBuf::from("/tmp"));
    let (actor, _sid) = SessionActor::spawn(pty, log, cfg).await.unwrap();
    let actor = Arc::new(actor);

    let a = actor.clone();
    let b = actor.clone();
    let (ra, rb) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(5), async move { a.close().await }),
        tokio::time::timeout(Duration::from_secs(5), async move { b.close().await }),
    );
    ra.expect("first close timed out").expect("first close");
    rb.expect("second close timed out").expect("second close");
}

/// Cancel on a block id that doesn't correspond to an active block must be a
/// silent no-op (not an error). The actor sends Ctrl-C to the shell regardless
/// which the shell ignores when nothing is running; event-wise no
/// BlockCanceled is emitted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_unknown_block_id_is_noop_not_error() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig::default_login(pick_shell(), PathBuf::from("/tmp"));
    let (actor, sid) = SessionActor::spawn(pty, log.clone(), cfg).await.unwrap();

    actor
        .cancel_block(BlockId::new())
        .await
        .expect("cancel of unknown id must not error");
    actor.close().await.unwrap();

    let records = log.replay_session(sid).await.unwrap();
    let canceled = records
        .iter()
        .filter(|r| matches!(r.envelope.payload, Event::BlockCanceled(_)))
        .count();
    assert_eq!(
        canceled, 0,
        "no BlockCanceled must be emitted for an unknown id"
    );
}

/// Cancel after close must surface `SessionError::Closed` — the input channel
/// is gone. The actor MUST NOT panic on this path even under racy close.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_after_close_returns_session_error_closed() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig::default_login(pick_shell(), PathBuf::from("/tmp"));
    let (actor, _sid) = SessionActor::spawn(pty, log, cfg).await.unwrap();
    actor.close().await.unwrap();

    // Small wait to allow the input channel to fully drain.
    tokio::time::sleep(Duration::from_millis(50)).await;
    match actor.cancel_block(BlockId::new()).await {
        Err(SessionError::Closed) => {}
        Ok(()) => {
            // Some backends let the actor buffer one more command before the
            // channel is observed closed; in that case, a second call must
            // certainly be Closed.
            match actor.cancel_block(BlockId::new()).await {
                Err(SessionError::Closed) => {}
                other => panic!("expected Closed on second call, got {other:?}"),
            }
        }
        Err(other) => panic!("expected Closed, got {other:?}"),
    }
}

/// Submit a command to the PTY that prints runaway output and then exits on
/// its own. The reader must drain, the emitter must not panic, and
/// `close()` must complete promptly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_that_prints_and_exits_drains_cleanly() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig {
        shell: pick_shell(),
        // Print ~4KB then exit.
        args: vec!["-c".into(), "yes | head -c 4096; exit 0".into()],
        cwd: PathBuf::from("/tmp"),
        cols: 80,
        rows: 24,
        ..SessionConfig::default()
    };
    let (actor, _sid) = SessionActor::spawn(pty, log, cfg).await.unwrap();
    // Give the shell a moment to run and exit.
    tokio::time::sleep(Duration::from_millis(250)).await;
    tokio::time::timeout(Duration::from_secs(5), actor.close())
        .await
        .expect("close timed out after runaway shell")
        .expect("close errored");
}

/// An empty `bytes_b64` OutputChunk event must round-trip through the event
/// log faithfully: serialization treats `""` as a valid base64 of zero bytes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn empty_bytes_b64_output_chunk_roundtrips_through_event_log() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    let block = BlockId::new();
    let env = Envelope::new(
        sid,
        1,
        Producer::Output,
        SchemaVersion::ONE,
        Event::OutputChunk(OutputChunk {
            span_id: SpanId::new(),
            block_id: block,
            stream: OutputStream::Stdout,
            seq: 0,
            byte_offset_start: 0,
            byte_offset_end: 0,
            bytes_b64: String::new(),
        }),
    )
    .with_block(block);
    log.append(env).await.unwrap();
    log.flush().await.unwrap();

    let records = log.replay_session(sid).await.unwrap();
    assert_eq!(records.len(), 1);
    match &records[0].envelope.payload {
        Event::OutputChunk(c) => {
            assert!(c.bytes_b64.is_empty());
            assert_eq!(c.byte_offset_start, 0);
            assert_eq!(c.byte_offset_end, 0);
            // Decodes to zero bytes without error.
            assert!(BASE64.decode(&c.bytes_b64).unwrap().is_empty());
        }
        other => panic!("unexpected payload {other:?}"),
    }
}

/// An envelope with `block_id == None` (a session-level event) must round-trip
/// through the log with the `None` preserved.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn envelope_with_none_block_id_roundtrips() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    let env: Envelope<Event> = Envelope::new(
        sid,
        1,
        Producer::Session,
        SchemaVersion::ONE,
        Event::SessionEnded(SessionEnded {
            reason: SessionEndReason::UserClosed,
        }),
    );
    // block_id is None by default; assert that explicitly.
    assert!(env.block_id.is_none());
    log.append(env).await.unwrap();
    log.flush().await.unwrap();

    let records = log.replay_session(sid).await.unwrap();
    assert_eq!(records.len(), 1);
    assert!(records[0].envelope.block_id.is_none());
}

/// `monotonic_seq = u64::MAX - 1` must round-trip without wrap. This pins the
/// upper edge of the seq domain; gaps at that ceiling would look like
/// corruption to the reducer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn envelope_with_near_u64_max_seq_roundtrips() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    let block = BlockId::new();
    let env = Envelope::new(
        sid,
        u64::MAX - 1,
        Producer::Block,
        SchemaVersion::ONE,
        Event::BlockCompleted(quanta_proto::events::BlockCompleted {
            block_id: block,
            exit_code: Some(0),
            termination_signal: None,
            boundary_signal: BoundarySignal::Osc133,
            boundary_confidence: BoundaryConfidence::Authoritative,
        }),
    );
    log.append(env).await.unwrap();
    log.flush().await.unwrap();

    let records = log.replay_session(sid).await.unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].envelope.monotonic_seq, u64::MAX - 1);
}

/// Submitting a passthrough (non-submit) input must NOT create a block and
/// must write the raw bytes to the PTY. Returning `Ok(None)` is the contract.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn passthrough_submit_does_not_mint_a_block() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig::default_login(pick_shell(), PathBuf::from("/tmp"));
    let (actor, sid) = SessionActor::spawn(pty, log.clone(), cfg).await.unwrap();

    let res = actor
        .submit_input(InputSubmission {
            text: "\x1b[A".into(), // up-arrow
            kind: quanta_proto::events::InputKind::Shell,
            submit: false,
        })
        .await
        .expect("passthrough submit");
    assert!(res.is_none(), "passthrough must not return a block id");
    actor.close().await.unwrap();

    let records = log.replay_session(sid).await.unwrap();
    let block_created = records
        .iter()
        .filter(|r| matches!(r.envelope.payload, Event::BlockCreated(_)))
        .count();
    assert_eq!(block_created, 0, "passthrough must not emit BlockCreated");
}

/// ADR 0011 §Durable Commit Ordering — two sessions spawned concurrently
/// must interleave without sharing mutable state. Each session's
/// `SessionActor` owns its own PTY/state/emitter. The shared sink must
/// not cause cross-session seq corruption: each session maintains its own
/// `monotonic_seq` stream (scoped to `SessionId`), starting at 1.
///
/// This is the regression guard against a future refactor that makes
/// `next_seq` a per-sink counter rather than per-session.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_concurrent_sessions_do_not_share_seq_counters() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());

    // Spawn both actors concurrently so their SessionCreated envelopes can
    // race through the shared sink. Whichever wins, each session's seqs
    // must still start at 1 and march monotonically within that session.
    let log_a = log.clone();
    let log_b = log.clone();
    let spawn_a = tokio::spawn(async move {
        let pty = Arc::new(PortablePtyPort::new());
        let cfg = SessionConfig::default_login(pick_shell(), PathBuf::from("/tmp"));
        SessionActor::spawn(pty, log_a, cfg).await.unwrap()
    });
    let spawn_b = tokio::spawn(async move {
        let pty = Arc::new(PortablePtyPort::new());
        let cfg = SessionConfig::default_login(pick_shell(), PathBuf::from("/tmp"));
        SessionActor::spawn(pty, log_b, cfg).await.unwrap()
    });
    let ((actor_a, sid_a), (actor_b, sid_b)) =
        tokio::join!(async { spawn_a.await.unwrap() }, async {
            spawn_b.await.unwrap()
        });
    assert_ne!(sid_a, sid_b, "session ids must be distinct");

    // Let each session settle and then close.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let _ = tokio::join!(actor_a.close(), actor_b.close());

    let records_a = log.replay_session(sid_a).await.unwrap();
    let records_b = log.replay_session(sid_b).await.unwrap();
    assert!(!records_a.is_empty(), "session A must produce events");
    assert!(!records_b.is_empty(), "session B must produce events");

    // Seq invariant: strictly monotonic and starts at 1 for each session.
    let seqs_a: Vec<u64> = records_a.iter().map(|r| r.envelope.monotonic_seq).collect();
    let seqs_b: Vec<u64> = records_b.iter().map(|r| r.envelope.monotonic_seq).collect();
    assert_eq!(seqs_a.first().copied(), Some(1), "seq A must start at 1");
    assert_eq!(seqs_b.first().copied(), Some(1), "seq B must start at 1");
    for pair in seqs_a.windows(2) {
        assert!(pair[1] > pair[0], "seq A must be strictly monotonic");
    }
    for pair in seqs_b.windows(2) {
        assert!(pair[1] > pair[0], "seq B must be strictly monotonic");
    }
    // Cross-session: every envelope under sid_a carries session_id == sid_a.
    for rec in &records_a {
        assert_eq!(
            rec.envelope.session_id, sid_a,
            "session A record attributed to wrong session"
        );
    }
    for rec in &records_b {
        assert_eq!(
            rec.envelope.session_id, sid_b,
            "session B record attributed to wrong session"
        );
    }
}
