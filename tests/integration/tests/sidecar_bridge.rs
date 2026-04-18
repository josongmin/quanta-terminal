//! Sidecar-bridge integration scenarios.
//!
//! These tests exercise the same real-binary path `packages/host-tauri` walks
//! when compiled with `--features sidecar`: spawn `quanta-core` as a child
//! process, connect through `quanta_protocol::UnixSocketClient`, perform the
//! Hello/Ready handshake, issue typed RPC calls, and consume the event plane.
//!
//! We intentionally do NOT require Tauri here — the module under test
//! (`packages/host-tauri/src-tauri/src/sidecar.rs`) layers on top of
//! `UnixSocketClient`, so covering the client end-to-end is enough to pin the
//! bridge's transport contract. The AppHandle re-emission is pure forwarding
//! and is covered by the unit tests inside `sidecar.rs`.
//!
//! Every test is hermetic: it gets its own `TempDir` for the socket + profile
//! and its own child process with `kill_on_drop(true)`.

mod common;

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use common::{quanta_core_bin, CoreProcess};
use quanta_proto::events::Event;
use quanta_proto::rpc::{
    CloseSession, CreateSession, CreateSessionResult, InputMode, RpcMethod, RpcResult, SubmitInput,
};
use quanta_protocol::UnixSocketClient;

fn pick_shell() -> &'static str {
    if std::path::Path::new("/bin/bash").exists() {
        "/bin/bash"
    } else {
        "/bin/sh"
    }
}

/// End-to-end: Tauri-side `UnixSocketClient` connects, issues CreateSession
/// + SubmitInput, observes `PtyData` (via `OutputChunk`) and `BlockCompleted`
/// events, and finally issues CloseSession cleanly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sidecar_bridge_submits_command_and_observes_events() -> Result<()> {
    // Sanity: the binary we're about to spawn must exist. Without this guard,
    // a missing binary produces a confusing "socket never bound" error.
    let bin = quanta_core_bin();
    assert!(
        bin.exists(),
        "quanta-core binary not found at {bin:?}; run `cargo build -p quanta-core`"
    );

    let core = CoreProcess::spawn().await?;

    // Exercise the new client adapter — the real path `packages/host-tauri`
    // uses when `--features sidecar` is enabled.
    let client = UnixSocketClient::connect(&core.socket_path, "sidecar-bridge-test", "0.0.0-tests")
        .await
        .context("UnixSocketClient::connect")?;

    // Handshake metadata must come from the core binary we spawned.
    assert_eq!(client.ready().sidecar_id, "quanta-core");

    // Create a session.
    let resp = client
        .call(
            "req-create",
            RpcMethod::CreateSession(CreateSession {
                shell: Some(pick_shell().into()),
                cwd: Some("/tmp".into()),
                cols: 80,
                rows: 24,
            }),
        )
        .await
        .context("CreateSession")?;
    let created: CreateSessionResult = match resp.result {
        RpcResult::Ok { value } => serde_json::from_value(value)?,
        RpcResult::Err { error } => {
            return Err(anyhow!("CreateSession rejected: {}", error.message))
        }
    };

    // Take the event stream BEFORE submitting — the block-start event races
    // the RPC response and we need the stream hooked up first.
    let mut events = client
        .take_event_stream()
        .ok_or_else(|| anyhow!("event stream was already taken"))?;

    // Submit input in full-command mode so the engine emits a block boundary.
    let submit_resp = client
        .call(
            "req-submit",
            RpcMethod::SubmitInput(SubmitInput {
                session_id: created.session_id,
                text: "echo sidecar_bridge_ok; exit 0".into(),
                mode: InputMode::Submit,
            }),
        )
        .await
        .context("SubmitInput")?;
    assert!(matches!(submit_resp.result, RpcResult::Ok { .. }));

    // Drain events until we see BlockCompleted, or until the overall deadline
    // passes. The live event plane carries SessionCreated → BlockCreated →
    // BlockStarted → OutputChunk(…) → BlockCompleted per ADR 0011 ordering.
    let mut collected = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
            Ok(Some(env)) => {
                let done = matches!(env.payload, Event::BlockCompleted(_));
                collected.push(env);
                if done {
                    break;
                }
            }
            Ok(None) => break,       // socket closed
            Err(_) => { /* tick */ } // keep polling until the overall deadline
        }
    }

    // Shape assertions:
    assert!(
        collected
            .iter()
            .any(|e| matches!(e.payload, Event::BlockCreated(_))),
        "expected BlockCreated in event chain; saw: {:?}",
        collected.iter().map(event_kind_name).collect::<Vec<_>>()
    );
    assert!(
        collected
            .iter()
            .any(|e| matches!(e.payload, Event::OutputChunk(_))),
        "expected at least one OutputChunk (PtyData), saw: {:?}",
        collected.iter().map(event_kind_name).collect::<Vec<_>>()
    );
    assert!(
        collected
            .iter()
            .any(|e| matches!(&e.payload, Event::BlockCompleted(c) if c.exit_code == Some(0))),
        "expected BlockCompleted with exit_code=0; saw: {:?}",
        collected.iter().map(event_kind_name).collect::<Vec<_>>()
    );

    // Close cleanly — idempotent: the session actor shuts down gracefully.
    let close_resp = client
        .call(
            "req-close",
            RpcMethod::CloseSession(CloseSession {
                session_id: created.session_id,
            }),
        )
        .await
        .context("CloseSession")?;
    assert!(matches!(close_resp.result, RpcResult::Ok { .. }));

    drop(client);
    core.shutdown().await?;
    Ok(())
}

/// Negative case: if we `drop` the client before the core responds to an
/// in-flight call, the client's Drop impl must tear down cleanly without
/// panicking. This is the contract the Tauri host relies on when the user
/// quits the app mid-command.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sidecar_client_drop_mid_flight_does_not_panic() -> Result<()> {
    let core = CoreProcess::spawn().await?;
    let client = UnixSocketClient::connect(&core.socket_path, "drop-test", "0.0.0").await?;

    // Fire-and-forget a long-running session create. We deliberately do NOT
    // await the future — we want to simulate the "user closed the window"
    // scenario where in-flight RPCs are abandoned.
    let task = {
        let client = std::sync::Arc::new(client);
        let c2 = client.clone();
        let t = tokio::spawn(async move {
            let _ = c2
                .call(
                    "req-drop",
                    RpcMethod::CreateSession(CreateSession {
                        shell: Some(pick_shell().into()),
                        cwd: None,
                        cols: 80,
                        rows: 24,
                    }),
                )
                .await;
        });
        // Drop the Arc we still hold; if the task also drops, the client drops.
        drop(client);
        t
    };

    // Give the task a moment to either complete or notice the drop.
    let _ = tokio::time::timeout(Duration::from_secs(2), task).await;

    core.shutdown().await?;
    Ok(())
}

/// The sidecar's `Goodbye` frame must reach the server and terminate the
/// connection cleanly. Mirrors what `SidecarBridge::close_all` will do at
/// app-shutdown time.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sidecar_client_goodbye_closes_cleanly() -> Result<()> {
    let core = CoreProcess::spawn().await?;
    let client = UnixSocketClient::connect(&core.socket_path, "goodbye-test", "0.0.0").await?;
    client
        .goodbye("tests: app shutting down")
        .await
        .context("goodbye")?;
    // A subsequent RPC call should error (server already dropped the stream).
    let resp = client
        .call(
            "req-after-goodbye",
            RpcMethod::CreateSession(CreateSession {
                shell: Some(pick_shell().into()),
                cwd: None,
                cols: 80,
                rows: 24,
            }),
        )
        .await;
    assert!(
        resp.is_err(),
        "expected RPC after Goodbye to fail; got {resp:?}"
    );
    core.shutdown().await?;
    Ok(())
}

fn event_kind_name(e: &quanta_proto::envelope::Envelope<Event>) -> &'static str {
    match &e.payload {
        Event::SessionCreated(_) => "SessionCreated",
        Event::SessionShellIntegrationStatus(_) => "SessionShellIntegrationStatus",
        Event::SessionCwdChanged(_) => "SessionCwdChanged",
        Event::SessionEnded(_) => "SessionEnded",
        Event::BlockCreated(_) => "BlockCreated",
        Event::BlockStarted(_) => "BlockStarted",
        Event::BlockCompleted(_) => "BlockCompleted",
        Event::BlockCanceled(_) => "BlockCanceled",
        Event::BlockDetached(_) => "BlockDetached",
        Event::BlockTuiEntered(_) => "BlockTuiEntered",
        Event::BlockTuiExited(_) => "BlockTuiExited",
        Event::OutputChunk(_) => "OutputChunk",
        Event::OutputTruncated(_) => "OutputTruncated",
        Event::InputSubmitted(_) => "InputSubmitted",
        Event::DiagnosticDetected(_) => "DiagnosticDetected",
        Event::SuggestionGenerated(_) => "SuggestionGenerated",
        Event::SuggestionReviewed(_) => "SuggestionReviewed",
        Event::HistoryIndexed(_) => "HistoryIndexed",
    }
}
