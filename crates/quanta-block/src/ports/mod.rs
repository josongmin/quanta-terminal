//! Ports — abstractions the block domain depends on but does not implement.
//!
//! Adapters under [`crate::adapters`] supply concrete implementations.

mod boundary;

pub use boundary::BoundaryDetector;
