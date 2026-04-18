//! `quanta-output` — output span storage domain.
//!
//! An "output span" is a contiguous slice of bytes from a PTY attached to a block.
//! The domain tracks byte offsets per block so downstream indexing (search,
//! diagnostic parsing) can refer to stable byte ranges.

pub mod adapters;
pub mod domain;
pub mod ports;

pub use domain::{AppendOutcome, OutputSpan, OutputStore};
