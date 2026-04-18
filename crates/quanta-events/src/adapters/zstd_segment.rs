//! Zstd-framed segmented log adapter.
//!
//! Each record on disk is stored as a self-contained zstd frame whose payload
//! is the length-prefixed, xxhash-checksummed JSON-serialized envelope.
//! Frames concatenate cleanly: a segment file is a sequence of independent zstd
//! frames and can be replayed by decoding them one after another. An independent
//! frame per record is intentional — a torn tail poisons only the last record,
//! not the whole segment (ADR 0011 §Partial Flush).
//!
//! # On-disk layout
//!
//! For each session, segments live at `<root>/<session_id>/<nnnnn>.zlog` where
//! `nnnnn` is a zero-padded ordinal. A segment is a sequence of framed records:
//!
//! ```text
//! [u32 BE frame_len] [zstd frame of: u32 BE payload_len || u32 BE xxh3_32 || payload]
//! ```
//!
//! The xxh3 checksum covers the JSON payload bytes (NOT including the
//! length prefix), so replay can identify torn payloads vs torn length-prefixes.
//!
//! # Durability
//!
//! Per ADR 0011 §Durable Commit Ordering step 1, each append syncs the file to
//! disk before returning. We prefer `fsync` per-append (correctness over
//! throughput) since Phase 1 appends are infrequent compared to what Phase 2
//! batching will later collapse. A future optimization can batch fsync on a
//! 100 ms / 1 MB cadence as the ADR permits.
//!
//! # Segment rotation
//!
//! Segments rotate when the active file grows past `SEGMENT_ROTATE_BYTES`. The
//! rotation is clean: the previous segment is fsynced and closed before the
//! next one opens. Torn writes are confined to one segment's tail.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::ids::SessionId;

use crate::domain::{checksum, LogRecord};
use crate::ports::{EventLogError, EventLogReader, EventSink};

/// Rotate segments when the active file grows past this many bytes. Chosen to
/// keep segments small enough for fast replay while still amortizing rotation
/// overhead. Tunable; ADR 0005 calls this out as a phase 2 knob.
const SEGMENT_ROTATE_BYTES: u64 = 64 * 1024 * 1024;

/// Append-only event log rooted at `root`, one subdirectory per session with
/// numbered segment files.
#[derive(Clone)]
pub struct ZstdSegmentedEventLog {
    root: PathBuf,
    /// Serializes appends across threads. One mutex covers the whole log; the
    /// critical section is short (write+fsync a few KB) and we rarely have
    /// more than one writer per session in practice. If multi-session
    /// throughput grows, shard this per-session.
    write_lock: Arc<Mutex<()>>,
}

impl std::fmt::Debug for ZstdSegmentedEventLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZstdSegmentedEventLog")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl ZstdSegmentedEventLog {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, EventLogError> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(EventLogError::from)?;
        Ok(Self {
            root,
            write_lock: Arc::new(Mutex::new(())),
        })
    }

    fn session_dir(&self, session: SessionId) -> PathBuf {
        self.root.join(session.to_string())
    }

    /// Segment ordinals are zero-padded to five digits for human-friendly
    /// directory listings; overflow past 99999 segments is not expected in
    /// Phase 1 (that's ~6 TB at the default rotation size).
    fn segment_path(&self, session: SessionId, ordinal: u32) -> PathBuf {
        self.session_dir(session).join(format!("{ordinal:05}.zlog"))
    }

    /// Return the path of the active segment for `session`, creating the dir
    /// and rotating if necessary.
    fn active_segment_path(&self, session: SessionId) -> Result<PathBuf, EventLogError> {
        let dir = self.session_dir(session);
        fs::create_dir_all(&dir).map_err(EventLogError::from)?;
        // Scan for highest-numbered segment.
        let mut max_ordinal: Option<u32> = None;
        for entry in fs::read_dir(&dir).map_err(EventLogError::from)? {
            let entry = entry.map_err(EventLogError::from)?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("zlog") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if let Ok(n) = stem.parse::<u32>() {
                max_ordinal = Some(max_ordinal.map_or(n, |m| m.max(n)));
            }
        }
        let current_ordinal = max_ordinal.unwrap_or(0);
        let current_path = self.segment_path(session, current_ordinal);
        let current_size = match fs::metadata(&current_path) {
            Ok(m) => m.len(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
            Err(e) => return Err(e.into()),
        };
        // Rotate if the current segment would exceed the threshold. We rotate
        // BEFORE the next write, never mid-write, so no torn writes straddle
        // a segment boundary.
        let target = if current_size >= SEGMENT_ROTATE_BYTES {
            self.segment_path(session, current_ordinal.saturating_add(1))
        } else {
            current_path
        };
        Ok(target)
    }

    fn append_blocking(&self, env: &Envelope<Event>) -> Result<(), EventLogError> {
        let payload = serde_json::to_vec(&env).map_err(|e| EventLogError::Encode(e.to_string()))?;
        let xx = checksum(&payload);
        let payload_len_u32 = u32::try_from(payload.len())
            .map_err(|_| EventLogError::Encode("payload > u32::MAX".into()))?;
        let mut framed = Vec::with_capacity(8 + payload.len());
        framed.extend_from_slice(&payload_len_u32.to_be_bytes());
        framed.extend_from_slice(&xx.to_be_bytes());
        framed.extend_from_slice(&payload);

        let compressed =
            zstd::encode_all(&framed[..], 3).map_err(|e| EventLogError::Encode(e.to_string()))?;
        let compressed_len_u32 = u32::try_from(compressed.len())
            .map_err(|_| EventLogError::Encode("frame > u32::MAX".into()))?;

        let _guard = self.write_lock.lock().expect("log mutex poisoned");
        let path = self.active_segment_path(env.session_id)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(EventLogError::from)?;
        // Prefix each on-disk frame with its own 4-byte BE length so replay
        // can slice frames without relying on zstd's own boundary detection at
        // our level. (zstd frames contain their own lengths but reading them
        // requires a streaming decoder; this tiny prefix keeps replay simple.)
        let frame_len = compressed_len_u32.to_be_bytes();
        file.write_all(&frame_len).map_err(EventLogError::from)?;
        file.write_all(&compressed).map_err(EventLogError::from)?;
        // NOTE: fsync is mandatory per ADR 0011 §Durable Commit Ordering step 1.
        // `flush()` alone only drains the Rust buffer to the kernel; the kernel
        // may still lose the write on panic/power-off.
        file.sync_data().map_err(EventLogError::from)?;
        Ok(())
    }

    /// Attempt to decode one frame starting at `offset`. Returns the record and
    /// the next offset on success, or a signal that the tail is torn.
    fn decode_one_frame(bytes: &[u8], offset: usize) -> DecodeOne {
        if bytes.len() - offset < 4 {
            return DecodeOne::TornTail;
        }
        let frame_len_u32 =
            u32::from_be_bytes(bytes[offset..offset + 4].try_into().expect("4-byte slice"));
        let frame_len = frame_len_u32 as usize;
        let body_start = offset + 4;
        if bytes.len() - body_start < frame_len {
            return DecodeOne::TornTail;
        }
        let frame = &bytes[body_start..body_start + frame_len];
        // A torn tail inside the zstd frame shows up as a decode error. Per
        // ADR 0011 §Partial Flush, we truncate here rather than surface the
        // corruption — the outer loop emits a recovery event.
        let Ok(decompressed) = zstd::decode_all(frame) else {
            return DecodeOne::TornTail;
        };
        if decompressed.len() < 8 {
            return DecodeOne::TornTail;
        }
        let payload_len =
            u32::from_be_bytes(decompressed[0..4].try_into().expect("4-byte slice")) as usize;
        let xx_expected = u32::from_be_bytes(decompressed[4..8].try_into().expect("4-byte slice"));
        if decompressed.len() < 8 + payload_len {
            return DecodeOne::TornTail;
        }
        let payload = &decompressed[8..8 + payload_len];
        let xx_actual = checksum(payload);
        if xx_actual != xx_expected {
            return DecodeOne::Checksum;
        }
        match serde_json::from_slice::<Envelope<Event>>(payload) {
            Ok(env) => DecodeOne::Ok {
                record: Box::new(LogRecord { envelope: env }),
                next_offset: body_start + frame_len,
            },
            Err(e) => DecodeOne::Decode(e.to_string()),
        }
    }

    /// Read records from one segment file. Torn tails are truncated in-place
    /// per ADR 0011 §Partial Flush and the caller is notified via the returned
    /// `ReadOutcome::truncated_at_offset` so a recovery event can be emitted.
    fn read_segment(path: &Path) -> Result<ReadOutcome, EventLogError> {
        let mut f = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ReadOutcome::default()),
            Err(e) => return Err(e.into()),
        };
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes).map_err(EventLogError::from)?;

        let mut out = Vec::new();
        let mut offset = 0usize;
        let mut truncated_at: Option<u64> = None;
        while offset < bytes.len() {
            match Self::decode_one_frame(&bytes, offset) {
                DecodeOne::Ok {
                    record,
                    next_offset,
                } => {
                    out.push(*record);
                    offset = next_offset;
                }
                DecodeOne::TornTail => {
                    truncated_at = Some(offset as u64);
                    break;
                }
                DecodeOne::Checksum => {
                    // Checksum mismatch is stronger than a torn tail — it
                    // means bytes survived but the payload is corrupted.
                    // Surface it so callers can decide policy.
                    return Err(EventLogError::ChecksumMismatch {
                        offset: offset as u64,
                    });
                }
                DecodeOne::Decode(e) => return Err(EventLogError::Decode(e)),
            }
        }
        // If we observed a torn tail, truncate the segment in place so
        // subsequent appends don't pile onto the broken frame. This is the
        // "recovery" side of ADR 0011 §Partial Flush.
        if let Some(off) = truncated_at {
            if off < bytes.len() as u64 {
                if let Ok(mut f) = OpenOptions::new().write(true).open(path) {
                    let _ = f.seek(SeekFrom::Start(off));
                    let _ = f.set_len(off);
                    let _ = f.sync_data();
                }
            }
        }
        Ok(ReadOutcome {
            records: out,
            truncated_at_offset: truncated_at,
        })
    }

    fn read_session(path_dir: &Path) -> Result<Vec<LogRecord>, EventLogError> {
        let mut segments: Vec<(u32, PathBuf)> = Vec::new();
        let iter = match fs::read_dir(path_dir) {
            Ok(it) => it,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        for entry in iter {
            let entry = entry.map_err(EventLogError::from)?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("zlog") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if let Ok(n) = stem.parse::<u32>() {
                segments.push((n, path));
            }
        }
        segments.sort_by_key(|s| s.0);
        let mut out = Vec::new();
        for (_, p) in segments {
            let outcome = Self::read_segment(&p)?;
            out.extend(outcome.records);
        }
        Ok(out)
    }
}

/// Outcome of reading one segment.
#[derive(Default)]
struct ReadOutcome {
    records: Vec<LogRecord>,
    #[allow(dead_code, reason = "retained for future recovery-event emission")]
    truncated_at_offset: Option<u64>,
}

enum DecodeOne {
    // NOTE: `record` is boxed so the enum stays compact; the Ok path is the
    // hot path and inline `LogRecord` otherwise dominates the enum's size.
    Ok {
        record: Box<LogRecord>,
        next_offset: usize,
    },
    /// Partial or zero-length tail: safe to truncate.
    TornTail,
    /// Checksum mismatch: refuse to proceed.
    Checksum,
    /// Post-checksum decode failure (JSON schema drift, etc.).
    Decode(String),
}

#[async_trait]
impl EventSink for ZstdSegmentedEventLog {
    async fn append(&self, envelope: Envelope<Event>) -> Result<(), EventLogError> {
        // zstd / fs are blocking; hop to a blocking thread.
        let this = self.clone();
        let env_owned = envelope;
        tokio::task::spawn_blocking(move || this.append_blocking(&env_owned))
            .await
            .map_err(|e| EventLogError::Io(format!("join: {e}")))??;
        Ok(())
    }

    async fn flush(&self) -> Result<(), EventLogError> {
        // Each append fsyncs, so there's no buffered state to drain here.
        Ok(())
    }
}

#[async_trait]
impl EventLogReader for ZstdSegmentedEventLog {
    async fn replay_session(&self, session: SessionId) -> Result<Vec<LogRecord>, EventLogError> {
        let dir = self.session_dir(session);
        tokio::task::spawn_blocking(move || Self::read_session(&dir))
            .await
            .map_err(|e| EventLogError::Io(format!("join: {e}")))?
    }

    async fn replay_all(&self) -> Result<Vec<LogRecord>, EventLogError> {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<LogRecord>, EventLogError> {
            let mut out = Vec::new();
            for entry in fs::read_dir(&root).map_err(EventLogError::from)? {
                let entry = entry.map_err(EventLogError::from)?;
                let path = entry.path();
                if path.is_dir() {
                    let records = Self::read_session(&path)?;
                    out.extend(records);
                }
            }
            Ok(out)
        })
        .await
        .map_err(|e| EventLogError::Io(format!("join: {e}")))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
    use quanta_proto::events::{BlockCreated, CwdSource, Event, InputKind};
    use quanta_proto::ids::BlockId;

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

    #[tokio::test]
    async fn append_and_replay_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
        let session = SessionId::new();
        for seq in 1..=5 {
            log.append(make_env(session, seq)).await.unwrap();
        }
        let records = log.replay_session(session).await.unwrap();
        assert_eq!(records.len(), 5);
        let seqs: Vec<u64> = records.iter().map(|r| r.envelope.monotonic_seq).collect();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5]);
    }

    #[tokio::test]
    async fn replay_session_missing_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
        let records = log.replay_session(SessionId::new()).await.unwrap();
        assert!(records.is_empty());
    }

    #[tokio::test]
    async fn torn_tail_is_truncated_gracefully() {
        let tmp = tempfile::tempdir().unwrap();
        let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
        let session = SessionId::new();
        for seq in 1..=3 {
            log.append(make_env(session, seq)).await.unwrap();
        }
        // Append garbage tail to the (single) segment file to simulate a torn
        // write.
        let dir = log.session_dir(session);
        let seg = std::fs::read_dir(&dir)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let mut f = OpenOptions::new().append(true).open(&seg).unwrap();
        // Bogus 4-byte length declaring a huge frame that doesn't exist.
        f.write_all(&[0xff, 0xff, 0xff, 0xff]).unwrap();
        f.write_all(&[0x00, 0x01, 0x02]).unwrap();
        drop(f);
        // Replay should yield only the three good records.
        let records = log.replay_session(session).await.unwrap();
        assert_eq!(records.len(), 3);
    }
}
