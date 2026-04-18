//! `quanta-pty` — PTY domain and adapters.
//!
//! Per ADR 0014, this crate is split into:
//! - `domain/` — pure types (`PtySize`, `PtySpec`, exit status) with no IO.
//! - `ports/` — the `PtyPort` async trait the session actor calls.
//! - `adapters/` — the concrete `portable-pty` backend.

pub mod adapters;
pub mod domain;
pub mod ports;

pub use adapters::PortablePtyPort;
pub use domain::{PtyExit, PtySize, PtySpec};
pub use ports::{PtyError, PtyHandle, PtyPort};
