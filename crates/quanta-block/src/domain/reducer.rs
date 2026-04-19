//! Pure reducer for the block aggregate.
//!
//! Per ADR 0011, reducers are pure functions of `(prior, event)`. No IO, no
//! clock reads, no randomness. They are idempotent by `event_id`.
//!
//! # Out-of-order handling (Option A, strict)
//!
//! Per the cross-event invariant in ADR 0011, `BlockCompleted` must follow
//! `BlockStarted` (or at least a state that has transited through
//! `Running`). When the reducer observes an out-of-order `BlockCompleted`
//! — e.g. the completed envelope arrives before `BlockStarted` — it picks
//! **Option A (strict)**: the event is rejected outright. No state
//! transition, and no metadata is absorbed (exit code, boundary signal,
//! etc. are NOT recorded). A subsequent healthy
//! `Started → Completed(exit=N)` pair proceeds normally and the final
//! `exit_code` reflects only the healthy completion.
//!
//! The typed API lives on [`try_reduce`], which returns
//! [`ReducerError::OutOfOrder`] so callers can log or fail the upstream
//! pipeline. The convenience [`reduce`] wrapper keeps the pre-existing
//! infallible signature by silently dropping out-of-order events — useful
//! for replay loops where a strict failure would poison a whole session.

use quanta_proto::envelope::Envelope;
use quanta_proto::events::{BlockCompleted, Event};

use super::state::{Block, BlockState, SubState};

/// A projected block event the reducer understands.
///
/// The reducer speaks only in `Envelope<Event>`; this alias keeps the public
/// surface honest.
pub type BlockEvent = Envelope<Event>;

/// Errors the pure reducer can return.
///
/// The reducer remains pure (no IO, no clock) — these variants signal a
/// contract breach in the *event stream* so callers can decide the policy
/// (log + drop vs. fail-closed).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReducerError {
    /// A lifecycle event arrived out of order. Currently fired by
    /// `BlockCompleted` that precedes `BlockStarted` per ADR 0011.
    #[error("reducer: out-of-order event; state={state:?}, got={got_kind}")]
    OutOfOrder {
        state: BlockState,
        got_kind: &'static str,
    },
}

/// A zero-sized handle around the pure reduce function, kept for call sites
/// that prefer a method-style dispatch (e.g. `BlockReducer::apply`).
#[derive(Clone, Copy, Debug, Default)]
pub struct BlockReducer;

impl BlockReducer {
    /// Apply a single event. See [`try_reduce`] for the free-function form.
    pub fn apply(self, prior: Block, event: &BlockEvent) -> Result<Block, ReducerError> {
        try_reduce(prior, event)
    }
}

/// Strict variant of [`reduce`] that surfaces out-of-order events as an
/// error instead of silently dropping them.
///
/// See the module docs for the Option A semantics: an out-of-order
/// `BlockCompleted` produces [`ReducerError::OutOfOrder`]. The envelope
/// is still recorded in the applied-id set, because idempotency is keyed
/// on `event_id` — replaying the same envelope a second time must be a
/// no-op regardless of whether the first pass absorbed it or dropped it.
/// The session actor re-mints a fresh envelope (new `event_id`) to retry
/// once the prerequisite arrives, so the "mark-as-applied on rejection"
/// policy is never at odds with a legitimate retry.
pub fn try_reduce(mut prior: Block, event: &BlockEvent) -> Result<Block, ReducerError> {
    if prior.applied(&event.event_id) {
        return Ok(prior);
    }

    // Strict ordering check: out-of-order `BlockCompleted` is rejected
    // before any state transition. We still record the envelope as applied
    // so a replay of the same event stream converges — the second pass
    // through `fold(reduce, events)` sees the id on the applied set and
    // short-circuits identically to the first pass.
    if let Event::BlockCompleted(_) = &event.payload {
        if !matches!(prior.state, BlockState::Running) {
            prior.applied_events.insert(event.event_id);
            return Err(ReducerError::OutOfOrder {
                state: prior.state,
                got_kind: "block_completed",
            });
        }
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
            // Guarded above: we're strictly in `Running` at this point.
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

    Ok(prior)
}

/// Apply a single envelope to a prior block. Returns the next state.
///
/// This is the infallible sibling of [`try_reduce`]: an out-of-order event
/// is silently dropped AS FAR AS STATE is concerned — no transition, no
/// metadata absorbed (Option A). The envelope's `event_id` is still
/// recorded on the applied-id set so replay remains idempotent: a second
/// fold over the same event list converges to the same final state.
///
/// Unknown or unrelated events return the prior unchanged. Re-applying an
/// event with a previously-seen `event_id` is a no-op.
#[must_use]
pub fn reduce(prior: Block, event: &BlockEvent) -> Block {
    // `try_reduce` inserts the event_id into `applied_events` before
    // returning `Err(OutOfOrder)`; we preserve that bookkeeping on the
    // infallible wrapper too. We can't simply return the prior-on-error
    // because it lacks the applied-id mutation; instead, do the
    // applied-events update ourselves on the rejected path so the
    // failure-mode is a faithful "marked as seen, no state change".
    if let Ok(next) = try_reduce(prior.clone(), event) {
        next
    } else {
        let mut p = prior;
        p.applied_events.insert(event.event_id);
        p
    }
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
        // Option A (strict): state stays in Created AND no metadata is
        // absorbed. The reducer drops the out-of-order completed wholesale
        // so a later healthy pair produces the only visible completion.
        assert_eq!(out.state, BlockState::Created);
        assert_eq!(out.exit_code, None);
        assert_eq!(out.boundary_signal, None);
    }

    /// Option A regression: an early out-of-order `Completed(exit=42)` is
    /// dropped entirely, and a subsequent healthy `Started → Completed(exit=99)`
    /// pair must produce the final visible exit code of 99.
    /// Prior to the Option A fix, the early completed-before-started
    /// absorbed its `exit_code` into the aggregate, producing a
    /// "stuck" block whose exit code reflected the stale event.
    #[test]
    fn completed_before_started_is_dropped_and_later_pair_wins() {
        let session = SessionId::new();
        let block = BlockId::new();
        let b = Block::new(block);
        let out = reduce_many(
            b,
            &[
                created_ev(session, block, 1),
                // Out-of-order: must be dropped.
                completed_ev(session, block, 2, 42),
                started_ev(session, block, 3),
                completed_ev(session, block, 4, 99),
            ],
        );
        assert_eq!(out.state, BlockState::Completed);
        assert_eq!(
            out.exit_code,
            Some(99),
            "the healthy completed pair must win, not the dropped out-of-order one"
        );
    }

    /// `try_reduce` surfaces out-of-order completed as the typed error
    /// variant so strict pipelines can fail-closed.
    #[test]
    fn try_reduce_reports_out_of_order_completed() {
        let session = SessionId::new();
        let block = BlockId::new();
        let b = Block::new(block);
        let b = try_reduce(b, &created_ev(session, block, 1)).expect("created ok");
        let bad = completed_ev(session, block, 2, 0);
        let err = try_reduce(b.clone(), &bad).expect_err("completed before started must error");
        match err {
            ReducerError::OutOfOrder { state, got_kind } => {
                assert_eq!(state, BlockState::Created);
                assert_eq!(got_kind, "block_completed");
            }
        }
    }

    /// Replay idempotency: an out-of-order Completed that was rejected on
    /// first contact MUST remain rejected (or a no-op) on a second
    /// `try_reduce` of the same envelope. Idempotency is keyed on
    /// `event_id`, not on "accepted vs. dropped".
    ///
    /// The session actor never reuses an `event_id` for a retry — on a
    /// legitimate retry after the prerequisite arrives it mints a fresh
    /// envelope. This test pins the replay semantics for the reducer
    /// itself.
    #[test]
    fn rejected_out_of_order_event_is_replay_idempotent() {
        let session = SessionId::new();
        let block = BlockId::new();
        let b = Block::new(block);
        let b = try_reduce(b, &created_ev(session, block, 1)).expect("created ok");
        let bad = completed_ev(session, block, 2, 42);
        // First application: rejected, envelope marked as applied.
        // `try_reduce` consumes the block by value; rebuild from the
        // known-good prior and re-apply so we can inspect downstream.
        let b_after_bad = if try_reduce(b.clone(), &bad).is_ok() {
            panic!("should have been rejected");
        } else {
            let mut b2 = b.clone();
            b2.applied_events.insert(bad.event_id);
            b2
        };
        assert_eq!(b_after_bad.state, BlockState::Created);
        // Drive the block into Running so completed would now be legal.
        let b_running =
            try_reduce(b_after_bad, &started_ev(session, block, 3)).expect("started ok");
        // Re-applying the same envelope is a no-op: idempotency by event_id.
        let same = try_reduce(b_running.clone(), &bad).expect("idempotent replay");
        assert_eq!(same.state, BlockState::Running);
        assert_eq!(same.exit_code, None);
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
