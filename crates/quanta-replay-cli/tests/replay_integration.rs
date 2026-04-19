//! Integration tests — drive the public `replay()` entry end-to-end against
//! a freshly-written log under a temp dir. We construct events through the
//! upstream `EventSink` API so the fixture is guaranteed to match what a
//! real session writes on disk (no hand-crafted JSON).

use quanta_events::{EventSink, ZstdSegmentedEventLog};
use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
use quanta_proto::events::{
    BlockCanceled, BlockCreated, CwdSource, Event, InputKind, SessionCreated,
};
use quanta_proto::ids::{BlockId, SessionId};
use quanta_replay_cli::{replay, Options, OutputFormat};

fn bc_event(block_id: BlockId) -> Event {
    Event::BlockCreated(BlockCreated {
        block_id,
        ordinal: 0,
        input_text: "echo hi".into(),
        input_kind: InputKind::Shell,
        cwd: "/tmp".into(),
        cwd_source: CwdSource::Launch,
        is_compound: false,
    })
}

fn bcan_event(block_id: BlockId) -> Event {
    Event::BlockCanceled(BlockCanceled { block_id })
}

async fn seed_log(root: &std::path::Path) -> (SessionId, SessionId) {
    let log = ZstdSegmentedEventLog::new(root).expect("open log");
    let session_a = SessionId::new();
    let session_b = SessionId::new();

    // Three events under session_a, seq 1..=3.
    for (seq, ev) in [
        (
            1u64,
            Event::SessionCreated(SessionCreated {
                session_id: session_a,
                workspace_id: None,
                shell: "/bin/sh".into(),
                launch_cwd: "/tmp".into(),
            }),
        ),
        (2, bc_event(BlockId::new())),
        (3, bcan_event(BlockId::new())),
    ] {
        let env = Envelope::new(session_a, seq, Producer::Session, SchemaVersion::ONE, ev);
        log.append(env).await.expect("append a");
    }

    // Two events under session_b — `replay_session(a)` must not pick these up.
    for (seq, ev) in [
        (
            1u64,
            Event::SessionCreated(SessionCreated {
                session_id: session_b,
                workspace_id: None,
                shell: "/bin/zsh".into(),
                launch_cwd: "/tmp".into(),
            }),
        ),
        (2, bc_event(BlockId::new())),
    ] {
        let env = Envelope::new(session_b, seq, Producer::Session, SchemaVersion::ONE, ev);
        log.append(env).await.expect("append b");
    }

    log.flush().await.expect("flush");
    (session_a, session_b)
}

#[tokio::test]
async fn replay_end_to_end_emits_one_line_per_record() {
    let dir = tempfile::tempdir().unwrap();
    let (_a, _b) = seed_log(dir.path()).await;

    let mut buf = Vec::<u8>::new();
    let opts = Options {
        profile_dir: dir.path().to_path_buf(),
        session_id: None,
        until_seq: None,
        format: OutputFormat::Ndjson,
        filter_kind: None,
    };
    replay(&opts, &mut buf).await.expect("replay ok");

    let s = String::from_utf8(buf).unwrap();
    let lines: Vec<&str> = s.lines().collect();
    assert_eq!(
        lines.len(),
        5,
        "expected 5 records: 3 from A + 2 from B; got: {s}"
    );

    // Each line must parse as JSON and carry the top-level keys the spec
    // pinned (session_id, seq, kind, envelope).
    for line in &lines {
        let v: serde_json::Value = serde_json::from_str(line).expect("json");
        assert!(v["session_id"].is_string());
        assert!(v["seq"].is_u64());
        assert!(v["kind"].is_string());
        assert!(v["envelope"].is_object());
    }
}

#[tokio::test]
async fn replay_filters_by_session_id() {
    let dir = tempfile::tempdir().unwrap();
    let (session_a, _) = seed_log(dir.path()).await;

    let mut buf = Vec::<u8>::new();
    let opts = Options {
        profile_dir: dir.path().to_path_buf(),
        session_id: Some(session_a),
        until_seq: None,
        format: OutputFormat::Ndjson,
        filter_kind: None,
    };
    replay(&opts, &mut buf).await.expect("replay ok");
    let s = String::from_utf8(buf).unwrap();
    let lines: Vec<&str> = s.lines().collect();
    assert_eq!(lines.len(), 3, "expected exactly session A's 3 records");

    for line in &lines {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(v["session_id"], session_a.to_string());
    }
}

#[tokio::test]
async fn replay_honors_until_seq() {
    let dir = tempfile::tempdir().unwrap();
    let (session_a, _) = seed_log(dir.path()).await;

    let mut buf = Vec::<u8>::new();
    let opts = Options {
        profile_dir: dir.path().to_path_buf(),
        session_id: Some(session_a),
        until_seq: Some(2),
        format: OutputFormat::Ndjson,
        filter_kind: None,
    };
    replay(&opts, &mut buf).await.expect("replay ok");
    let s = String::from_utf8(buf).unwrap();
    let lines: Vec<&str> = s.lines().collect();
    // --until-seq 2 keeps seq 1 and 2, drops seq 3.
    assert_eq!(lines.len(), 2, "expected seq 1 and 2, got: {s}");
    for line in &lines {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        assert!(v["seq"].as_u64().unwrap() <= 2);
    }
}

#[tokio::test]
async fn replay_filter_kind_narrows_output() {
    let dir = tempfile::tempdir().unwrap();
    let (session_a, _) = seed_log(dir.path()).await;

    let mut buf = Vec::<u8>::new();
    let opts = Options {
        profile_dir: dir.path().to_path_buf(),
        session_id: Some(session_a),
        until_seq: None,
        format: OutputFormat::Ndjson,
        filter_kind: Some("block_created".into()),
    };
    replay(&opts, &mut buf).await.expect("replay ok");
    let s = String::from_utf8(buf).unwrap();
    let lines: Vec<&str> = s.lines().collect();
    assert_eq!(
        lines.len(),
        1,
        "only the block_created record should survive"
    );
    let v: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(v["kind"], "block_created");
}

#[tokio::test]
async fn pretty_format_emits_indented_json() {
    let dir = tempfile::tempdir().unwrap();
    let (session_a, _) = seed_log(dir.path()).await;

    let mut buf = Vec::<u8>::new();
    let opts = Options {
        profile_dir: dir.path().to_path_buf(),
        session_id: Some(session_a),
        until_seq: Some(1),
        format: OutputFormat::Pretty,
        filter_kind: None,
    };
    replay(&opts, &mut buf).await.expect("replay ok");
    let s = String::from_utf8(buf).unwrap();
    // Pretty output contains newline-indented keys.
    assert!(
        s.contains("  \"session_id\""),
        "expected pretty JSON; got {s}"
    );
}
