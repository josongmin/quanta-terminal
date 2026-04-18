//! Replay-determinism harness (ADR 0011 §Determinism).
//!
//! Property: for any fixed sequence of block events,
//!
//!   reduce_many(Block::new(id), events) ==
//!     reduce_many(Block::new(id), read_back(write_to_log(events)))
//!
//! This pins the "log → reducer → projection" pipeline: bytes that go in
//! come out the same bytes, the reducer is pure, and therefore replay is
//! byte-equal. The log adapter can only break this property by losing,
//! corrupting, or reordering records; the reducer can only break it by
//! reading external state.

use proptest::prelude::*;
use quanta_block::{reduce_many, Block};
use quanta_events::{EventLogReader as _, EventSink as _, ZstdSegmentedEventLog};
use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
use quanta_proto::events::{
    BlockCanceled, BlockCompleted, BlockCreated, BlockDetached, BlockStarted, BlockTuiEntered,
    BlockTuiExited, BoundaryConfidence, BoundarySignal, CwdSource, DetachReason, Event, InputKind,
};
use quanta_proto::ids::{BlockId, SessionId};

#[derive(Clone, Copy, Debug)]
enum K {
    Created,
    Started,
    Completed(i32),
    Canceled,
    Detached,
    TuiEntered,
    TuiExited(u64),
}

fn any_kind() -> impl Strategy<Value = K> {
    prop_oneof![
        Just(K::Created),
        Just(K::Started),
        proptest::num::i32::ANY.prop_map(K::Completed),
        Just(K::Canceled),
        Just(K::Detached),
        Just(K::TuiEntered),
        (0u64..4096).prop_map(K::TuiExited),
    ]
}

fn materialize(session: SessionId, block: BlockId, kinds: &[K]) -> Vec<Envelope<Event>> {
    kinds
        .iter()
        .enumerate()
        .map(|(i, k)| {
            let seq = (i as u64) + 1;
            let payload = match *k {
                K::Created => Event::BlockCreated(BlockCreated {
                    block_id: block,
                    ordinal: 0,
                    input_text: "p".into(),
                    input_kind: InputKind::Shell,
                    cwd: "/tmp".into(),
                    cwd_source: CwdSource::Launch,
                    is_compound: false,
                }),
                K::Started => Event::BlockStarted(BlockStarted {
                    block_id: block,
                    pid: Some(1),
                }),
                K::Completed(exit) => Event::BlockCompleted(BlockCompleted {
                    block_id: block,
                    exit_code: Some(exit),
                    termination_signal: None,
                    boundary_signal: BoundarySignal::Osc133,
                    boundary_confidence: BoundaryConfidence::Authoritative,
                }),
                K::Canceled => Event::BlockCanceled(BlockCanceled { block_id: block }),
                K::Detached => Event::BlockDetached(BlockDetached {
                    block_id: block,
                    reason: DetachReason::BackgroundJob,
                }),
                K::TuiEntered => Event::BlockTuiEntered(BlockTuiEntered { block_id: block }),
                K::TuiExited(bytes) => Event::BlockTuiExited(BlockTuiExited {
                    block_id: block,
                    bytes_written: bytes,
                    unclean: false,
                }),
            };
            Envelope::new(session, seq, Producer::Block, SchemaVersion::ONE, payload)
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
struct Projection {
    state: quanta_block::BlockState,
    sub_state: quanta_block::SubState,
    exit_code: Option<i32>,
    tui_bytes_written: u64,
    tui_unclean: bool,
}

fn project(block: &Block) -> Projection {
    Projection {
        state: block.state,
        sub_state: block.sub_state,
        exit_code: block.exit_code,
        tui_bytes_written: block.tui_bytes_written,
        tui_unclean: block.tui_unclean,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_deterministic_roundtrip() {
    // Bound the proptest manually because rstest/proptest async support is
    // cramped. We run 32 distinct random sequences, writing each to a log and
    // comparing the reducer's output on (live events) vs (replayed events).
    use proptest::strategy::ValueTree as _;
    let mut runner =
        proptest::test_runner::TestRunner::new(proptest::test_runner::Config::with_cases(32));
    let strategy = proptest::collection::vec(any_kind(), 0..12);

    for _ in 0..32 {
        let tree = strategy.new_tree(&mut runner).expect("new_tree");
        let kinds = tree.current();
        let tmp = tempfile::tempdir().unwrap();
        let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
        let session = SessionId::new();
        let block = BlockId::new();
        let events = materialize(session, block, &kinds);

        // Live path: reduce events directly.
        let live = reduce_many(Block::new(block), &events);

        // Log path: write every envelope, then read back and reduce.
        for ev in &events {
            log.append(ev.clone()).await.unwrap();
        }
        log.flush().await.unwrap();
        let records = log.replay_session(session).await.unwrap();
        let replayed_envs: Vec<Envelope<Event>> = records.into_iter().map(|r| r.envelope).collect();
        assert_eq!(
            replayed_envs.len(),
            events.len(),
            "roundtrip lost records for kinds={kinds:?}"
        );
        let replayed = reduce_many(Block::new(block), &replayed_envs);

        assert_eq!(
            project(&live),
            project(&replayed),
            "replay diverged for kinds={kinds:?}"
        );
    }
}

/// Byte-level roundtrip: the envelopes serialized going in must be byte-equal
/// to those serialized coming out. This is a stricter pin than the projection
/// equality above; it catches any shape-shifting inside the codec.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn envelopes_roundtrip_byte_equal_under_json() {
    let tmp = tempfile::tempdir().unwrap();
    let log = ZstdSegmentedEventLog::new(tmp.path()).unwrap();
    let session = SessionId::new();
    let block = BlockId::new();
    let events = materialize(
        session,
        block,
        &[
            K::Created,
            K::Started,
            K::Completed(7),
            K::TuiEntered,
            K::TuiExited(256),
        ],
    );
    let before: Vec<Vec<u8>> = events
        .iter()
        .map(|e| serde_json::to_vec(e).unwrap())
        .collect();

    for ev in &events {
        log.append(ev.clone()).await.unwrap();
    }
    log.flush().await.unwrap();

    let records = log.replay_session(session).await.unwrap();
    let after: Vec<Vec<u8>> = records
        .iter()
        .map(|r| serde_json::to_vec(&r.envelope).unwrap())
        .collect();

    assert_eq!(before.len(), after.len(), "record count changed");
    for (i, (b, a)) in before.iter().zip(after.iter()).enumerate() {
        assert_eq!(b, a, "envelope {i} changed across the log");
    }
}
