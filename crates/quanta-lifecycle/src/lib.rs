//! `quanta-lifecycle` — sidecar boot/handshake/heartbeat state + crash recovery.
//!
//! Per ADR 0004, the sidecar writes a shutdown marker on clean exit. Missing
//! marker on startup implies crash recovery: previously-live blocks must be
//! sealed into `detached` state before the event log replays to UIs.

pub mod adapters;
pub mod domain;
pub mod ports;

pub use adapters::FileMarker;
pub use domain::{HandshakeEvent, LifecycleEvent, LifecycleState, RecoveryOutcome};
pub use ports::{MarkerStore, MarkerStoreError};
