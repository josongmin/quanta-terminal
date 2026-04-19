//! Block domain — aggregate, state machine, and pure boundary-event types.
//!
//! The reducer is pure. It consumes `(prior, event) -> (next, derived)`.
//! Idempotent via an applied-id set kept on the aggregate.
//!
//! The concrete `vte`-backed boundary parser lives in `crate::adapters::boundary`
//! and implements the port in `crate::ports::BoundaryDetector`. Domain here
//! deals only with the event values and the sink trait.

mod boundary;
mod reducer;
mod state;

pub use boundary::{BoundaryEvent, BoundarySink};
pub use reducer::{reduce, reduce_many, try_reduce, BlockEvent, BlockReducer, ReducerError};
pub use state::{Block, BlockState, SubState};
