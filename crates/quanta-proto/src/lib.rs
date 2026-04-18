//! Quanta Terminal — shared schema types and protocol versioning.
//!
//! This crate is the single source of truth for:
//! - event types that flow from the Rust core to host/UI
//! - RPC control-plane messages
//! - schema versioning per event type
//! - shared domain IDs used across crates
//!
//! Per [ADR 0014], this crate has no `ports/` or `adapters/` — it is pure schema.
//! Per [ADR 0011], every event carries an envelope with `event_id`, `monotonic_seq`,
//! `schema_version`, and `producer_id`.

pub mod envelope;
pub mod events;
pub mod ids;
pub mod protocol;
pub mod rpc;
pub mod version;

pub use envelope::{Envelope, Producer, SchemaVersion};
pub use events::Event;
pub use ids::{BlockId, DiagnosticId, EventId, SessionId, SpanId, SuggestionId, WorkspaceId};
pub use protocol::{Hello, Incompatible, ProtocolVersion, Ready};
pub use rpc::{RpcError, RpcRequest, RpcResponse, RpcResult};
