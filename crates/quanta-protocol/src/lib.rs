//! `quanta-protocol` — control-plane + event-plane codecs and transports.
//!
//! - The control plane speaks JSON-RPC style over newline-delimited JSON.
//! - The event plane streams `Envelope<Event>` as `MessagePack` frames, each
//!   prefixed with a 4-byte big-endian length.
//!
//! The Unix-socket adapter in `adapters/` binds the two planes onto a single
//! listener: a client opens two sockets — one for control, one for events —
//! and the server handshake (ADR 0004) happens on the control socket.

pub mod adapters;
pub mod domain;
pub mod ports;

pub use adapters::{UnixSocketClient, UnixSocketServer};
pub use domain::{decode_control, decode_event, encode_control, encode_event, ControlMessage};
pub use ports::{ControlHandler, ProtocolError, ReplayError};
