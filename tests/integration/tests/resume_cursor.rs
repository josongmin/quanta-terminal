//! Integration test for ADR 0011 §Resume Cursor.
//!
//! Scenario: host A creates a session + runs a command, disconnects; host B
//! reconnects carrying `resume_cursors = { session_id: 1 }` and must observe
//! the events with `monotonic_seq > 1` replayed from the durable log.

#![allow(
    clippy::large_enum_variant,
    dead_code,
    reason = "common module is shared across test files; not all helpers are used per file"
)]

mod common;

use std::collections::HashMap;
use std::time::Duration;

use anyhow::Result;
use common::CoreProcess;
use quanta_proto::events::Event;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_cursor_replays_events_above_since_seq() -> Result<()> {
    let core = CoreProcess::spawn().await?;

    // --- Host A: boot, run an echo, collect events, disconnect ---
    let events_a = {
        let mut host = core.connect().await?;
        let created = host
            .create_session(common::pick_shell(), Some(std::path::Path::new("/tmp")))
            .await?;
        let _submit = host
            .submit(created.session_id, "echo resume_replay_ok; exit 0")
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
        // host A drops here when this scope ends; socket closes.
        (events, created.session_id)
    };
    let (a_events, session_id) = events_a;
    assert!(
        a_events
            .iter()
            .any(|e| matches!(&e.payload, Event::BlockCompleted(_))),
        "host A must see BlockCompleted; log={a_events:?}",
    );

    // Mid-stream cursor: capture the seq of an event roughly halfway through
    // the stream so the replay below actually filters anything.
    let mid_seq = a_events
        .get(a_events.len() / 2)
        .map(|e| e.monotonic_seq)
        .expect("at least one event in host A stream");

    // --- Host B: reconnect with resume_cursors, expect replay of events > mid_seq ---
    let mut host_b = {
        let mut cursors = HashMap::new();
        cursors.insert(session_id.to_string(), mid_seq);
        common::MockHost::connect_with_resume(&core.socket_path, cursors).await?
    };

    // Collect events with a tight timeout; the server replays from the log
    // BEFORE starting the live pump, so they should arrive promptly.
    let replayed = host_b
        .collect_events_until(
            |events| events.len() >= (a_events.len() - (a_events.len() / 2 + 1)),
            Duration::from_secs(3),
        )
        .await?;

    // Every replayed event must have monotonic_seq > mid_seq and same session.
    for env in &replayed {
        assert!(
            env.monotonic_seq > mid_seq,
            "replayed event has seq {} <= cursor {mid_seq}; env={env:?}",
            env.monotonic_seq,
        );
        assert_eq!(env.session_id, session_id, "replayed event wrong session");
    }

    // The tail event (BlockCompleted or later) should be in the replay.
    assert!(
        replayed
            .iter()
            .any(|e| matches!(&e.payload, Event::BlockCompleted(_))),
        "BlockCompleted missing from replay; got {replayed:?}",
    );

    core.shutdown().await?;
    Ok(())
}
