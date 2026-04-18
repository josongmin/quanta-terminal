//! Pure reducer for the block aggregate.
//!
//! Per ADR 0011, reducers are pure functions of `(prior, event)`. No IO, no
//! clock reads, no randomness. They are idempotent by `event_id`.

use quanta_proto::envelope::Envelope;
use quanta_proto::events::{BlockCompleted, Event};

use super::state::{Block, BlockState, SubState};

/// A projected block event the reducer understands.
///
/// The reducer speaks only in `Envelope<Event>`; this alias keeps the public
/// surface honest.
pub type BlockEvent = Envelope<Event>;

/// Apply a single envelope to a prior block. Returns the next state.
///
/// Unknown or unrelated events return the prior unchanged. Re-applying an
/// event with a previously-seen `event_id` is a no-op.
#[must_use]
pub fn reduce(mut prior: Block, event: &BlockEvent) -> Block {
    if prior.applied(&event.event_id) {
        return prior;
    }
    prior.applied_events.insert(event.event_id);

    match &event.payload {
        Event::BlockCreated(_) => {
            prior.state = BlockState::Created;
        }
        Event::BlockStarted(_) => {
            if matches!(prior.state, BlockState::Created | BlockState::Starting) {
                prior.state = BlockState::Running;
            }
        }
        Event::BlockCompleted(BlockCompleted {
            exit_code,
            boundary_signal,
            boundary_confidence,
            ..
        }) => {
            // Per ADR 0011 cross-event invariant: completed must not precede started.
            // If violated, leave prior state unchanged (return early without transitioning).
            if !matches!(prior.state, BlockState::Running) {
                // Fall through to still record confidence/signal but keep state.
                prior.boundary_signal = Some(*boundary_signal);
                prior.boundary_confidence = Some(*boundary_confidence);
                prior.exit_code = *exit_code;
                return prior;
            }
            prior.state = BlockState::Completed;
            prior.exit_code = *exit_code;
            prior.boundary_signal = Some(*boundary_signal);
            prior.boundary_confidence = Some(*boundary_confidence);
        }
        Event::BlockCanceled(_) => {
            if !prior.is_terminal() {
                prior.state = BlockState::Canceled;
            }
        }
        Event::BlockDetached(_) => {
            prior.state = BlockState::Detached;
        }
        Event::BlockTuiEntered(_) => {
            prior.sub_state = SubState::TuiMixed;
        }
        Event::BlockTuiExited(exited) => {
            prior.sub_state = SubState::Normal;
            prior.tui_bytes_written = prior.tui_bytes_written.saturating_add(exited.bytes_written);
            prior.tui_unclean = prior.tui_unclean || exited.unclean;
        }
        _ => {}
    }

    prior
}

/// Apply a sequence of events, returning the final state.
#[must_use]
pub fn reduce_many(prior: Block, events: &[BlockEvent]) -> Block {
    events.iter().fold(prior, reduce)
}

#[cfg(test)]
mod tests {
    use super::*;
    use quanta_proto::envelope::{Producer, SchemaVersion};
    use quanta_proto::events::{
        BlockCompleted, BlockCreated, BlockStarted, BlockTuiEntered, BlockTuiExited,
        BoundaryConfidence, BoundarySignal, CwdSource, InputKind,
    };
    use quanta_proto::ids::{BlockId, SessionId};

    fn env(session: SessionId, seq: u64, payload: Event) -> BlockEvent {
        Envelope::new(session, seq, Producer::Block, SchemaVersion::ONE, payload)
    }

    fn created_ev(session: SessionId, block: BlockId, seq: u64) -> BlockEvent {
        env(
            session,
            seq,
            Event::BlockCreated(BlockCreated {
                block_id: block,
                ordinal: 0,
                input_text: "echo hi".into(),
                input_kind: InputKind::Shell,
                cwd: "/tmp".into(),
                cwd_source: CwdSource::Launch,
                is_compound: false,
            }),
        )
    }

    fn started_ev(session: SessionId, block: BlockId, seq: u64) -> BlockEvent {
        env(
            session,
            seq,
            Event::BlockStarted(BlockStarted {
                block_id: block,
                pid: Some(1234),
            }),
        )
    }

    fn completed_ev(session: SessionId, block: BlockId, seq: u64, code: i32) -> BlockEvent {
        env(
            session,
            seq,
            Event::BlockCompleted(BlockCompleted {
                block_id: block,
                exit_code: Some(code),
                termination_signal: None,
                boundary_signal: BoundarySignal::Osc133,
                boundary_confidence: BoundaryConfidence::Authoritative,
            }),
        )
    }

    #[test]
    fn reduce_happy_path() {
        let session = SessionId::new();
        let block = BlockId::new();
        let b = Block::new(block);
        let events = vec![
            created_ev(session, block, 1),
            started_ev(session, block, 2),
            completed_ev(session, block, 3, 0),
        ];
        let out = reduce_many(b, &events);
        assert_eq!(out.state, BlockState::Completed);
        assert_eq!(out.exit_code, Some(0));
        assert_eq!(out.boundary_signal, Some(BoundarySignal::Osc133));
    }

    #[test]
    fn reduce_is_idempotent_by_event_id() {
        let session = SessionId::new();
        let block = BlockId::new();
        let b = Block::new(block);
        let ev = created_ev(session, block, 1);
        let once = reduce(b.clone(), &ev);
        let twice = reduce(once.clone(), &ev);
        assert_eq!(once.applied_events.len(), 1);
        assert_eq!(twice.applied_events.len(), 1);
        assert_eq!(once.state, twice.state);
    }

    #[test]
    fn completed_without_started_does_not_transition() {
        let session = SessionId::new();
        let block = BlockId::new();
        let b = Block::new(block);
        // Apply created then completed (skipping started).
        let out = reduce_many(
            b,
            &[
                created_ev(session, block, 1),
                completed_ev(session, block, 2, 0),
            ],
        );
        // State stays in Created because invariant fired.
        assert_eq!(out.state, BlockState::Created);
        // But the trailing metadata is captured.
        assert_eq!(out.exit_code, Some(0));
    }

    #[test]
    fn tui_enter_and_exit_toggle_sub_state() {
        let session = SessionId::new();
        let block = BlockId::new();
        let mut b = Block::new(block);
        b = reduce(b, &created_ev(session, block, 1));
        b = reduce(b, &started_ev(session, block, 2));
        b = reduce(
            b,
            &env(
                session,
                3,
                Event::BlockTuiEntered(BlockTuiEntered { block_id: block }),
            ),
        );
        assert_eq!(b.sub_state, SubState::TuiMixed);
        b = reduce(
            b,
            &env(
                session,
                4,
                Event::BlockTuiExited(BlockTuiExited {
                    block_id: block,
                    bytes_written: 1024,
                    unclean: false,
                }),
            ),
        );
        assert_eq!(b.sub_state, SubState::Normal);
        assert_eq!(b.tui_bytes_written, 1024);
    }
}
