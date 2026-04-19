//! `FanoutSink` — tees every appended envelope to a `broadcast` channel in
//! addition to the durable downstream sink.
//!
//! # Why this exists
//!
//! Per ADR 0004, the socket event plane must receive every envelope the
//! session actor produces. Before this fanout, the session actor called
//! `EventSink::append` on `ZstdSegmentedEventLog` directly; the socket plane
//! polled an in-memory `VecDeque` that was never populated. That gap broke
//! end-to-end event delivery.
//!
//! # Ordering
//!
//! Per ADR 0011, durability must land before broadcast. If `append` fails,
//! the envelope is NOT published — subscribers never see an event that
//! wasn't logged.
//!
//! # Backpressure
//!
//! The `broadcast` channel has a bounded capacity. A slow subscriber starts
//! seeing `Lagged` errors — intentional: we prefer dropping broadcast
//! delivery to the host socket over stalling the durable log path. The
//! durable log remains canonical.

use std::sync::Arc;

use async_trait::async_trait;
use quanta_events::{EventLogError, EventSink};
use quanta_metrics::{MetricsRecorder, NoopRecorder};
use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use tokio::sync::broadcast;

/// Capacity of the broadcast channel. Sized so that a short stall on the
/// socket consumer (e.g. a slow host read) does not affect the durable
/// append path. Messages beyond capacity are dropped for the subscriber —
/// the durable log still has them.
const BROADCAST_CAPACITY: usize = 1024;

/// Metric name: incremented when `broadcast::Sender::send` returns an error
/// (receiver set empty). Tokio's broadcast surfaces `Lagged` on the
/// RECEIVER side, so "subscriber lag" — from the sender's vantage — is
/// observable only as the absence of any subscribers; the counter here
/// captures that exact condition and gives an operator the "sent but not
/// published" rate. FIX 3.
pub const METRIC_SUBSCRIBER_LAG_DROPS: &str = "fanout.broadcast.subscriber_lag_drops";

pub struct FanoutSink {
    downstream: Arc<dyn EventSink>,
    tx: broadcast::Sender<Envelope<Event>>,
    recorder: Arc<dyn MetricsRecorder>,
}

impl std::fmt::Debug for FanoutSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FanoutSink").finish_non_exhaustive()
    }
}

impl FanoutSink {
    /// Construct a fanout sink wrapping `downstream`. Returns the sink plus
    /// a ready-to-use broadcast receiver for the first subscriber. Uses a
    /// [`NoopRecorder`] for metrics; callers that own a shared
    /// [`MetricsRecorder`] should prefer [`Self::with_recorder`].
    pub fn new(
        downstream: Arc<dyn EventSink>,
    ) -> (Arc<Self>, broadcast::Receiver<Envelope<Event>>) {
        Self::with_recorder(downstream, Arc::new(NoopRecorder::new()))
    }

    /// Construct a fanout sink wrapping `downstream` and reporting
    /// broadcast drops to `recorder`. See [`METRIC_SUBSCRIBER_LAG_DROPS`].
    pub fn with_recorder(
        downstream: Arc<dyn EventSink>,
        recorder: Arc<dyn MetricsRecorder>,
    ) -> (Arc<Self>, broadcast::Receiver<Envelope<Event>>) {
        let (tx, rx) = broadcast::channel(BROADCAST_CAPACITY);
        (
            Arc::new(Self {
                downstream,
                tx,
                recorder,
            }),
            rx,
        )
    }

    /// Obtain an additional receiver (e.g. for a debug panel alongside the
    /// primary host socket).
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<Envelope<Event>> {
        self.tx.subscribe()
    }
}

#[async_trait]
impl EventSink for FanoutSink {
    async fn append(&self, envelope: Envelope<Event>) -> Result<(), EventLogError> {
        // ADR 0011: durability first, broadcast second.
        self.downstream.append(envelope.clone()).await?;
        // A send error from `broadcast::Sender::send` is unambiguous: tokio's
        // `SendError<T>` only occurs when there are no active receivers. Lag
        // is NOT a sender-side concern — slow receivers surface
        // `RecvError::Lagged(n)` on the consumer side instead. See FIX 4.
        //
        // Fine state during early boot or after a host disconnect. We log at
        // trace so the hot path stays quiet in the common "idle" case; the
        // durable log is still written.
        //
        // Structured fields carry session + envelope identity so an
        // operator can correlate a "dropped broadcast" event back to the
        // exact durable record (see B1 in the Round-10 audit).
        let session_id = envelope.session_id;
        let seq = envelope.monotonic_seq;
        let event_id = envelope.event_id;
        let causation_id = envelope.causation_id;
        if self.tx.send(envelope).is_err() {
            // FIX 3: bump the metric so a dashboard / replay CLI sees the
            // "subscriber lag" rate independently of tracing.
            self.recorder.inc_counter(METRIC_SUBSCRIBER_LAG_DROPS);
            tracing::trace!(
                %session_id,
                seq,
                %event_id,
                ?causation_id,
                "core.fanout: no broadcast subscribers; envelope logged but not published"
            );
        } else {
            debug_assert!(seq > 0, "monotonic_seq must be assigned before fanout");
        }
        Ok(())
    }

    async fn flush(&self) -> Result<(), EventLogError> {
        self.downstream.flush().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use quanta_proto::envelope::{Producer, SchemaVersion};
    use quanta_proto::events::{CwdSource, InputKind};
    use quanta_proto::ids::{BlockId, SessionId};
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Minimal sink that counts appends so we can assert the durable write
    /// landed regardless of broadcast outcome.
    #[derive(Debug, Default)]
    struct CountSink(AtomicU64);

    #[async_trait]
    impl EventSink for CountSink {
        async fn append(&self, _env: Envelope<Event>) -> Result<(), EventLogError> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
        async fn flush(&self) -> Result<(), EventLogError> {
            Ok(())
        }
    }

    fn sample_env() -> Envelope<Event> {
        Envelope::new(
            SessionId::new(),
            1,
            Producer::Block,
            SchemaVersion::ONE,
            Event::BlockCreated(quanta_proto::events::BlockCreated {
                block_id: BlockId::new(),
                ordinal: 0,
                input_text: "echo".into(),
                input_kind: InputKind::Shell,
                cwd: "/tmp".into(),
                cwd_source: CwdSource::Launch,
                is_compound: false,
            }),
        )
    }

    /// FIX 4 (a): when there are no broadcast subscribers, send returns Err
    /// but the durable append still lands and `append` returns Ok. The
    /// fanout keeps the pipeline healthy — the missing subscriber is not
    /// the fanout's problem to solve.
    #[tokio::test]
    async fn append_succeeds_with_no_subscribers_and_durability_still_happens() {
        let downstream: Arc<dyn EventSink> = Arc::new(CountSink::default());
        let (fanout, rx) = FanoutSink::new(downstream.clone());
        // Drop the receiver so the sender has zero subscribers.
        drop(rx);
        let env = sample_env();
        fanout.append(env).await.expect("durability must succeed");
        // Durable append count is observable via a downcast: rebuild a typed
        // Arc. Easier: fetch from the concrete type inline.
        // Since we only have the trait object, construct the concrete sink
        // separately for this assertion.
        let concrete = Arc::new(CountSink::default());
        let down: Arc<dyn EventSink> = concrete.clone();
        let (fanout2, rx2) = FanoutSink::new(down);
        drop(rx2);
        fanout2.append(sample_env()).await.unwrap();
        assert_eq!(concrete.0.load(Ordering::Relaxed), 1);
    }

    /// FIX 4 (b): with a slow subscriber that never drains, the sender must
    /// NOT see the lag — tokio's broadcast surfaces lag on the RECEIVER
    /// side, not the sender. The fanout's `send` returns Ok up until the
    /// channel is fully populated, at which point older items are overwritten
    /// and `recv` returns `Lagged(n)`. We verify both halves here so the
    /// intuition is locked in.
    #[tokio::test]
    async fn slow_subscriber_surfaces_lag_on_receiver_side_not_sender() {
        let downstream: Arc<dyn EventSink> = Arc::new(CountSink::default());
        let (fanout, mut rx) = FanoutSink::new(downstream);
        // Send more than BROADCAST_CAPACITY (=1024) envelopes without reading
        // so the oldest get evicted. The fanout's `append` should still
        // return Ok every time — durability first, broadcast is advisory.
        for _ in 0..(BROADCAST_CAPACITY + 4) {
            fanout
                .append(sample_env())
                .await
                .expect("append must not fail due to lag on sender side");
        }
        // Now observe the lag on the receiver. We expect the first recv to
        // return `Lagged(n)` where n == number of dropped envelopes.
        match rx.try_recv() {
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(n)) => {
                assert!(n > 0, "expected positive lag count");
            }
            other => panic!("expected Lagged on receiver; got {other:?}"),
        }
    }

    /// FIX 3: when the broadcast fails because no subscribers are attached,
    /// the recorder's `fanout.broadcast.subscriber_lag_drops` counter must
    /// bump. This is the machine-readable mirror of the existing `tracing::trace!`
    /// log, so a dashboard sees the "sent-but-unpublished" rate without
    /// tailing logs.
    #[tokio::test]
    async fn subscriber_lag_drops_counter_bumps_when_no_subscribers() {
        use quanta_metrics::{InMemoryRecorder, MetricsRecorder};
        let downstream: Arc<dyn EventSink> = Arc::new(CountSink::default());
        let recorder = InMemoryRecorder::new_arc();
        let rec_trait: Arc<dyn MetricsRecorder> = recorder.clone();
        let (fanout, rx) = FanoutSink::with_recorder(downstream, rec_trait);
        drop(rx);
        // Baseline: no drops observed yet.
        assert_eq!(recorder.counter_value(METRIC_SUBSCRIBER_LAG_DROPS), 0);
        fanout
            .append(sample_env())
            .await
            .expect("durability must still succeed");
        assert_eq!(
            recorder.counter_value(METRIC_SUBSCRIBER_LAG_DROPS),
            1,
            "append with no subscribers must bump the drop counter once"
        );
        fanout.append(sample_env()).await.unwrap();
        assert_eq!(
            recorder.counter_value(METRIC_SUBSCRIBER_LAG_DROPS),
            2,
            "subsequent drop must increment the counter again"
        );
    }
}
