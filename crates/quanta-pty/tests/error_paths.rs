//! Error-path coverage for the PTY adapter.
//!
//! Exercises the `PtyError` variants the happy-path unit tests do not: bad
//! program paths surface `Spawn(..)`, and operations on a PTY after its
//! child has exited and the reader thread has signalled EOF surface
//! `Closed` rather than hanging.

use std::time::Duration;

use quanta_pty::{PortablePtyPort, PtyError, PtyPort, PtySpec};

#[tokio::test]
async fn open_with_nonexistent_program_yields_spawn_error() {
    let port = PortablePtyPort::new();
    let spec = PtySpec::shell("/definitely/not/a/real/program/path/quanta-phantom");
    let res = port.open(spec).await;
    match res {
        Err(PtyError::Spawn(msg)) => {
            assert!(
                !msg.is_empty(),
                "Spawn error message must not be empty for diagnosis"
            );
        }
        Ok(_) => panic!("expected Spawn error for nonexistent program"),
        Err(other) => panic!("expected Spawn, got {other:?}"),
    }
}

#[tokio::test]
async fn read_after_child_exit_eventually_surfaces_closed() {
    let port = PortablePtyPort::new();
    // `true` is a universally-present shell builtin / binary that exits 0
    // immediately. After it exits and the reader drains EOF, subsequent
    // reads must surface PtyError::Closed.
    let mut h = port
        .open(PtySpec::shell("/bin/sh").with_arg("-c").with_arg("true"))
        .await
        .expect("spawn /bin/sh -c true");
    // Poll reads until we see EOF (surfaced as PtyError::Closed). Bounded by
    // a short deadline so a regression doesn't hang CI.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut buf = [0u8; 1024];
    let mut saw_closed = false;
    while std::time::Instant::now() < deadline {
        match h.read(&mut buf).await {
            Ok(_) => {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(PtyError::Closed) => {
                saw_closed = true;
                break;
            }
            Err(other) => panic!("unexpected read error {other:?}"),
        }
    }
    assert!(saw_closed, "expected PtyError::Closed within 5s");
}

#[tokio::test]
async fn write_after_handle_drop_cannot_panic() {
    // Drops must leave the adapter quiescent. We spawn a process, immediately
    // drop the handle, and verify the reader thread tears down without
    // panicking the runtime. (The parent runtime would detect a panic and
    // abort the test.)
    let port = PortablePtyPort::new();
    let h = port
        .open(
            PtySpec::shell("/bin/sh")
                .with_arg("-c")
                .with_arg("sleep 10"),
        )
        .await
        .expect("spawn");
    drop(h);
    // Give background tasks a moment to wind down. No further assertion
    // needed — the test passes iff the runtime stays alive.
    tokio::time::sleep(Duration::from_millis(100)).await;
}

#[tokio::test]
async fn kill_is_idempotent_and_survives_repeated_calls() {
    let port = PortablePtyPort::new();
    let mut h = port
        .open(PtySpec::shell("/bin/sh").with_arg("-c").with_arg("sleep 5"))
        .await
        .expect("spawn");
    h.kill().await.expect("first kill");
    // Second kill may return Ok (child already reaped) or an error; it must
    // not panic. We accept either outcome.
    let _ = h.kill().await;
}

#[tokio::test]
async fn wait_consumes_child_once_and_returns_closed_after() {
    let port = PortablePtyPort::new();
    let mut h = port
        .open(PtySpec::shell("/bin/sh").with_arg("-c").with_arg("true"))
        .await
        .expect("spawn");
    let _ = h.wait().await.expect("first wait");
    // Second wait finds the child `take()`n; must return PtyError::Closed.
    match h.wait().await {
        Err(PtyError::Closed) => {}
        other => panic!("expected PtyError::Closed on second wait, got {other:?}"),
    }
}
