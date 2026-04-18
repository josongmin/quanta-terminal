//! Ports — the protocol adapter calls into these to satisfy control requests
//! and to pull events to broadcast.

use async_trait::async_trait;

use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::rpc::{RpcMethod, RpcResponse};

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("io: {0}")]
    Io(String),
    #[error("codec: {0}")]
    Codec(String),
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
}
