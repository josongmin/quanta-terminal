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
    /// Input-domain events originate from the shared composer surface, not the
    /// session actor itself. `Event::InputSubmitted` (prefix `input.*`) must
    /// carry `Producer::Input` so the envelope's `producer_id` agrees with the
    /// event-name prefix per ADR 0014.
    Input,
    Diagnostic,
    Suggestion,
    History,
    Security,
    Protocol,
    Lifecycle,
    /// Terminal-grid reducer events (VT engine / session fan-out). Owns the
    /// `grid.*` event family per EPIC-C and ADR 0017 §1.
    Grid,
}

/// Which terminal buffer an event applies to.
///
/// Mirrors the VT engine's `BufferKind` without a direct dependency on
/// `quanta-vt` (per ADR 0014's narrow domain deps rule). The wire is the
/// single source of truth for the string values; serde emits `"main"` /
/// `"alt"` in `snake_case`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BufferKind {
    /// Main screen buffer (with scrollback).
    #[default]
    Main,
    /// Alternate screen buffer (no scrollback).
    Alt,
}

/// The envelope common to every event.
///
/// The `payload` type parameter is the event's body. See the `events::Event` enum
/// for the typed payload union.
///
/// Schema-evolution note: additive / cross-cutting fields carry `#[serde(default)]`
/// so an older decoder can still ingest newer envelopes that gained
/// optional metadata.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope<P> {
    pub event_id: EventId,
    pub monotonic_seq: u64,
    pub session_id: SessionId,
    #[serde(default = "none_block")]
    pub block_id: Option<BlockId>,
    #[serde(with = "time::serde::rfc3339")]
    pub wall_clock_ts: OffsetDateTime,
    pub producer_id: Producer,
    pub schema_version: SchemaVersion,
    #[serde(default = "none_event")]
    pub causation_id: Option<EventId>,
    /// Grid-reducer epoch. Bumps on reconnect, full reseed, buffer init.
    /// UI mirror discards envelopes whose `grid_epoch < state.epoch` (ADR 0017 §2).
    ///
    /// The field is `#[serde(default, skip_serializing_if = "is_zero_u64")]` so
    /// non-grid events (where the value stays `0`) do not emit the key on the
    /// wire. Existing schema goldens are therefore unaffected; new grid
    /// envelopes that carry a non-zero tuple emit all three grid fields.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub grid_epoch: u64,
    /// Resize generation. Bumps on every VT resize altering wrap/reflow
    /// geometry. Stale-generation grid deltas are discarded (ADR 0017 §2).
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub resize_generation: u64,
    /// Active buffer at emit time (Main / Alt). Elided on the wire when
    /// equal to the default (`Main`) so non-grid goldens stay stable.
    #[serde(default, skip_serializing_if = "BufferKind::is_default")]
    pub buffer_kind: BufferKind,
    pub payload: P,
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero_u64(v: &u64) -> bool {
    // serde's `skip_serializing_if` hands a reference regardless of size;
    // keep the signature matching the expected fn pointer shape.
    *v == 0
}

impl BufferKind {
    /// Convenience for `#[serde(skip_serializing_if)]`.
    #[must_use]
    pub fn is_default(&self) -> bool {
        matches!(self, BufferKind::Main)
    }
}

fn none_block() -> Option<BlockId> {
    None
}

fn none_event() -> Option<EventId> {
    None
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
            grid_epoch: 0,
            resize_generation: 0,
            buffer_kind: BufferKind::Main,
            payload,
        }
    }

    /// Stamp the grid-reducer ordering tuple on this envelope. Used by the
    /// session actor (EPIC-F) when fanning out `Event::GridSnapshot` /
    /// `Event::GridDelta` / related variants. See ADR 0017 §1.
    #[must_use]
    pub fn with_grid_ordering(
        mut self,
        grid_epoch: u64,
        resize_generation: u64,
        buffer_kind: BufferKind,
    ) -> Self {
        self.grid_epoch = grid_epoch;
        self.resize_generation = resize_generation;
        self.buffer_kind = buffer_kind;
        self
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

    #[test]
    fn envelope_grid_ordering_defaults() {
        let env: Envelope<serde_json::Value> = Envelope::new(
            SessionId::new(),
            1,
            Producer::Grid,
            SchemaVersion::ONE,
            serde_json::json!({"kind": "bell_requested"}),
        );
        assert_eq!(env.grid_epoch, 0);
        assert_eq!(env.resize_generation, 0);
        assert_eq!(env.buffer_kind, BufferKind::Main);
    }

    #[test]
    fn envelope_with_grid_ordering_applies_tuple() {
        let env: Envelope<serde_json::Value> = Envelope::new(
            SessionId::new(),
            1,
            Producer::Grid,
            SchemaVersion::ONE,
            serde_json::json!({"kind": "bell_requested"}),
        )
        .with_grid_ordering(3, 5, BufferKind::Alt);
        assert_eq!(env.grid_epoch, 3);
        assert_eq!(env.resize_generation, 5);
        assert_eq!(env.buffer_kind, BufferKind::Alt);
    }

    /// Backward compat: a pre-EPIC-C envelope JSON missing the grid ordering
    /// fields still deserializes; defaults fill the gaps.
    #[test]
    fn envelope_deserialize_old_shape_fills_defaults() {
        let raw = serde_json::json!({
            "event_id": "01J0000000000000000000ABCD",
            "monotonic_seq": 7,
            "session_id": "01J0000000000000000000XYZZ",
            "block_id": null,
            "wall_clock_ts": "2026-04-19T10:00:00Z",
            "producer_id": "core",
            "schema_version": 1,
            "causation_id": null,
            "payload": {"legacy": true}
        });
        let env: Envelope<serde_json::Value> = serde_json::from_value(raw).unwrap();
        assert_eq!(env.grid_epoch, 0);
        assert_eq!(env.resize_generation, 0);
        assert_eq!(env.buffer_kind, BufferKind::Main);
    }
}
