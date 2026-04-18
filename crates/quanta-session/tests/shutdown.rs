//! Shutdown / re-entrant close tests for the session actor.
//!
//! The actor must:
//! - join its three background tasks on `close()` rather than leaking them;
//! - treat a second `close()` as a no-op (idempotency);
//! - tolerate `close()` being called after the PTY child has already exited.

use std::path::PathBuf;
use std::sync::Arc;

use quanta_events::ZstdSegmentedEventLog;
use quanta_pty::PortablePtyPort;
use quanta_session::{SessionActor, SessionConfig, SessionHandle};

fn pick_shell() -> String {
    if std::path::Path::new("/bin/sh").exists() {
        "/bin/sh".into()
    } else {
        "/usr/bin/sh".into()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_is_idempotent_and_joins_tasks() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig::default_login(pick_shell(), PathBuf::from("/tmp"));
    let (actor, _sid) = SessionActor::spawn(pty, log, cfg).await.unwrap();

    // Bound the first close so a regression that leaks a task cannot hang CI.
    tokio::time::timeout(std::time::Duration::from_secs(5), actor.close())
        .await
        .expect("close did not complete within 5s")
        .expect("first close errored");

    // Second close must return Ok without touching any joined task (they are
    // already gone). This is the idempotency contract documented on
    // `SessionHandle::close`.
    tokio::time::timeout(std::time::Duration::from_secs(1), actor.close())
        .await
        .expect("second close did not complete within 1s")
        .expect("second close errored");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_after_child_exit_still_succeeds() {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig {
        shell: pick_shell(),
        args: vec!["-c".into(), "true".into()],
        cwd: PathBuf::from("/tmp"),
        cols: 80,
        rows: 24,
    };
    let (actor, _sid) = SessionActor::spawn(pty, log, cfg).await.unwrap();
    // Give the child a moment to exit.
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    // Close must still succeed: the read loop should have observed EOF and
    // exited on its own. Our close path then drains remaining tasks.
    tokio::time::timeout(std::time::Duration::from_secs(5), actor.close())
        .await
        .expect("close did not complete within 5s")
        .expect("close errored after child exit");
}
