//! Integration test — session-actor → event-log redaction (ADR 0006).
//!
//! The actor must redact `InputSubmitted.text` and `BlockCreated.input_text`
//! on emit. The live PTY stream still receives raw bytes (hard rule per
//! ADR 0006 §Scope), but the persisted envelope carries ONLY the redacted
//! form.
//!
//! We drive the actor with a real PTY + real event log to exercise the
//! full persistence path. The commands use well-known token shapes so the
//! default detector's matcher fires.

use std::path::PathBuf;
use std::sync::Arc;

use quanta_events::{EventLogReader as _, ZstdSegmentedEventLog};
use quanta_proto::events::{Event, InputKind};
use quanta_pty::PortablePtyPort;
use quanta_session::{InputSubmission, SessionActor, SessionConfig, SessionHandle};

fn pick_shell() -> String {
    if std::path::Path::new("/bin/sh").exists() {
        "/bin/sh".into()
    } else {
        "/usr/bin/sh".into()
    }
}

async fn drive(command: &str, submit: bool) -> Vec<Event> {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig::default_login(pick_shell(), PathBuf::from("/tmp"));
    let (actor, session_id) = SessionActor::spawn(pty, log.clone(), cfg).await.unwrap();

    actor
        .submit_input(InputSubmission {
            text: command.to_string(),
            kind: InputKind::Shell,
            submit,
        })
        .await
        .unwrap();

    // Close bounded so a regression cannot hang CI.
    tokio::time::timeout(std::time::Duration::from_secs(5), actor.close())
        .await
        .expect("close did not complete within 5s")
        .unwrap();

    let records = log.replay_session(session_id).await.unwrap();
    records.into_iter().map(|r| r.envelope.payload).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn anthropic_key_flag_is_redacted() {
    // A long, Anthropic-shaped token glued to --api-key= triggers both the
    // command_arg_flag rule AND the anthropic_api_key well-known-token rule.
    // Either path must ensure the raw value is never persisted.
    let raw_token = format!("sk-ant-{}", "x".repeat(95));
    let command = format!("deploy --api-key={raw_token}");

    let events = drive(&command, true).await;

    let submitted: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            Event::InputSubmitted(s) => Some(s.text.as_str()),
            _ => None,
        })
        .collect();
    assert!(!submitted.is_empty(), "expected InputSubmitted event");
    for text in &submitted {
        assert!(
            !text.contains(&raw_token),
            "raw secret leaked into persisted InputSubmitted: {text}"
        );
        assert!(
            text.contains("[REDACTED:"),
            "redaction marker missing from persisted InputSubmitted: {text}"
        );
    }

    // BlockCreated.input_text is also part of the persisted projection and
    // must carry the redacted form per ADR 0006 §Detection Placement.
    let block_created_texts: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            Event::BlockCreated(b) => Some(b.input_text.as_str()),
            _ => None,
        })
        .collect();
    assert!(
        !block_created_texts.is_empty(),
        "expected BlockCreated event (submit=true)"
    );
    for text in block_created_texts {
        assert!(
            !text.contains(&raw_token),
            "raw secret leaked into BlockCreated.input_text: {text}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inline_env_assignment_redacted() {
    // Shell-local assignment in front of a command. The detector's
    // env-inline rule should redact the VALUE while preserving the KEY so
    // the persisted log still reads as an assignment.
    let raw_secret = "wJalrXUtnFEMI/K7MDENG_fake_secret";
    let command = format!("AWS_SECRET_ACCESS_KEY={raw_secret} ./run");

    let events = drive(&command, true).await;

    let submitted_text = events
        .iter()
        .find_map(|e| match e {
            Event::InputSubmitted(s) => Some(s.text.clone()),
            _ => None,
        })
        .expect("InputSubmitted missing from log");
    assert!(
        !submitted_text.contains(raw_secret),
        "raw secret value persisted: {submitted_text}"
    );
    assert!(
        submitted_text.contains("AWS_SECRET_ACCESS_KEY="),
        "key prefix should be preserved so the shape of the command is readable: {submitted_text}"
    );
    assert!(
        submitted_text.contains("[REDACTED:"),
        "redaction marker missing: {submitted_text}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn benign_command_unchanged() {
    // A command with nothing sensitive must pass through unchanged — no
    // false-positive markers. ADR 0006 §False-Positive Control: over-
    // redaction trains users to disable the feature.
    let command = "ls -la /tmp";
    let events = drive(command, false).await;

    let submitted_text = events
        .iter()
        .find_map(|e| match e {
            Event::InputSubmitted(s) => Some(s.text.clone()),
            _ => None,
        })
        .expect("InputSubmitted missing from log");
    assert_eq!(submitted_text, command);
    assert!(!submitted_text.contains("[REDACTED:"));
}
