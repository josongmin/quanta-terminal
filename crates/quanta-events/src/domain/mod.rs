//! Event log domain — record framing, checksums, replay types.
//!
//! A log record on disk (after zstd framing is removed) is:
//!
//! ```text
//! [4 bytes BE length] [4 bytes BE xxhash32] [payload bytes...]
//! ```
//!
//! The payload is a JSON-serialized `Envelope<Event>`.

use serde::{Deserialize, Serialize};

use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::ids::{EventId, SessionId};

/// A record as read back from the log. Distinct from a raw envelope because
/// replay may reveal corruption signals that domain consumers need to see.
#[derive(Clone, Debug)]
pub struct LogRecord {
    pub envelope: Envelope<Event>,
}

impl LogRecord {
    #[must_use]
    pub fn session_id(&self) -> SessionId {
        self.envelope.session_id
    }

    #[must_use]
    pub fn event_id(&self) -> EventId {
        self.envelope.event_id
    }
}

/// Record id is simply the envelope's event id; kept as an alias so downstream
/// code can read intent.
pub type RecordId = EventId;

/// Lightweight log statistics (useful for tests and debugging).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct LogStats {
    pub total_records: u64,
    pub total_bytes: u64,
}

/// Compute the xxh3-64 checksum (truncated to u32 low bits) used per record.
///
/// xxh3 is the default xxhash variant enabled via the `xxh3` feature in the
/// workspace. The 64-bit digest is truncated to 32 bits for on-disk frame
/// headers; collisions at 2^32 are acceptable for torn-write detection.
#[must_use]
#[expect(
    clippy::cast_possible_truncation,
    reason = "intentional: 32 low bits are the checksum tag; collisions are acceptable for torn-write detection"
)]
pub fn checksum(bytes: &[u8]) -> u32 {
    xxhash_rust::xxh3::xxh3_64(bytes) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_is_stable_across_calls() {
        let a = checksum(b"hello");
        let b = checksum(b"hello");
        assert_eq!(a, b);
        assert_ne!(a, checksum(b"world"));
    }

    #[test]
    fn checksum_empty_is_defined_and_stable() {
        // xxh3 of an empty slice is a defined constant; ensure we don't panic
        // and that two calls agree.
        let a = checksum(&[]);
        let b = checksum(&[]);
        assert_eq!(a, b);
    }

    #[test]
    fn checksum_single_byte_flip_changes_output() {
        // Any bit-level corruption must flip the checksum (with
        // overwhelmingly high probability — xxh3 is non-cryptographic but
        // avalanche is strong on one-bit differences for our use case).
        let mut buf = vec![0u8; 64];
        let base = checksum(&buf);
        for i in 0..buf.len() {
            buf[i] ^= 0x01;
            assert_ne!(base, checksum(&buf), "flip at {i} did not change checksum");
            buf[i] ^= 0x01;
        }
    }

    #[test]
    fn log_stats_default_is_zero() {
        let s = LogStats::default();
        assert_eq!(s.total_records, 0);
        assert_eq!(s.total_bytes, 0);
    }

    #[test]
    fn log_stats_serde_roundtrips() {
        let s = LogStats {
            total_records: 42,
            total_bytes: 1024,
        };
        let j = serde_json::to_string(&s).unwrap();
        let back: LogStats = serde_json::from_str(&j).unwrap();
        assert_eq!(back.total_records, 42);
        assert_eq!(back.total_bytes, 1024);
    }

    #[test]
    fn log_record_session_and_event_id_accessors() {
        use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
        use quanta_proto::events::{BlockCreated, CwdSource, Event, InputKind};
        use quanta_proto::ids::BlockId;

        let sid = SessionId::new();
        let env = Envelope::new(
            sid,
            1,
            Producer::Block,
            SchemaVersion::ONE,
            Event::BlockCreated(BlockCreated {
                block_id: BlockId::new(),
                ordinal: 0,
                input_text: "x".into(),
                input_kind: InputKind::Shell,
                cwd: "/tmp".into(),
                cwd_source: CwdSource::Launch,
                is_compound: false,
            }),
        );
        let eid = env.event_id;
        let rec = LogRecord { envelope: env };
        assert_eq!(rec.session_id(), sid);
        assert_eq!(rec.event_id(), eid);
    }
}
