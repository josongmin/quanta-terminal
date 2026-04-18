//! `quanta-block` — block aggregate, state machine, boundary detection.
//!
//! Per ADR 0002, the block boundary contract is:
//! - OSC 133 `A`/`B`/`C`/`D` markers are authoritative.
//! - Child process exit is authoritative for direct spawns.
//! - Prompt regex is a fallback with degraded confidence.
//!
//! Per ADR 0008, `?1049h`/`?1049l` (plus the `?1047` and `?47` legacy variants)
//! enter and exit `tui_mixed` sub-state inside an existing block.
//!
//! Per ADR 0014, `vte` (infrastructure) is confined to `adapters::`. Domain
//! deals only with event values, the sink trait, and the reducer.

pub mod adapters;
pub mod domain;
pub mod ports;

pub use adapters::VteBoundaryDetector;
pub use domain::{
    reduce, reduce_many, Block, BlockEvent, BlockState, BoundaryEvent, BoundarySink, SubState,
};
pub use ports::BoundaryDetector;
