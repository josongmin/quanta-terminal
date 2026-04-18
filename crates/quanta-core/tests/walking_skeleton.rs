//! Walking-skeleton acceptance test.
//!
//! Spawns a PTY running `bash -lc 'echo hello; exit 0'`, drives it via the
//! session actor, and asserts:
//!   - `BlockCreated` + `BlockStarted` + at least one `OutputChunk` containing
//!     `hello` + `BlockCompleted(exit_code=Some(0))` are emitted in order;
//!   - replay from the event log reconstructs the same projection.

use std::path::PathBuf;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use quanta_core::{Engine, EngineConfig};
use quanta_proto::events::Event;
use quanta_session::{InputSubmission, SessionHandle as _};

async fn wait_for_completion(
    engine: &Engine,
    session_id: quanta_proto::ids::SessionId,
    deadline_ms: u64,
) -> Vec<Event> {
    let mut events: Vec<Event> = Vec::new();
    let start = std::time::Instant::now();
    while start.elapsed().as_millis() < u128::from(deadline_ms) {
        let records = engine.replay_session(session_id).await.unwrap();
        events = records.into_iter().map(|r| r.envelope.payload).collect();
        if events
            .iter()
            .any(|e| matches!(e, Event::BlockCompleted(_) | Event::SessionEnded(_)))
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    events
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawns_echo_and_completes_block() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = EngineConfig::new(tmp.path().to_path_buf());
    let engine = Engine::boot(cfg).await.expect("boot engine");

    // Pick a shell that exists on macOS/Linux CI.
    let shell = if std::path::Path::new("/bin/bash").exists() {
        "/bin/bash".to_string()
    } else {
        "/bin/sh".to_string()
    };

    let session_id = engine
        .create_session(Some(shell), Some(PathBuf::from("/tmp")), 80, 24)
        .await
        .expect("create session");

    let session = engine.session(session_id).await.expect("session present");
    // We use `-c 'echo hello; exit 0'` so the shell exits cleanly.
    // The session actor issues it as a command block (Submit=true) and the
    // child-exit boundary closes the block with exit_code=0.
    session
        .submit_input(InputSubmission {
            text: "echo hello; exit 0".into(),
            kind: quanta_proto::events::InputKind::Shell,
            submit: true,
        })
        .await
        .expect("submit input");

    let events = wait_for_completion(&engine, session_id, 10_000).await;

    // Assert ordering and contents.
    let mut saw_created = false;
    let mut saw_started = false;
    let mut saw_hello = false;
    let mut saw_completed_zero = false;

    for ev in &events {
        match ev {
            Event::BlockCreated(_) => {
                assert!(!saw_started, "BlockCreated must precede BlockStarted");
                saw_created = true;
            }
            Event::BlockStarted(_) => {
                assert!(saw_created, "BlockStarted must follow BlockCreated");
                saw_started = true;
            }
            Event::OutputChunk(o) => {
                let bytes = BASE64.decode(&o.bytes_b64).unwrap();
                if bytes.windows(5).any(|w| w == b"hello") {
                    saw_hello = true;
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

    assert!(saw_created, "no BlockCreated event seen; log={events:?}");
    assert!(saw_started, "no BlockStarted event seen; log={events:?}");
    assert!(
        saw_hello,
        "no OutputChunk containing 'hello' seen; log={events:?}"
    );
    assert!(
        saw_completed_zero,
        "no BlockCompleted(exit_code=Some(0)) seen; log={events:?}"
    );

    // --- Replay determinism: read again and diff projection. ---
    let projection_1 = project(&events);
    let records_2 = engine.replay_session(session_id).await.unwrap();
    let events_2: Vec<Event> = records_2.into_iter().map(|r| r.envelope.payload).collect();
    let projection_2 = project(&events_2);
    assert_eq!(
        projection_1, projection_2,
        "replay produced different projection"
    );
}

#[derive(Debug, PartialEq, Eq)]
struct Projection {
    exit_code: Option<i32>,
    output: Vec<u8>,
}

fn project(events: &[Event]) -> Projection {
    let mut output = Vec::new();
    let mut exit_code = None;
    for ev in events {
        match ev {
            Event::OutputChunk(o) => {
                output.extend_from_slice(&BASE64.decode(&o.bytes_b64).unwrap());
            }
            Event::BlockCompleted(c) => {
                exit_code = c.exit_code;
            }
            _ => {}
        }
    }
    let _ = Arc::new(()); // shut up unused import warn
    Projection { exit_code, output }
}
