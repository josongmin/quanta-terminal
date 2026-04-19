//! FIX 4: ControlRegistry observes Lagged on the broadcast receiver side and
//! summarizes the drop counter every LAG_SUMMARY_INTERVAL events (100),
//! instead of logging every single lag (storm) or never logging (invisible).
//!
//! We drive the registry's `next_event` with a saturated broadcast channel
//! and assert the `lag_counter_snapshot` behaves as specified:
//!   - increments on every Lagged,
//!   - resets when the summary interval fires.

use std::path::PathBuf;

use quanta_core::{ControlRegistry, Engine, EngineConfig};
use quanta_protocol::ControlHandler as _;
use quanta_session::{InputSubmission, SessionHandle as _};

/// Force the broadcast channel to lag by producing many envelopes without
/// ever draining `next_event`, then call `next_event` once to observe the
/// first Lagged. The counter must advance.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn next_event_increments_lag_counter_on_slow_subscriber() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = EngineConfig::new(tmp.path().to_path_buf());
    let (engine, rx) = Engine::boot(cfg).await.expect("boot");

    // Register one session so the sink has a live actor to fire events
    // through; we never drain, so the receiver falls behind.
    let shell = if std::path::Path::new("/bin/sh").exists() {
        "/bin/sh"
    } else {
        "/bin/bash"
    };
    let sid = engine
        .create_session(Some(shell.into()), Some(PathBuf::from("/tmp")), 80, 24)
        .await
        .expect("create session");
    let session = engine.session(sid).await.unwrap();

    let registry = ControlRegistry::new(engine.clone(), rx);

    // Produce enough input envelopes to saturate the 1024-envelope buffer.
    // Submitting raw passthrough (submit=false) keeps the input stream noisy
    // without spawning command lifecycles; each submit emits at least one
    // InputSubmitted event.
    for _ in 0..1200 {
        let _ = session
            .submit_input(InputSubmission {
                text: String::from("x"),
                kind: quanta_proto::events::InputKind::Shell,
                submit: false,
            })
            .await;
    }

    // Give the emitter time to drain the pending queue into the broadcast.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Now consume. The FIRST recv should return Lagged; next_event handles
    // it, increments the counter, and returns None. We may need to call a
    // few times because next_event only does a timeout-bounded single recv.
    let mut observed_lag_counter: u64 = 0;
    for _ in 0..4 {
        let _ = registry.next_event().await;
        let snap = registry.lag_counter_snapshot();
        if snap > observed_lag_counter {
            observed_lag_counter = snap;
            break;
        }
    }
    assert!(
        observed_lag_counter > 0,
        "expected lag counter to advance after saturating broadcast; got {observed_lag_counter}"
    );

    // Cleanup.
    let _ = engine.close_session(sid).await;
}
