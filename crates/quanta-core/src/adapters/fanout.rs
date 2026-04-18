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
use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use tokio::sync::broadcast;

/// Capacity of the broadcast channel. Sized so that a short stall on the
/// socket consumer (e.g. a slow host read) does not affect the durable
/// append path. Messages beyond capacity are dropped for the subscriber —
/// the durable log still has them.
const BROADCAST_CAPACITY: usize = 1024;

pub struct FanoutSink {
    downstream: Arc<dyn EventSink>,
    tx: broadcast::Sender<Envelope<Event>>,
}

impl std::fmt::Debug for FanoutSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FanoutSink").finish_non_exhaustive()
    }
}

impl FanoutSink {
    /// Construct a fanout sink wrapping `downstream`. Returns the sink plus
    /// a ready-to-use broadcast receiver for the first subscriber.
    pub fn new(
        downstream: Arc<dyn EventSink>,
    ) -> (Arc<Self>, broadcast::Receiver<Envelope<Event>>) {
        let (tx, rx) = broadcast::channel(BROADCAST_CAPACITY);
        (Arc::new(Self { downstream, tx }), rx)
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
        // A send error means there are no subscribers. Fine during early
        // boot or a host disconnect; the durable log is still written. Log
        // at trace to keep signal low — an idle socket is the common case
        // and we never want the fanout to produce log storms.
        let session_id = envelope.session_id;
        let seq = envelope.monotonic_seq;
        if self.tx.send(envelope).is_err() {
            // `trace!` rather than `debug!`: per-envelope calls are in the
            // hot path and this state is "normal during disconnect".
            tracing::trace!(
                %session_id,
                seq,
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
