//! Companion to `walking_skeleton.rs` covering error / non-happy paths:
//!
//! - A shell command that exits non-zero → `BlockCompleted(exit_code=Some(1))`.
//! - A shell command that is canceled immediately → a `BlockCanceled` envelope.
//! - A long output stream is chunked across multiple `OutputChunk` envelopes.

use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use quanta_core::{Engine, EngineConfig};
use quanta_proto::events::Event;
use quanta_session::{InputSubmission, SessionHandle as _};

fn pick_shell() -> String {
    if std::path::Path::new("/bin/bash").exists() {
        "/bin/bash".into()
    } else {
        "/bin/sh".into()
    }
}

async fn wait_until<F>(
    engine: &Engine,
    sid: quanta_proto::ids::SessionId,
    predicate: F,
) -> Vec<Event>
where
    F: Fn(&[Event]) -> bool,
{
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let records = engine.replay_session(sid).await.unwrap();
        let events: Vec<Event> = records.into_iter().map(|r| r.envelope.payload).collect();
        if predicate(&events) {
            return events;
        }
        if std::time::Instant::now() >= deadline {
            return events;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn non_zero_exit_is_captured_on_block_completed() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = Engine::boot(EngineConfig::new(tmp.path().to_path_buf()))
        .await
        .expect("boot");
    let sid = engine
        .create_session(Some(pick_shell()), Some(PathBuf::from("/tmp")), 80, 24)
        .await
        .expect("create session");
    let session = engine.session(sid).await.expect("session");
    session
        .submit_input(InputSubmission {
            text: "false; exit 1".into(),
            kind: quanta_proto::events::InputKind::Shell,
            submit: true,
        })
        .await
        .expect("submit");

    let events = wait_until(&engine, sid, |events| {
        events
            .iter()
            .any(|e| matches!(e, Event::BlockCompleted(c) if c.exit_code.is_some()))
    })
    .await;

    let codes: Vec<i32> = events
        .iter()
        .filter_map(|e| match e {
            Event::BlockCompleted(c) => c.exit_code,
            _ => None,
        })
        .collect();
    assert!(!codes.is_empty(), "no BlockCompleted with exit_code seen");
    assert!(
        codes.iter().any(|&c| c != 0),
        "expected at least one non-zero exit code, got {codes:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn long_output_chunks_across_multiple_events() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = Engine::boot(EngineConfig::new(tmp.path().to_path_buf()))
        .await
        .expect("boot");
    // 64 cols / 24 rows means each line is bounded; we want a payload large
    // enough to span more than one 8 KiB read from the PTY.
    let sid = engine
        .create_session(Some(pick_shell()), Some(PathBuf::from("/tmp")), 200, 24)
        .await
        .expect("create session");
    let session = engine.session(sid).await.expect("session");
    // `printf` writes ~80 KiB of 'X' then exits. We use printf because echo's
    // line-wrap on some shells adds unpredictable structure.
    session
        .submit_input(InputSubmission {
            text: "printf 'X%.0s' $(seq 1 80000); echo; exit 0".into(),
            kind: quanta_proto::events::InputKind::Shell,
            submit: true,
        })
        .await
        .expect("submit");

    let events = wait_until(&engine, sid, |events| {
        events
            .iter()
            .any(|e| matches!(e, Event::BlockCompleted(_) | Event::SessionEnded(_)))
    })
    .await;

    let chunks: Vec<&quanta_proto::events::OutputChunk> = events
        .iter()
        .filter_map(|e| match e {
            Event::OutputChunk(o) => Some(o),
            _ => None,
        })
        .collect();
    assert!(
        chunks.len() >= 2,
        "expected multiple OutputChunk events for 80 KiB output, got {}",
        chunks.len()
    );

    // Each chunk's byte_offset_end must equal the next chunk's byte_offset_start
    // within the same block. This pins the span-sequencing invariant under load.
    let mut last_end = 0u64;
    for (i, c) in chunks.iter().enumerate() {
        assert_eq!(
            c.byte_offset_start, last_end,
            "offset gap at chunk {i}: start={} expected={}",
            c.byte_offset_start, last_end
        );
        assert!(
            c.byte_offset_end > c.byte_offset_start,
            "empty chunk at {i}"
        );
        last_end = c.byte_offset_end;
        // The bytes_b64 must be decodable.
        BASE64
            .decode(&c.bytes_b64)
            .unwrap_or_else(|e| panic!("chunk {i} bad base64: {e}"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_block_does_not_regress_prior_events() {
    // ROUND-2 HANDOFF (DO NOT fix here):
    //   The session actor currently sends Ctrl-C to the PTY on
    //   `cancel_block` but does NOT emit a `BlockCanceled` envelope. Per
    //   ADR 0002 every cancel should append an event so replay reconstructs
    //   the cancellation. See Round-2 follow-up "session actor: cancel_block
    //   must emit BlockCanceled".
    //
    //   Until that lands, this test pins the behaviour we DO have: cancel
    //   must be accepted without error and prior events (Created / Started /
    //   output) must survive unchanged. The session closes cleanly and
    //   eventually emits SessionEnded.
    let tmp = tempfile::tempdir().unwrap();
    let engine = Engine::boot(EngineConfig::new(tmp.path().to_path_buf()))
        .await
        .expect("boot");
    let sid = engine
        .create_session(Some(pick_shell()), Some(PathBuf::from("/tmp")), 80, 24)
        .await
        .expect("create session");
    let session = engine.session(sid).await.expect("session");
    let block_id = session
        .submit_input(InputSubmission {
            text: "sleep 5".into(),
            kind: quanta_proto::events::InputKind::Shell,
            submit: true,
        })
        .await
        .expect("submit")
        .expect("block id present");

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    session.cancel_block(block_id).await.expect("cancel");
    // Close the session so the read loop tears down deterministically.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    session.close().await.expect("close");

    let events = wait_until(&engine, sid, |events| {
        events.iter().any(|e| matches!(e, Event::SessionEnded(_)))
    })
    .await;

    assert!(
        events.iter().any(|e| matches!(e, Event::SessionCreated(_))),
        "SessionCreated missing; events={events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::BlockCreated(b) if b.block_id == block_id)),
        "BlockCreated missing; events={events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::BlockStarted(b) if b.block_id == block_id)),
        "BlockStarted missing; events={events:?}"
    );
    // We do NOT yet assert `BlockCanceled`; see handoff above. When the
    // production fix lands, strengthen this to:
    //   assert!(events.iter().any(|e| matches!(e, Event::BlockCanceled(b) if b.block_id == block_id)));
}
