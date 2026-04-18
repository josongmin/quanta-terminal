//! `quanta-diagnostic` — diagnostic parser pipeline (ADR 0007).
//!
//! Phase 3 ships the Tier-1 parsers per ADR 0007:
//!
//! - [`adapters::rustc`] — `rustc` / `cargo build` / `cargo test` output.
//! - [`adapters::tsc`] — TypeScript compiler `path(line,col): error TS…`.
//! - [`adapters::python_traceback`] — Python traceback with `File "…", line N`.
//! - [`adapters::node_stack`] — Node.js `at … (path:line:col)` stack frames.
//!
//! The [`pipeline::DiagnosticPipeline`] composes them. Callers feed chunks
//! of output text; the pipeline buffers partial lines, routes complete
//! lines to every registered parser, and ranks candidates into
//! [`domain::Diagnostic`] values via the cross-signal scorer.

pub mod adapters;
pub mod domain;
pub mod pipeline;
pub mod ports;

pub use domain::{Category, Diagnostic, ParserCandidate, Severity};
pub use pipeline::DiagnosticPipeline;
pub use ports::{CrossSignals, ParserAdapter, ParserError, ParserId};
