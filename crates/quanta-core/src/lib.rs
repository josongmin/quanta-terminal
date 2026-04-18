//! `quanta-core` — the composition root.
//!
//! Wires the adapters picked from config to the ports of every domain. Nothing
//! else in the workspace depends on this crate.

pub mod adapters;
pub mod domain;
pub mod ports;

pub use adapters::{ControlRegistry, Engine};
pub use domain::EngineConfig;
