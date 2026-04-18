//! Event envelope — the fields every event carries regardless of its payload.
//!
//! Per [ADR 0011]:
//! - `event_id` is generated at the core before write and is the dedupe key.
//! - `monotonic_seq` is strict per session; gaps are corruption.
//! - `schema_version` is per-event-type.
//! - `producer_id` names the subsystem that originated the event.
//! - `causation_id` (optional) points at the event that caused this one.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::ids::{BlockId, EventId, SessionId};
pub use crate::version::SchemaVersion;

/// Which subsystem produced an event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Producer {
    Core,
    Pty,
    Session,
    Block,
    Output,
    Diagnostic,
    Suggestion,
    History,
    Security,
    Protocol,
    Lifecycle,
}

/// The envelope common to every event.
///
/// The `payload` type parameter is the event's body. See the `events::Event` enum
/// for the typed payload union.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope<P> {
    pub event_id: EventId,
    pub monotonic_seq: u64,
    pub session_id: SessionId,
    pub block_id: Option<BlockId>,
    #[serde(with = "time::serde::rfc3339")]
    pub wall_clock_ts: OffsetDateTime,
    pub producer_id: Producer,
    pub schema_version: SchemaVersion,
    pub causation_id: Option<EventId>,
    pub payload: P,
}

impl<P> Envelope<P> {
    /// Build an envelope with the payload and an auto-generated `event_id` and
    /// current wall clock. `monotonic_seq` must be assigned by the caller (the
    /// session actor is the authority).
    pub fn new(
        session_id: SessionId,
        monotonic_seq: u64,
        producer_id: Producer,
        schema_version: SchemaVersion,
        payload: P,
    ) -> Self {
        Self {
            event_id: EventId::new(),
            monotonic_seq,
            session_id,
            block_id: None,
            wall_clock_ts: OffsetDateTime::now_utc(),
            producer_id,
            schema_version,
            causation_id: None,
            payload,
        }
    }

    #[must_use]
    pub fn with_block(mut self, block: BlockId) -> Self {
        self.block_id = Some(block);
        self
    }

    #[must_use]
    pub fn with_causation(mut self, causing: EventId) -> Self {
        self.causation_id = Some(causing);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_json_roundtrip() {
        let env: Envelope<serde_json::Value> = Envelope::new(
            SessionId::new(),
            1,
            Producer::Session,
            SchemaVersion::ONE,
            serde_json::json!({"kind": "test"}),
        );
        let s = serde_json::to_string(&env).unwrap();
        let back: Envelope<serde_json::Value> = serde_json::from_str(&s).unwrap();
        assert_eq!(env.event_id, back.event_id);
        assert_eq!(env.monotonic_seq, back.monotonic_seq);
    }
}
