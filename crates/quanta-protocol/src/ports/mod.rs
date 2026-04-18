//! Ports — the protocol adapter calls into these to satisfy control requests
//! and to pull events to broadcast.

use async_trait::async_trait;

use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::ids::SessionId;
use quanta_proto::rpc::{RpcMethod, RpcResponse};

/// Errors returned by a protocol adapter.
///
/// Variants split by source so handlers can differentiate a transient IO
/// blip from a contract breach (bad codec, failed handshake).
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    /// IO error from the underlying transport (socket, stdin/stdout pipe).
    #[error("io: {0}")]
    Io(String),
    /// Wire codec rejected a frame (malformed JSON, unexpected channel byte,
    /// etc.).
    #[error("codec: {0}")]
    Codec(String),
    /// The client-side handshake did not complete within policy (timeout,
    /// wrong first message, incompatible protocol version).
    #[error("handshake failed: {0}")]
    Handshake(String),
}

impl From<std::io::Error> for ProtocolError {
    fn from(e: std::io::Error) -> Self {
        ProtocolError::Io(e.to_string())
    }
}

/// A handler that services control-plane RPCs and publishes events.
///
/// Implementors wire this to the session actor registry. A single implementor
/// covers all RPC methods in `quanta_proto::rpc`.
#[async_trait]
pub trait ControlHandler: Send + Sync + std::fmt::Debug {
    /// Service one RPC. Must be idempotent by `request_id` per ADR 0011.
    async fn handle_rpc(
        &self,
        request_id: String,
        method: RpcMethod,
    ) -> RpcResponse<serde_json::Value>;

    /// Next event envelope ready to broadcast. `None` means the server may
    /// suspend momentarily — the adapter polls.
    async fn next_event(&self) -> Option<Envelope<Event>>;

    /// Replay events for `session_id` with `monotonic_seq > since_seq`.
    ///
    /// Per ADR 0011 §Resume Cursor, a reconnecting host sends resume cursors
    /// in its `Hello`; the protocol adapter calls this method for each cursor
    /// after sending `Ready` and streams the result over the event plane
    /// BEFORE starting the live broadcast pump. This plugs the
    /// disconnect/reconnect gap without losing durable events.
    ///
    /// The default implementation returns an empty vector — handlers without
    /// replay capability are free not to override. A non-empty override must
    /// return events in `monotonic_seq` order.
    async fn replay_since(&self, _session_id: SessionId, _since_seq: u64) -> Vec<Envelope<Event>> {
        Vec::new()
    }
}
