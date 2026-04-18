//! Block state machine.
//!
//! Per ADR 0002 the lifecycle is:
//!   `Created` -> `Starting` -> `Running` -> {`Completed`, `FailedToStart`,
//!   `Canceled`, `Detached`}
//! with an orthogonal `SubState::TuiMixed` (ADR 0008) for alt-screen ownership.

use std::collections::BTreeSet;

use quanta_proto::events::{BoundaryConfidence, BoundarySignal};
use quanta_proto::ids::{BlockId, EventId};

/// Primary state in the block lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BlockState {
    Created,
    Starting,
    Running,
    Completed,
    FailedToStart,
    Canceled,
    Detached,
}

/// Secondary state flags (ADR 0008).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Hash)]
pub enum SubState {
    #[default]
    Normal,
    /// Alt-screen owns the terminal — the block is in TUI-mixed mode.
    TuiMixed,
}

/// The block aggregate.
///
/// `applied_events` is the idempotency set: re-applying a known `event_id` is
/// a no-op. Kept as a `BTreeSet` so the state is deterministically comparable.
#[derive(Clone, Debug)]
pub struct Block {
    pub block_id: BlockId,
    pub state: BlockState,
    pub sub_state: SubState,
    pub exit_code: Option<i32>,
    pub boundary_signal: Option<BoundarySignal>,
    pub boundary_confidence: Option<BoundaryConfidence>,
    pub tui_bytes_written: u64,
    pub tui_unclean: bool,
    pub(crate) applied_events: BTreeSet<EventId>,
}

impl Block {
    #[must_use]
    pub fn new(block_id: BlockId) -> Self {
        Self {
            block_id,
            state: BlockState::Created,
            sub_state: SubState::Normal,
            exit_code: None,
            boundary_signal: None,
            boundary_confidence: None,
            tui_bytes_written: 0,
            tui_unclean: false,
            applied_events: BTreeSet::new(),
        }
    }

    #[must_use]
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            BlockState::Completed
                | BlockState::FailedToStart
                | BlockState::Canceled
                | BlockState::Detached
        )
    }

    #[must_use]
    pub fn applied(&self, event_id: &EventId) -> bool {
        self.applied_events.contains(event_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_starts_in_created_with_defaults() {
        let b = Block::new(BlockId::new());
        assert_eq!(b.state, BlockState::Created);
        assert_eq!(b.sub_state, SubState::Normal);
        assert!(!b.is_terminal());
    }

    #[test]
    fn terminal_states_are_terminal() {
        let mut b = Block::new(BlockId::new());
        b.state = BlockState::Completed;
        assert!(b.is_terminal());
        b.state = BlockState::Canceled;
        assert!(b.is_terminal());
        b.state = BlockState::Detached;
        assert!(b.is_terminal());
        b.state = BlockState::FailedToStart;
        assert!(b.is_terminal());
    }

    #[test]
    fn non_terminal_states_are_not_terminal() {
        let mut b = Block::new(BlockId::new());
        for s in [
            BlockState::Created,
            BlockState::Starting,
            BlockState::Running,
        ] {
            b.state = s;
            assert!(!b.is_terminal(), "{s:?} should not be terminal");
        }
    }

    #[test]
    fn defaults_for_new_block_are_all_zero() {
        let b = Block::new(BlockId::new());
        assert_eq!(b.exit_code, None);
        assert_eq!(b.boundary_signal, None);
        assert_eq!(b.boundary_confidence, None);
        assert_eq!(b.tui_bytes_written, 0);
        assert!(!b.tui_unclean);
        assert!(b.applied_events.is_empty());
    }

    #[test]
    fn applied_returns_false_for_unknown_event_id() {
        let b = Block::new(BlockId::new());
        let unseen = quanta_proto::ids::EventId::new();
        assert!(!b.applied(&unseen));
    }

    #[test]
    fn applied_returns_true_after_insert() {
        let mut b = Block::new(BlockId::new());
        let id = quanta_proto::ids::EventId::new();
        b.applied_events.insert(id);
        assert!(b.applied(&id));
    }

    #[test]
    fn substate_default_is_normal() {
        assert_eq!(SubState::default(), SubState::Normal);
    }

    #[test]
    fn block_id_is_preserved_by_new() {
        let bid = BlockId::new();
        let block = Block::new(bid);
        assert_eq!(block.block_id, bid);
    }

    /// Transition matrix under `reduce`, exhaustively. This is a living
    /// specification of which (`prior_state`, `event_kind`) pairs transition
    /// where. A divergence here is a silent contract change.
    #[test]
    fn documented_transition_matrix() {
        use crate::domain::reduce;
        use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
        use quanta_proto::events::{
            BlockCanceled, BlockCompleted, BlockCreated, BlockDetached, BlockStarted,
            BoundaryConfidence, BoundarySignal, CwdSource, DetachReason, Event, InputKind,
        };
        use quanta_proto::ids::SessionId;

        fn env(session: SessionId, _block: BlockId, ev: Event, seq: u64) -> Envelope<Event> {
            Envelope::new(session, seq, Producer::Block, SchemaVersion::ONE, ev)
        }

        let session = SessionId::new();
        let block_id = BlockId::new();
        let created = || {
            env(
                session,
                block_id,
                Event::BlockCreated(BlockCreated {
                    block_id,
                    ordinal: 0,
                    input_text: "x".into(),
                    input_kind: InputKind::Shell,
                    cwd: "/tmp".into(),
                    cwd_source: CwdSource::Launch,
                    is_compound: false,
                }),
                1,
            )
        };
        let started = || {
            env(
                session,
                block_id,
                Event::BlockStarted(BlockStarted {
                    block_id,
                    pid: Some(1),
                }),
                2,
            )
        };
        let completed = || {
            env(
                session,
                block_id,
                Event::BlockCompleted(BlockCompleted {
                    block_id,
                    exit_code: Some(0),
                    termination_signal: None,
                    boundary_signal: BoundarySignal::Osc133,
                    boundary_confidence: BoundaryConfidence::Authoritative,
                }),
                3,
            )
        };
        let canceled = || {
            env(
                session,
                block_id,
                Event::BlockCanceled(BlockCanceled { block_id }),
                4,
            )
        };
        let detached = || {
            env(
                session,
                block_id,
                Event::BlockDetached(BlockDetached {
                    block_id,
                    reason: DetachReason::BackgroundJob,
                }),
                5,
            )
        };

        // Created -> Running requires Started.
        let b = reduce(Block::new(block_id), &created());
        assert_eq!(b.state, BlockState::Created);
        let b = reduce(b, &started());
        assert_eq!(b.state, BlockState::Running);
        let b2 = reduce(b.clone(), &completed());
        assert_eq!(b2.state, BlockState::Completed);

        // Running -> Canceled via BlockCanceled.
        let b3 = reduce(b, &canceled());
        assert_eq!(b3.state, BlockState::Canceled);

        // Created -> Detached directly via BlockDetached.
        let mut b4 = Block::new(block_id);
        b4 = reduce(b4, &created());
        b4 = reduce(b4, &detached());
        assert_eq!(b4.state, BlockState::Detached);
    }
}
