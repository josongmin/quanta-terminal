//! Corpus-driven acceptance tests for the zstd-segmented event log.
//!
//! Each fixture under `crates/quanta-events/fixtures/log/<case>/` ships a
//! `manifest.json` describing the records to write plus an optional mutation
//! (torn tail, checksum flip) and the expected replay outcome. The test
//! materializes the log into a `tempdir`, applies the mutation, and drives
//! the `ZstdSegmentedEventLog` reader under each scenario.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use quanta_events::{EventLogError, EventLogReader, EventSink, ZstdSegmentedEventLog};
use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
use quanta_proto::events::{
    BlockCompleted, BlockCreated, BlockStarted, BoundaryConfidence, BoundarySignal, CwdSource,
    Event, InputKind, OutputChunk, OutputStream,
};
use quanta_proto::ids::{BlockId, SessionId, SpanId};
use serde::Deserialize;

#[derive(Deserialize, Debug)]
#[allow(
    dead_code,
    reason = "deserialized from manifest.json; unused fields document the expected schema"
)]
struct Manifest {
    scenario: String,
    #[serde(default)]
    sessions: Vec<SessionManifest>,
    #[serde(default)]
    mutation: Option<Mutation>,
    expected: Expected,
}

#[derive(Deserialize, Debug)]
#[allow(
    dead_code,
    reason = "deserialized from manifest.json; `name` is informational"
)]
struct SessionManifest {
    name: String,
    records: Vec<RecordManifest>,
}

#[derive(Deserialize, Debug)]
struct RecordManifest {
    seq: u64,
    payload: String,
    #[serde(default)]
    exit_code: Option<i32>,
    #[serde(default)]
    bytes_b64: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Mutation {
    TruncateTrailingBytes { bytes: usize },
    FlipPayloadByteOfRecord { record_index: usize },
}

#[derive(Deserialize, Debug, Default)]
#[allow(
    dead_code,
    reason = "deserialized from manifest.json; not all expectations are asserted by every scenario"
)]
struct Expected {
    #[serde(default)]
    total_records: Option<usize>,
    #[serde(default)]
    payload_kinds_in_order: Option<Vec<String>>,
    #[serde(default)]
    expect_error: Option<String>,
    #[serde(default)]
    replay_all_total: Option<usize>,
    #[serde(default)]
    session_a_total: Option<usize>,
    #[serde(default)]
    session_b_total: Option<usize>,
}

fn corpus_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/log")
}

fn list_cases() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let Ok(entries) = std::fs::read_dir(corpus_root()) else {
        return out;
    };
    for entry in entries.flatten() {
        if entry.path().join("manifest.json").is_file() {
            out.push(entry.path());
        }
    }
    out.sort();
    out
}

#[test]
fn corpus_is_nonempty() {
    let cases = list_cases();
    assert!(
        cases.len() >= 4,
        "expected at least 4 log fixtures, found {}",
        cases.len()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_case_matches_expected() {
    let cases = list_cases();
    assert!(!cases.is_empty(), "no log fixtures found");

    for case in cases {
        let name = case.file_name().unwrap().to_string_lossy().into_owned();
        eprintln!("=== log fixture: {name} ===");
        let manifest_bytes = std::fs::read(case.join("manifest.json")).expect("read manifest");
        let manifest: Manifest =
            serde_json::from_slice(&manifest_bytes).expect("parse manifest.json");

        match manifest.scenario.as_str() {
            "healthy_session" => run_healthy(&manifest).await,
            "torn_tail" => run_torn_tail(&manifest).await,
            "corrupted_checksum" => run_corrupted_checksum(&manifest).await,
            "cross_segment" => run_cross_segment(&manifest).await,
            other => panic!("unknown scenario {other}"),
        }
    }
}

fn materialize_record(r: &RecordManifest, session: SessionId, block: BlockId) -> Envelope<Event> {
    let payload = match r.payload.as_str() {
        "BlockCreated" => Event::BlockCreated(BlockCreated {
            block_id: block,
            ordinal: r.seq - 1,
            input_text: format!("cmd #{}", r.seq),
            input_kind: InputKind::Shell,
            cwd: "/tmp".into(),
            cwd_source: CwdSource::Launch,
            is_compound: false,
        }),
        "BlockStarted" => Event::BlockStarted(BlockStarted {
            block_id: block,
            pid: Some(4200 + r.seq as u32),
        }),
        "BlockCompleted" => Event::BlockCompleted(BlockCompleted {
            block_id: block,
            exit_code: r.exit_code,
            termination_signal: None,
            boundary_signal: BoundarySignal::Osc133,
            boundary_confidence: BoundaryConfidence::Authoritative,
        }),
        "OutputChunk" => Event::OutputChunk(OutputChunk {
            span_id: SpanId::new(),
            block_id: block,
            stream: OutputStream::Stdout,
            seq: r.seq,
            byte_offset_start: 0,
            byte_offset_end: r.bytes_b64.as_ref().map(|s| s.len() as u64).unwrap_or(0),
            bytes_b64: r.bytes_b64.clone().unwrap_or_default(),
        }),
        other => panic!("unknown payload {other}"),
    };
    Envelope::new(session, r.seq, Producer::Block, SchemaVersion::ONE, payload)
}

async fn write_records(log: &ZstdSegmentedEventLog, sessions: &[(SessionId, &SessionManifest)]) {
    for (sid, sess) in sessions {
        let block = BlockId::new();
        for r in &sess.records {
            let env = materialize_record(r, *sid, block);
            log.append(env).await.expect("append");
        }
    }
}

fn payload_kind(ev: &Event) -> &'static str {
    match ev {
        Event::SessionCreated(_) => "session_created",
        Event::SessionShellIntegrationStatus(_) => "session_shell_integration_status",
        Event::SessionCwdChanged(_) => "session_cwd_changed",
        Event::SessionEnded(_) => "session_ended",
        Event::BlockCreated(_) => "block_created",
        Event::BlockStarted(_) => "block_started",
        Event::BlockCompleted(_) => "block_completed",
        Event::BlockCanceled(_) => "block_canceled",
        Event::BlockDetached(_) => "block_detached",
        Event::BlockTuiEntered(_) => "block_tui_entered",
        Event::BlockTuiExited(_) => "block_tui_exited",
        Event::OutputChunk(_) => "output_chunk",
        Event::OutputTruncated(_) => "output_truncated",
        Event::InputSubmitted(_) => "input_submitted",
        Event::DiagnosticDetected(_) => "diagnostic_detected",
        Event::SuggestionGenerated(_) => "suggestion_generated",
        Event::SuggestionReviewed(_) => "suggestion_reviewed",
        Event::HistoryIndexed(_) => "history_indexed",
        Event::GridSnapshot(_) => "grid_snapshot",
        Event::GridDelta(_) => "grid_delta",
        Event::CursorMoved(_) => "cursor_moved",
        Event::ModeChanged(_) => "mode_changed",
        Event::TitleChanged(_) => "title_changed",
        Event::BellRequested(_) => "bell_requested",
        Event::HyperlinkAdded(_) => "hyperlink_added",
        Event::HyperlinkRemoved(_) => "hyperlink_removed",
        Event::ClipboardRequest(_) => "clipboard_request",
        Event::SynchronizedUpdate(_) => "synchronized_update",
        Event::Unknown { .. } => "unknown",
    }
}

async fn run_healthy(manifest: &Manifest) {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    let sess = &manifest.sessions[0];
    write_records(&log, &[(sid, sess)]).await;

    let records = log.replay_session(sid).await.expect("replay");
    assert_eq!(records.len(), manifest.expected.total_records.unwrap());
    if let Some(order) = &manifest.expected.payload_kinds_in_order {
        let actual: Vec<&'static str> = records
            .iter()
            .map(|r| payload_kind(&r.envelope.payload))
            .collect();
        assert_eq!(&actual, order);
    }
}

async fn run_torn_tail(manifest: &Manifest) {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    let sess = &manifest.sessions[0];
    write_records(&log, &[(sid, sess)]).await;

    // Append a few spurious bytes to the session's segment to simulate a torn
    // write. Layout is `<root>/<session>/<nnnnn>.zlog`.
    let seg = first_segment_for(tmp.path(), sid);
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&seg).unwrap();
        // Write a fake frame length header but no body.
        f.write_all(&[0x00, 0x00, 0x00, 0x20]).unwrap(); // claims 32-byte frame
        f.write_all(b"partial").unwrap(); // only 7 bytes, not 32
    }

    // Now truncate some bytes off the tail per manifest (sanity; already torn).
    if let Some(Mutation::TruncateTrailingBytes { bytes }) = manifest.mutation.as_ref() {
        let len = std::fs::metadata(&seg).unwrap().len();
        let new_len = len.saturating_sub(*bytes as u64);
        let file = std::fs::OpenOptions::new().write(true).open(&seg).unwrap();
        file.set_len(new_len).unwrap();
    }

    // The reader must stop cleanly, returning only the healthy records.
    let records = log.replay_session(sid).await.expect("replay");
    assert_eq!(records.len(), manifest.expected.total_records.unwrap());
    if let Some(order) = &manifest.expected.payload_kinds_in_order {
        let actual: Vec<&'static str> = records
            .iter()
            .map(|r| payload_kind(&r.envelope.payload))
            .collect();
        assert_eq!(&actual, order);
    }
}

fn first_segment_for(root: &Path, sid: SessionId) -> PathBuf {
    let dir = root.join(sid.to_string());
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("session dir {:?} missing: {e}", dir))
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("zlog"))
        .collect();
    entries.sort();
    entries.into_iter().next().expect("no .zlog in session dir")
}

async fn run_corrupted_checksum(manifest: &Manifest) {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    let sess = &manifest.sessions[0];
    write_records(&log, &[(sid, sess)]).await;

    let record_index = match manifest.mutation.as_ref() {
        Some(Mutation::FlipPayloadByteOfRecord { record_index }) => *record_index,
        _ => panic!("corrupted_checksum requires flip mutation"),
    };

    // Surgery: flip one payload byte inside the Nth frame. The on-disk layout
    // is a concatenation of `[4 BE frame_len][zstd frame]` units; each zstd
    // frame decompresses to `[4 BE payload_len][4 BE xxh][payload]`.
    log.flush().await.unwrap();
    let seg = first_segment_for(tmp.path(), sid);
    flip_payload_byte_in_frame(&seg, record_index);

    let res = log.replay_session(sid).await;
    match res {
        Err(EventLogError::ChecksumMismatch { .. }) => {}
        Err(other) => panic!(
            "expected ChecksumMismatch, got {other:?} (scenario={})",
            manifest.scenario
        ),
        Ok(recs) => panic!(
            "expected ChecksumMismatch error but got {} records (scenario={})",
            recs.len(),
            manifest.scenario
        ),
    }
}

async fn run_cross_segment(manifest: &Manifest) {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid_a = SessionId::new();
    let sid_b = SessionId::new();
    let sessions = &manifest.sessions;
    write_records(&log, &[(sid_a, &sessions[0]), (sid_b, &sessions[1])]).await;

    let all = log.replay_all().await.expect("replay_all");
    assert_eq!(
        all.len(),
        manifest.expected.replay_all_total.unwrap(),
        "replay_all total mismatch"
    );

    // Confirm the per-file segmentation: each session gets its own `.zlog`.
    let mut by_session: HashMap<SessionId, usize> = HashMap::new();
    for rec in &all {
        *by_session.entry(rec.envelope.session_id).or_default() += 1;
    }
    let a_count = *by_session.get(&sid_a).unwrap_or(&0);
    let b_count = *by_session.get(&sid_b).unwrap_or(&0);
    assert_eq!(a_count, manifest.expected.session_a_total.unwrap());
    assert_eq!(b_count, manifest.expected.session_b_total.unwrap());

    // Per-session replay also holds.
    let a_records = log.replay_session(sid_a).await.unwrap();
    let b_records = log.replay_session(sid_b).await.unwrap();
    assert_eq!(a_records.len(), manifest.expected.session_a_total.unwrap());
    assert_eq!(b_records.len(), manifest.expected.session_b_total.unwrap());
}

/// In-place flip a byte inside the decompressed payload of the Nth frame so
/// the stored xxh32 no longer matches. Preserves frame structure so the
/// reader still parses the envelope and reaches the checksum step.
fn flip_payload_byte_in_frame(path: &Path, target_index: usize) {
    let bytes = std::fs::read(path).unwrap();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut offset = 0usize;
    let mut frame_idx = 0usize;
    while offset < bytes.len() {
        assert!(bytes.len() - offset >= 4, "malformed fixture file");
        let frame_len = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        assert!(bytes.len() - offset >= frame_len, "truncated fixture frame");
        let frame = &bytes[offset..offset + frame_len];
        offset += frame_len;

        if frame_idx == target_index {
            // Decompress, flip the first payload byte (position 8), recompress.
            let mut decompressed = zstd::decode_all(frame).expect("decode frame");
            assert!(
                decompressed.len() > 8,
                "decompressed frame too short to flip"
            );
            decompressed[8] ^= 0xFF;
            let recompressed = zstd::encode_all(&decompressed[..], 3).expect("recompress");
            let new_len = recompressed.len() as u32;
            out.extend_from_slice(&new_len.to_be_bytes());
            out.extend_from_slice(&recompressed);
        } else {
            out.extend_from_slice(&(frame_len as u32).to_be_bytes());
            out.extend_from_slice(frame);
        }
        frame_idx += 1;
    }
    std::fs::write(path, out).unwrap();
}
