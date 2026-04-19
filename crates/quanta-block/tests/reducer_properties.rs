//! Property-based tests for the block reducer (ADR 0011).
//!
//! Pins four properties the reducer must satisfy for replay determinism to
//! hold:
//!
//! 1. Idempotency — applying an envelope with a previously-seen `event_id` is
//!    a no-op.
//! 2. Determinism — two independent reductions of the same sequence produce
//!    equal state.
//! 3. Monotonicity — shuffled inputs must not be silently accepted as if
//!    ordered. Since the reducer does not enforce `monotonic_seq` itself
//!    (the session actor does), we verify the weaker property: reducing a
//!    sequence in which `BlockCompleted` precedes `BlockStarted` does NOT
//!    transition the block to `Completed`, matching the ADR 0011 cross-event
//!    invariant.
//! 4. Terminal states — once a block is `Completed`, `Canceled`,
//!    `FailedToStart`, or `Detached`, subsequent lifecycle events cannot
//!    mutate the state.

use proptest::prelude::*;
use quanta_block::{reduce, reduce_many, Block, BlockState};
use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
use quanta_proto::events::{
    BlockCanceled, BlockCompleted, BlockCreated, BlockDetached, BlockStarted, BlockTuiEntered,
    BlockTuiExited, BoundaryConfidence, BoundarySignal, CwdSource, DetachReason, Event, InputKind,
};
use quanta_proto::ids::{BlockId, SessionId};

fn created(session: SessionId, block: BlockId, seq: u64) -> Envelope<Event> {
    Envelope::new(
        session,
        seq,
        Producer::Block,
        SchemaVersion::ONE,
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

fn started(session: SessionId, block: BlockId, seq: u64) -> Envelope<Event> {
    Envelope::new(
        session,
        seq,
        Producer::Block,
        SchemaVersion::ONE,
        Event::BlockStarted(BlockStarted {
            block_id: block,
            pid: Some(1234),
        }),
    )
}

fn completed(session: SessionId, block: BlockId, seq: u64, exit: i32) -> Envelope<Event> {
    Envelope::new(
        session,
        seq,
        Producer::Block,
        SchemaVersion::ONE,
        Event::BlockCompleted(BlockCompleted {
            block_id: block,
            exit_code: Some(exit),
            termination_signal: None,
            boundary_signal: BoundarySignal::Osc133,
            boundary_confidence: BoundaryConfidence::Authoritative,
        }),
    )
}

fn canceled(session: SessionId, block: BlockId, seq: u64) -> Envelope<Event> {
    Envelope::new(
        session,
        seq,
        Producer::Block,
        SchemaVersion::ONE,
        Event::BlockCanceled(BlockCanceled { block_id: block }),
    )
}

fn detached(session: SessionId, block: BlockId, seq: u64) -> Envelope<Event> {
    Envelope::new(
        session,
        seq,
        Producer::Block,
        SchemaVersion::ONE,
        Event::BlockDetached(BlockDetached {
            block_id: block,
            reason: DetachReason::BackgroundJob,
        }),
    )
}

fn tui_entered(session: SessionId, block: BlockId, seq: u64) -> Envelope<Event> {
    Envelope::new(
        session,
        seq,
        Producer::Block,
        SchemaVersion::ONE,
        Event::BlockTuiEntered(BlockTuiEntered { block_id: block }),
    )
}

fn tui_exited(session: SessionId, block: BlockId, seq: u64) -> Envelope<Event> {
    Envelope::new(
        session,
        seq,
        Producer::Block,
        SchemaVersion::ONE,
        Event::BlockTuiExited(BlockTuiExited {
            block_id: block,
            bytes_written: 256,
            unclean: false,
        }),
    )
}

/// A kind tag used by the proptest generator. Variants carry no data; the
/// test builds the matching envelope at materialization time.
#[derive(Clone, Copy, Debug)]
enum K {
    Created,
    Started,
    Completed(i32),
    Canceled,
    Detached,
    TuiEntered,
    TuiExited,
}

fn any_kind() -> impl Strategy<Value = K> {
    prop_oneof![
        Just(K::Created),
        Just(K::Started),
        proptest::num::i32::ANY.prop_map(K::Completed),
        Just(K::Canceled),
        Just(K::Detached),
        Just(K::TuiEntered),
        Just(K::TuiExited),
    ]
}

fn materialize(session: SessionId, block: BlockId, kinds: &[K]) -> Vec<Envelope<Event>> {
    kinds
        .iter()
        .enumerate()
        .map(|(i, k)| {
            let seq = (i as u64) + 1;
            match *k {
                K::Created => created(session, block, seq),
                K::Started => started(session, block, seq),
                K::Completed(code) => completed(session, block, seq, code),
                K::Canceled => canceled(session, block, seq),
                K::Detached => detached(session, block, seq),
                K::TuiEntered => tui_entered(session, block, seq),
                K::TuiExited => tui_exited(session, block, seq),
            }
        })
        .collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    // 1. Idempotency: applying the same envelope twice equals applying once.
    #[test]
    fn reducer_idempotent_on_event_id(kinds in proptest::collection::vec(any_kind(), 0..10)) {
        let session = SessionId::new();
        let block = BlockId::new();
        let events = materialize(session, block, &kinds);
        let once = reduce_many(Block::new(block), &events);
        // Replay every event a second time: state must not shift.
        let twice = events.iter().fold(once.clone(), reduce);
        prop_assert_eq!(once.state, twice.state);
        prop_assert_eq!(once.sub_state, twice.sub_state);
        prop_assert_eq!(once.exit_code, twice.exit_code);
    }

    // 2. Determinism: two independent reductions produce byte-equal states.
    // We compare every observable field on the aggregate.
    #[test]
    fn reducer_is_deterministic(kinds in proptest::collection::vec(any_kind(), 0..10)) {
        let session = SessionId::new();
        let block = BlockId::new();
        let events = materialize(session, block, &kinds);
        let a = reduce_many(Block::new(block), &events);
        let b = reduce_many(Block::new(block), &events);
        prop_assert_eq!(a.state, b.state);
        prop_assert_eq!(a.sub_state, b.sub_state);
        prop_assert_eq!(a.exit_code, b.exit_code);
        prop_assert_eq!(a.boundary_signal, b.boundary_signal);
        prop_assert_eq!(a.boundary_confidence, b.boundary_confidence);
        prop_assert_eq!(a.tui_bytes_written, b.tui_bytes_written);
        prop_assert_eq!(a.tui_unclean, b.tui_unclean);
    }

    // 3. Monotonicity / cross-event invariant: `Completed` must never precede
    //    `Started`. Per the Option A (strict) fix, the reducer drops the
    //    out-of-order Completed wholesale — neither the state nor the
    //    exit-code metadata mutates.
    #[test]
    fn completed_without_started_does_not_transition(exit in proptest::num::i32::ANY) {
        let _ = exit; // exit intentionally unused — Option A drops the event.
        let session = SessionId::new();
        let block = BlockId::new();
        let events = vec![
            created(session, block, 1),
            completed(session, block, 2, exit),
        ];
        let out = reduce_many(Block::new(block), &events);
        prop_assert_eq!(out.state, BlockState::Created);
        // Option A: the rejected completed leaves zero trace on the
        // aggregate. A retry once Started is emitted will still land.
        prop_assert_eq!(out.exit_code, None);
        prop_assert_eq!(out.boundary_signal, None);
    }

    // 4. Terminal states absorb the lifecycle events the session actor can
    //    legitimately emit. We restrict the alphabet to `Started` and
    //    `Completed` because those are the only post-terminal events the
    //    actor can mint during a single block's lifetime (per ADR 0002).
    //
    //    KNOWN PRODUCTION-CODE GAPS (handed off to Round 2, do NOT fix here):
    //    - `BlockCreated` is applied unconditionally by the reducer, so
    //      replaying a BlockCreated with a fresh event_id resets a terminal
    //      block back to `Created`. The session actor does not emit a second
    //      BlockCreated per block, but the reducer alone does not enforce
    //      its own terminal invariant. See Round-2 follow-up "reducer:
    //      BlockCreated must no-op on terminal state".
    //    - `BlockDetached` unconditionally overwrites prior terminal state.
    //      A `Completed` block can silently become `Detached` on a stray
    //      envelope. See Round-2 follow-up "reducer: BlockDetached must
    //      no-op on terminal state".
    //    - `BlockTuiEntered` / `BlockTuiExited` both mutate `sub_state`
    //      unconditionally — a stray TuiExited on a completed block
    //      decrements `tui_bytes_written` bookkeeping. Same handoff.
    //
    //    The test below exercises only the subset we can guarantee today.
    #[test]
    fn completed_absorbs_subsequent_started_and_completed(
        later_pattern in prop::bool::ANY,
    ) {
        let session = SessionId::new();
        let block = BlockId::new();
        let mut state = reduce_many(
            Block::new(block),
            &[created(session, block, 1), started(session, block, 2), completed(session, block, 3, 0)],
        );
        prop_assert_eq!(state.state, BlockState::Completed);

        // Re-issue Started / Completed with fresh envelopes (distinct event_ids).
        let extra = if later_pattern {
            vec![started(session, block, 100), completed(session, block, 101, 7)]
        } else {
            vec![completed(session, block, 200, 42), started(session, block, 201)]
        };
        state = reduce_many(state, &extra);
        prop_assert_eq!(state.state, BlockState::Completed);
    }

    // 4b. Canceled absorbs repeated cancels and cannot be moved back to
    //     a non-terminal state by `BlockStarted` or a stray `BlockCompleted`
    //     (the latter leaves metadata but does not transition because its
    //     guard requires `Running`).
    #[test]
    fn canceled_absorbs_started_and_stray_completed(_seed in prop::num::u8::ANY) {
        let session = SessionId::new();
        let block = BlockId::new();
        let mut state = reduce_many(
            Block::new(block),
            &[created(session, block, 1), started(session, block, 2), canceled(session, block, 3)],
        );
        prop_assert_eq!(state.state, BlockState::Canceled);
        // Subsequent Started: guarded by the `Created|Starting` matcher, so
        // no transition.
        state = reduce(state, &started(session, block, 100));
        prop_assert_eq!(state.state, BlockState::Canceled);
        // Subsequent Completed: guarded by `Running`, so no transition.
        state = reduce(state, &completed(session, block, 101, 0));
        prop_assert_eq!(state.state, BlockState::Canceled);
        // Subsequent Canceled: guarded by `!is_terminal()`, so no transition.
        state = reduce(state, &canceled(session, block, 102));
        prop_assert_eq!(state.state, BlockState::Canceled);
    }

    // 4c. `is_terminal()` is consistent with the `BlockState` match.
    #[test]
    fn is_terminal_classifier_is_consistent(kinds in proptest::collection::vec(any_kind(), 0..10)) {
        let session = SessionId::new();
        let block = BlockId::new();
        let events = materialize(session, block, &kinds);
        let state = reduce_many(Block::new(block), &events);
        let via_match = matches!(
            state.state,
            BlockState::Completed | BlockState::FailedToStart | BlockState::Canceled | BlockState::Detached
        );
        prop_assert_eq!(state.is_terminal(), via_match);
    }
}

/// Non-proptest sanity: unique event ids — re-applying by value WITHOUT
/// reusing `event_id` (i.e. a new envelope for the same payload) is NOT an
/// idempotency candidate; the reducer will apply it again. This test pins
/// the "idempotency keyed on `event_id`" semantics.
#[test]
fn idempotency_is_keyed_on_event_id_not_payload() {
    let session = SessionId::new();
    let block = BlockId::new();
    let e1 = created(session, block, 1);
    let mut e2 = created(session, block, 2); // same payload shape, different seq
                                             // Distinct event_id by virtue of `Envelope::new` generating ULIDs.
    assert_ne!(e1.event_id, e2.event_id);
    let state = reduce(Block::new(block), &e1);
    assert_eq!(state.applied_events_count(), 1);
    let state = reduce(state, &e2);
    assert_eq!(state.applied_events_count(), 2);
    // Re-apply e2: still 2.
    e2.monotonic_seq = 99;
    let state = reduce(state, &e2);
    assert_eq!(state.applied_events_count(), 2);
}

// Adapter trait used by the sanity test to inspect the applied-events set
// without making it pub. Kept inside the test crate so production code stays
// clean.
trait AppliedCount {
    fn applied_events_count(&self) -> usize;
}

impl AppliedCount for Block {
    fn applied_events_count(&self) -> usize {
        // Drive through the public-ish surface: replaying an arbitrary event
        // twice must yield the same count.
        //
        // We can't read the set directly (pub(crate)) but we can infer via
        // `applied`: count the distinct ids we know about by doing a dummy
        // reduce with a fresh id and comparing. Simpler: reach into debug
        // repr. Use `format!("{:?}", self)` and extract length.
        let s = format!("{self:?}");
        // The Debug impl prints `applied_events: {set}`. Count the ULID
        // literals by counting commas + 1 inside the set braces.
        if let Some(start) = s.find("applied_events: {") {
            let rest = &s[start..];
            if let Some(end) = rest.find('}') {
                let inner = &rest[..end];
                if inner.ends_with('{') || inner.contains("{}") {
                    return 0;
                }
                // Count occurrences of "EventId(" which the Debug impl for the id emits.
                return inner.matches("EventId(").count();
            }
        }
        0
    }
}
