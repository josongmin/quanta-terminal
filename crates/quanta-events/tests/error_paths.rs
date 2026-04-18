//! Error-path coverage for the event log adapter.
//!
//! Each test constructs an `EventLogError` variant the happy-path corpus does
//! not exercise, asserts the error carries the diagnostic context the variant
//! promises, and confirms the reader does not panic on malformed inputs.

use std::fs::OpenOptions;
use std::io::Write;

use quanta_events::{EventLogError, EventLogReader as _, EventSink as _, ZstdSegmentedEventLog};
use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
use quanta_proto::events::{BlockCreated, CwdSource, Event, InputKind};
use quanta_proto::ids::{BlockId, SessionId};

fn make_env(session: SessionId, seq: u64) -> Envelope<Event> {
    Envelope::new(
        session,
        seq,
        Producer::Block,
        SchemaVersion::ONE,
        Event::BlockCreated(BlockCreated {
            block_id: BlockId::new(),
            ordinal: seq,
            input_text: format!("cmd {seq}"),
            input_kind: InputKind::Shell,
            cwd: "/tmp".into(),
            cwd_source: CwdSource::Launch,
            is_compound: false,
        }),
    )
}

/// `EventLogError::Io` surfaces when the configured root path is not creatable.
#[test]
fn new_with_unwritable_root_yields_io_error() {
    // `/dev/null/foo` is not a directory on any supported OS, so `create_dir_all`
    // will fail with ENOTDIR. The adapter must translate that into `Io(..)`
    // rather than panic.
    let res = ZstdSegmentedEventLog::new("/dev/null/quanta-unwritable");
    match res {
        Err(EventLogError::Io(msg)) => {
            assert!(
                !msg.is_empty(),
                "Io error message must not be empty for diagnosis"
            );
        }
        Ok(_) => panic!("expected Io error for /dev/null/* root"),
        Err(other) => panic!("expected Io, got {other:?}"),
    }
}

/// `EventLogError::SegmentTooLarge` pins the observed size and limit so
/// operators can triage an attacker-controlled or malformed file.
#[tokio::test]
async fn oversized_segment_surfaces_segment_too_large_with_diagnostic() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    log.append(make_env(sid, 1)).await.unwrap();
    // Find the segment we just wrote.
    let dir = tmp.path().join(sid.to_string());
    let seg = std::fs::read_dir(&dir)
        .unwrap()
        .find_map(|e| {
            let p = e.ok()?.path();
            (p.extension().and_then(|s| s.to_str()) == Some("zlog")).then_some(p)
        })
        .expect("at least one segment file exists");
    // Inflate the segment to well past the reader's 256 MiB ceiling. We
    // use a sparse file so no disk space is consumed.
    let f = OpenOptions::new().write(true).open(&seg).unwrap();
    f.set_len(500 * 1024 * 1024).unwrap();
    drop(f);

    match log.replay_session(sid).await {
        Err(EventLogError::SegmentTooLarge { observed, limit }) => {
            assert!(
                observed > limit,
                "observed must exceed limit; got observed={observed} limit={limit}"
            );
            assert_eq!(limit, 256 * 1024 * 1024);
        }
        Ok(recs) => panic!("expected SegmentTooLarge, got {} records", recs.len()),
        Err(other) => panic!("expected SegmentTooLarge, got {other:?}"),
    }
}

/// A segment with a zero-byte file is legitimately present (crash after
/// `File::create` but before first write). The reader must report no records
/// without raising an error.
#[tokio::test]
async fn zero_byte_segment_replays_as_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    // Manually create an empty segment file under the session directory.
    let dir = tmp.path().join(sid.to_string());
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::File::create(dir.join("00000.zlog")).unwrap();
    let records = log.replay_session(sid).await.unwrap();
    assert!(
        records.is_empty(),
        "zero-byte segment must yield no records"
    );
}

/// A segment that contains a valid frame-length header but whose frame body is
/// pure garbage (failed to decompress) is the canonical torn-tail case.
/// Truncating to the last healthy frame and continuing is the documented
/// recovery path; this test pins the behaviour.
#[tokio::test]
async fn garbage_tail_truncates_and_preserves_healthy_prefix() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    for seq in 1..=3 {
        log.append(make_env(sid, seq)).await.unwrap();
    }
    let dir = tmp.path().join(sid.to_string());
    let seg = std::fs::read_dir(&dir)
        .unwrap()
        .find_map(|e| {
            let p = e.ok()?.path();
            (p.extension().and_then(|s| s.to_str()) == Some("zlog")).then_some(p)
        })
        .unwrap();
    // Append: (a) a valid 32-byte frame length, (b) 4 bytes of garbage that
    // cannot possibly be a zstd frame body.
    let mut f = OpenOptions::new().append(true).open(&seg).unwrap();
    f.write_all(&32u32.to_be_bytes()).unwrap();
    f.write_all(&[0xDEu8, 0xAD, 0xBE, 0xEF]).unwrap();
    drop(f);

    let records = log.replay_session(sid).await.unwrap();
    assert_eq!(
        records.len(),
        3,
        "torn tail must be truncated; healthy records preserved"
    );
}

/// Surgical assertion on `ChecksumMismatch { offset }`: the error must carry a
/// non-zero offset for a mid-segment corruption so operators can locate the
/// torn frame.
#[tokio::test]
async fn checksum_mismatch_carries_nonzero_offset_for_mid_segment_corruption() {
    use quanta_proto::envelope::Envelope;
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    for seq in 1..=3 {
        log.append(make_env(sid, seq)).await.unwrap();
    }
    log.flush().await.unwrap();
    let dir = tmp.path().join(sid.to_string());
    let seg = std::fs::read_dir(&dir)
        .unwrap()
        .find_map(|e| {
            let p = e.ok()?.path();
            (p.extension().and_then(|s| s.to_str()) == Some("zlog")).then_some(p)
        })
        .unwrap();
    // Re-encode the second frame with a flipped payload byte (same strategy as
    // the fixture corpus). Frame 0 is at offset 0; we target frame 1 so the
    // reported offset is non-zero.
    let bytes = std::fs::read(&seg).unwrap();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut offset = 0usize;
    let mut frame_idx = 0usize;
    while offset < bytes.len() {
        let frame_len = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        let frame = &bytes[offset..offset + frame_len];
        offset += frame_len;
        if frame_idx == 1 {
            let mut decompressed = zstd::decode_all(frame).unwrap();
            decompressed[8] ^= 0xFF;
            let re = zstd::encode_all(&decompressed[..], 3).unwrap();
            out.extend_from_slice(&(re.len() as u32).to_be_bytes());
            out.extend_from_slice(&re);
        } else {
            out.extend_from_slice(&(frame_len as u32).to_be_bytes());
            out.extend_from_slice(frame);
        }
        frame_idx += 1;
    }
    std::fs::write(&seg, &out).unwrap();

    let err = log.replay_session(sid).await.unwrap_err();
    match err {
        EventLogError::ChecksumMismatch { offset } => {
            assert!(
                offset > 0,
                "expected non-zero offset for mid-segment corruption, got {offset}"
            );
        }
        other => panic!("expected ChecksumMismatch, got {other:?}"),
    }
    // Silence unused-import lint if future refactors drop Envelope.
    let _ = std::marker::PhantomData::<Envelope<Event>>;
}

/// `replay_session` against a brand-new log with no sessions written returns
/// `Ok(empty)` — not an error. Pins the happy no-op contract.
#[tokio::test]
async fn replay_all_on_empty_log_yields_empty_vec() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let all = log.replay_all().await.unwrap();
    assert!(all.is_empty());
}

/// `EventLogError::PayloadTooLarge` is constructible and carries both the
/// observed declared size and the adapter's ceiling. This covers the
/// `PayloadTooLarge` arm of `decode_one_frame` that the happy-path corpus
/// never reaches (normal writes are bounded well below the 16 MiB limit).
///
/// We build a synthetic on-disk frame whose zstd-decompressed inner payload
/// declares a length of `u32::MAX` (much larger than MAX_PAYLOAD_BYTES). The
/// reader must refuse it with `PayloadTooLarge` rather than allocating.
#[tokio::test]
async fn oversized_declared_payload_surfaces_payload_too_large() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let sid = SessionId::new();
    // Seed the session dir via a legit append so the directory exists.
    log.append(make_env(sid, 1)).await.unwrap();

    let dir = tmp.path().join(sid.to_string());
    let seg = std::fs::read_dir(&dir)
        .unwrap()
        .find_map(|e| {
            let p = e.ok()?.path();
            (p.extension().and_then(|s| s.to_str()) == Some("zlog")).then_some(p)
        })
        .expect("at least one segment file exists");

    // Craft a raw frame: inner payload declares length = u32::MAX so the
    // decoder hits the MAX_PAYLOAD_BYTES guard before attempting allocation.
    // The outer structure mirrors the adapter's on-disk layout (u32 BE
    // outer-frame-len, then zstd-compressed { u32 BE payload_len, u32 BE
    // xx-checksum, payload... }).
    let bogus_payload_len: u32 = u32::MAX;
    let bogus_checksum: u32 = 0;
    let mut inner = Vec::new();
    inner.extend_from_slice(&bogus_payload_len.to_be_bytes());
    inner.extend_from_slice(&bogus_checksum.to_be_bytes());
    // The "payload" bytes we attach are irrelevant: the length header is
    // checked FIRST, so we never look at the bytes beyond it.
    inner.extend_from_slice(b"ignored");
    let compressed = zstd::encode_all(&inner[..], 3).unwrap();
    let outer_frame_len: u32 = u32::try_from(compressed.len()).unwrap();

    // Truncate the existing segment and write just our bogus frame. Replay
    // then hits `DecodeOne::PayloadTooLarge` on the first (and only) frame.
    let mut f = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&seg)
        .unwrap();
    f.write_all(&outer_frame_len.to_be_bytes()).unwrap();
    f.write_all(&compressed).unwrap();
    drop(f);

    match log.replay_session(sid).await {
        Err(EventLogError::PayloadTooLarge { observed, limit }) => {
            assert_eq!(
                observed, bogus_payload_len as usize,
                "observed must reflect the declared payload length"
            );
            assert!(
                observed > limit,
                "observed must exceed the limit; got observed={observed} limit={limit}"
            );
        }
        Ok(records) => panic!("expected PayloadTooLarge, got {} records", records.len()),
        Err(other) => panic!("expected PayloadTooLarge, got {other:?}"),
    }
}

/// `EventLogError::Closed` is a documented variant. Nothing in the adapter
/// currently constructs it (Phase 1 appends fsync synchronously so there's
/// no "flushed then closed" window). The variant is reserved for a future
/// background-flusher that may surface "writer already closed". This test
/// asserts the variant Display behaviour so a refactor that drops the
/// variant breaks here instead of silently losing an error shape.
#[test]
fn closed_variant_has_actionable_display() {
    let err = EventLogError::Closed;
    let s = format!("{err}");
    assert!(
        s.contains("closed"),
        "EventLogError::Closed Display must mention 'closed', got {s:?}"
    );
}
