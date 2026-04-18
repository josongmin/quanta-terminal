//! Tier-1 parser adapters (ADR 0007).
//!
//! Each adapter owns one file so the regex catalogue is easy to grep. Shared
//! helpers (ANSI stripping, path cleaning) live in [`common`].

pub mod common;
pub mod node_stack;
pub mod python_traceback;
pub mod rustc;
pub mod tsc;

pub use node_stack::NodeStackParser;
pub use python_traceback::PythonTracebackParser;
pub use rustc::RustcParser;
pub use tsc::TscParser;
