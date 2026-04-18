//! Edge-case coverage for the zstd-segmented event log.
//!
//! Covers corners the main error-paths and corpus tests don't:
//! - A single-byte segment file is corruption; reader reports cleanly.
//! - An envelope whose event_id appears twice across two appends survives
//!   (the reader is not responsible for dedupe; that is a reducer concern).
//! - Appending an `OutputChunk` with `bytes_b64 == ""` round-trips.
//! - Envelope with `monotonic_seq = u64::MAX - 1` round-trips.

use quanta_events::{EventLogError, EventLogReader as _, EventSink as _, ZstdSegmentedEventLog};
use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
use quanta_proto::events::{
    BlockCompleted, BoundaryConfidence, BoundarySignal, Event, OutputChunk, OutputStream,
};
use quanta_proto::ids::{BlockId, SessionId, SpanId};

/// A segment that is a single byte long is insufficient even to carry a
/// frame-length header. The reader must either ignore it or report a clean
/// IO / decode error — NEVER panic.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn single_byte_segment_is_reported_cleanly() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    // Manually write a one-byte segment file under the session dir.
    let dir = tmp.path().join(sid.to_string());
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("00000.zlog"), [0x41]).unwrap();

    let res = log.replay_session(sid).await;
    match res {
        Ok(recs) => {
            // Acceptable: reader reports no records for the malformed file.
            assert!(
                recs.is_empty(),
                "a single-byte segment cannot produce records"
            );
        }
        Err(EventLogError::Io(_) | EventLogError::Decode(_)) => {
            // Also acceptable — surfaces the corruption.
        }
        Err(other) => panic!("unexpected error {other:?}"),
    }
}

/// The reader must not surface an error when asked to replay a session that
/// has NEVER had a record appended. Happy no-op.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_nonexistent_session_yields_empty_vec() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let records = log.replay_session(SessionId::new()).await.unwrap();
    assert!(records.is_empty());
}

/// Round-trip an OutputChunk whose `bytes_b64` is the empty string. Base64
/// of zero bytes is a valid payload; the log must not filter it out.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn empty_bytes_b64_output_chunk_roundtrips() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    let block = BlockId::new();
    let env = Envelope::new(
        sid,
        1,
        Producer::Output,
        SchemaVersion::ONE,
        Event::OutputChunk(OutputChunk {
            span_id: SpanId::new(),
            block_id: block,
            stream: OutputStream::Stdout,
            seq: 0,
            byte_offset_start: 0,
            byte_offset_end: 0,
            bytes_b64: String::new(),
        }),
    );
    log.append(env).await.unwrap();
    log.flush().await.unwrap();

    let records = log.replay_session(sid).await.unwrap();
    assert_eq!(records.len(), 1);
    match &records[0].envelope.payload {
        Event::OutputChunk(c) => assert!(c.bytes_b64.is_empty()),
        other => panic!("unexpected {other:?}"),
    }
}

/// `monotonic_seq = u64::MAX - 1` round-trips. The reader makes no
/// assumption about the seq domain beyond strict ordering.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn monotonic_seq_at_near_ceiling_roundtrips() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    let block = BlockId::new();
    let env = Envelope::new(
        sid,
        u64::MAX - 1,
        Producer::Block,
        SchemaVersion::ONE,
        Event::BlockCompleted(BlockCompleted {
            block_id: block,
            exit_code: Some(0),
            termination_signal: None,
            boundary_signal: BoundarySignal::Osc133,
            boundary_confidence: BoundaryConfidence::Authoritative,
        }),
    );
    log.append(env).await.unwrap();
    log.flush().await.unwrap();

    let records = log.replay_session(sid).await.unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].envelope.monotonic_seq, u64::MAX - 1);
}

/// Two records with the same `event_id` must both appear in replay order —
/// the log is append-only, dedup is the reducer's problem per ADR 0011.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_event_id_is_preserved_by_the_log() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    let block = BlockId::new();
    let env = Envelope::new(
        sid,
        1,
        Producer::Block,
        SchemaVersion::ONE,
        Event::BlockCompleted(BlockCompleted {
            block_id: block,
            exit_code: Some(0),
            termination_signal: None,
            boundary_signal: BoundarySignal::Osc133,
            boundary_confidence: BoundaryConfidence::Authoritative,
        }),
    );
    // Clone the envelope so event_id is identical.
    let mut dup = env.clone();
    dup.monotonic_seq = 2;
    log.append(env).await.unwrap();
    log.append(dup).await.unwrap();
    log.flush().await.unwrap();

    let records = log.replay_session(sid).await.unwrap();
    assert_eq!(records.len(), 2, "duplicates are not filtered at the log");
    assert_eq!(records[0].envelope.event_id, records[1].envelope.event_id);
}

/// After a successful write, replaying the wrong session id returns empty —
/// sessions are isolated on disk.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_wrong_session_returns_empty_not_leak() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid_a = SessionId::new();
    let sid_b = SessionId::new();
    let block = BlockId::new();
    let env = Envelope::new(
        sid_a,
        1,
        Producer::Block,
        SchemaVersion::ONE,
        Event::BlockCompleted(BlockCompleted {
            block_id: block,
            exit_code: Some(0),
            termination_signal: None,
            boundary_signal: BoundarySignal::Osc133,
            boundary_confidence: BoundaryConfidence::Authoritative,
        }),
    );
    log.append(env).await.unwrap();
    log.flush().await.unwrap();
    let wrong = log.replay_session(sid_b).await.unwrap();
    assert!(wrong.is_empty(), "wrong session must not leak records");
}
