//! Boot the engine, run a trivial shell command, and replay the event log.
//!
//! Run with:
//!
//! ```shell
//! cargo run --example boot_and_replay -p quanta-core
//! ```

use std::path::PathBuf;

use quanta_core::{Engine, EngineConfig};
use quanta_session::{InputSubmission, SessionHandle};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let (engine, _evrx) = Engine::boot(EngineConfig::new(tmp.path().to_path_buf())).await?;

    let sid = engine
        .create_session(Some("/bin/sh".into()), Some(PathBuf::from("/tmp")), 80, 24)
        .await?;
    let session = engine.session(sid).await.expect("session must be present");
    session
        .submit_input(InputSubmission {
            text: "echo quanta && exit 0".into(),
            kind: quanta_proto::events::InputKind::Shell,
            submit: true,
        })
        .await?;

    // Wait briefly for the shell to emit events.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    let records = engine.replay_session(sid).await?;
    println!("replayed {} records", records.len());
    for rec in records.iter().take(12) {
        println!(
            "  seq={} producer={:?}",
            rec.envelope.monotonic_seq, rec.envelope.producer_id
        );
    }
    engine.close_session(sid).await?;
    engine.mark_clean_shutdown()?;
    Ok(())
}
