//! Ports — traits adapters implement.
//!
//! The `ParserAdapter` port is the contract that every tool-specific parser
//! (rustc, tsc, python_traceback, node_stack, ...) agrees to. Adapters live
//! under `crate::adapters::<parser_id>`.

use crate::domain::ParserCandidate;

/// Identifier for a parser adapter. Stable across releases; used for filtering,
/// metrics, and per-user disable lists.
pub type ParserId = &'static str;

/// A parser adapter consumes raw output bytes and emits candidate diagnostics.
///
/// Phase 1 defines the port; adapters land in later phases per ADR 0007.
pub trait ParserAdapter: Send + Sync {
    /// Stable parser id (e.g. `"rustc"`, `"tsc"`).
    fn id(&self) -> ParserId;

    /// Parse a chunk of output and return any candidates the adapter recognizes.
    /// Implementations must be stateless across calls; the pipeline orchestrates
    /// buffering when a diagnostic spans multiple chunks.
    fn parse(&self, input: &str) -> Vec<ParserCandidate>;
}

/// Errors that can arise during parser pipeline execution.
#[derive(Debug, thiserror::Error)]
pub enum ParserError {
    /// The adapter returned an internal error (rare — parsers are expected to
    /// be lenient and emit an empty candidate list on unparseable input).
    #[error("parser {parser_id} internal error: {message}")]
    Internal { parser_id: String, message: String },
}
