//! Integration test — session actor wires the Tier-1 diagnostic pipeline.
//!
//! Drives a real bash session that emits a canned rustc error string; asserts
//! a `DiagnosticDetected` appears in the event log with the correct path/line.

use std::path::PathBuf;
use std::sync::Arc;

use quanta_events::{EventLogReader as _, ZstdSegmentedEventLog};
use quanta_proto::events::{DiagnosticCategory, DiagnosticSeverity, Event, InputKind};
use quanta_pty::PortablePtyPort;
use quanta_session::{InputSubmission, SessionActor, SessionConfig, SessionHandle};

fn pick_shell() -> String {
    if std::path::Path::new("/bin/bash").exists() {
        "/bin/bash".into()
    } else if std::path::Path::new("/bin/sh").exists() {
        "/bin/sh".into()
    } else {
        "/usr/bin/sh".into()
    }
}

async fn drive(command: &str) -> Vec<Event> {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig::default_login(pick_shell(), PathBuf::from("/tmp"));
    let (actor, session_id) = SessionActor::spawn(pty, log.clone(), cfg).await.unwrap();

    actor
        .submit_input(InputSubmission {
            text: command.to_string(),
            kind: InputKind::Shell,
            submit: true,
        })
        .await
        .unwrap();

    // Give the shell time to echo the canned text. We just drain briefly.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    tokio::time::timeout(std::time::Duration::from_secs(5), actor.close())
        .await
        .expect("close did not complete within 5s")
        .unwrap();

    let records = log.replay_session(session_id).await.unwrap();
    records.into_iter().map(|r| r.envelope.payload).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rustc_diagnostic_detected_from_echoed_output() {
    // Printf a canned rustc error + span. The pipeline's rustc adapter should
    // produce a `DiagnosticDetected` anchored at src/fake.rs:3:5.
    //
    // printf is used instead of echo-e-style flags because printf's
    // interpretation of `\n` is portable across sh/bash.
    let cmd =
        r"printf 'error[E0425]: cannot find value `foo` in this scope\n --> src/fake.rs:3:5\n'";
    let events = drive(cmd).await;

    let diagnostics: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            Event::DiagnosticDetected(d) => Some(d),
            _ => None,
        })
        .collect();

    assert!(
        !diagnostics.is_empty(),
        "expected at least one DiagnosticDetected event; got {}",
        events.len()
    );

    // At least one diagnostic must be from the rustc adapter and anchor at
    // our canned path/line.
    let has_rustc_hit = diagnostics.iter().any(|d| {
        d.parser_id == "rustc"
            && d.severity == DiagnosticSeverity::Error
            && d.category == DiagnosticCategory::Compiler
            && d.path
                .as_ref()
                .is_some_and(|p| p.to_string_lossy().contains("src/fake.rs"))
            && d.line == Some(3)
            && d.column == Some(5)
            && d.message.contains("E0425")
    });
    assert!(
        has_rustc_hit,
        "no matching rustc DiagnosticDetected found among {:?}",
        diagnostics
            .iter()
            .map(|d| (d.parser_id.clone(), d.path.clone(), d.line, d.column))
            .collect::<Vec<_>>()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn benign_output_does_not_emit_diagnostics() {
    // `ls /` produces a directory listing that contains colons and digits
    // but no real diagnostic shape. We must NOT emit a DiagnosticDetected.
    let events = drive("ls /tmp").await;
    let diag_count = events
        .iter()
        .filter(|e| matches!(e, Event::DiagnosticDetected(_)))
        .count();
    assert_eq!(
        diag_count, 0,
        "precision stress: saw {diag_count} DiagnosticDetected events from benign output"
    );
}
