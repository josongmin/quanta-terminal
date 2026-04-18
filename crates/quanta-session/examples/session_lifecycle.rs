//! Spawn a session, submit one command, and shut down cleanly.
//!
//! Run with:
//!
//! ```shell
//! cargo run --example session_lifecycle -p quanta-session
//! ```

use std::path::PathBuf;
use std::sync::Arc;

use quanta_events::ZstdSegmentedEventLog;
use quanta_pty::PortablePtyPort;
use quanta_session::{InputSubmission, SessionActor, SessionConfig, SessionHandle};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path())?);
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig {
        shell: "/bin/sh".into(),
        args: Vec::new(),
        cwd: PathBuf::from("/tmp"),
        cols: 80,
        rows: 24,
    };
    let (actor, sid) = SessionActor::spawn(pty, log, cfg).await?;
    println!("spawned session {sid}");

    let block = actor
        .submit_input(InputSubmission {
            text: "echo hello && exit 0".into(),
            kind: quanta_proto::events::InputKind::Shell,
            submit: true,
        })
        .await?;
    println!("submitted, got block {block:?}");

    // Give the shell a moment to run and emit events, then close.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    actor.close().await?;
    println!("session closed cleanly");
    Ok(())
}
