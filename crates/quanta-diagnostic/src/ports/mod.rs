//! Ports — traits adapters implement.
//!
//! The `ParserAdapter` port is the contract that every tool-specific parser
//! (rustc, tsc, python_traceback, node_stack, ...) agrees to. Adapters live
//! under `crate::adapters::<parser_id>`.
//!
//! Per ADR 0007, parsers must handle cross-chunk state: a diagnostic body can
//! span several `feed` calls. The port therefore takes `&mut self` so each
//! adapter can hold an internal line buffer and emit only on line terminators.

use crate::domain::ParserCandidate;

/// Identifier for a parser adapter. Stable across releases; used for filtering,
/// metrics, and per-user disable lists.
pub type ParserId = &'static str;

/// A parser adapter consumes raw output and emits candidate diagnostics.
///
/// # Statefulness
///
/// `parse_line` takes `&mut self` so parsers can maintain a rolling line
/// buffer across feeds. The pipeline slices the stream into complete lines
/// before handing them to the adapter.
///
/// # Error handling
///
/// Parsers are lenient: unparseable input returns an empty candidate list,
/// not an error. The `ParserError` type exists for the rare infrastructure
/// failure (e.g. a regex build panic would be caught upstream).
pub trait ParserAdapter: Send + Sync {
    /// Stable parser id (e.g. `"rustc"`, `"tsc"`).
    fn id(&self) -> ParserId;

    /// Default precision prior reported to the ranker (0.0 — 1.0).
    ///
    /// Tier-1 parsers publish priors ≥ 0.9 so the scorer can distinguish a
    /// high-signal match (rustc `error[E…]:`) from a low-signal heuristic
    /// match (generic "Error: …" lines). See ADR 0007 §Confidence Scoring.
    fn precision_prior(&self) -> f32 {
        0.90
    }

    /// Feed one complete terminator-stripped line. Called once per `\n` that
    /// the pipeline observes. Adapters that recognize single-line matches
    /// emit immediately; adapters that need multi-line context accumulate
    /// state and emit when the diagnostic closes.
    fn parse_line(&mut self, line: &str) -> Vec<ParserCandidate>;

    /// Flush any buffered state. Called when a block ends or the stream goes
    /// idle. Adapters that accumulate multi-line diagnostics should emit
    /// anything still pending here.
    fn flush(&mut self) -> Vec<ParserCandidate> {
        Vec::new()
    }
}

/// Errors that can arise during parser pipeline execution.
#[derive(Debug, thiserror::Error)]
pub enum ParserError {
    /// The adapter returned an internal error (rare — parsers are expected to
    /// be lenient and emit an empty candidate list on unparseable input).
    #[error("parser {parser_id} internal error: {message}")]
    Internal { parser_id: String, message: String },
}

/// Cross-signal priors for the ranker. The pipeline accumulates these per
/// chunk; the scorer combines them with each candidate's parser prior to
/// arrive at a final `confidence`.
///
/// Kept in `ports` so adapters and the pipeline can agree on the shape
/// without either reaching into the other's private state.
#[derive(Clone, Copy, Debug, Default)]
pub struct CrossSignals {
    /// Most recent observed exit code, if any. `None` while the block is
    /// still running.
    pub exit_code: Option<i32>,
    /// Fraction of the currently-buffered chunk routed to stderr in `0.0 — 1.0`.
    /// Higher values bias toward "this block is failing" which raises
    /// confidence slightly.
    pub stderr_density: f32,
    /// Whether the parser's candidate path resolves inside the active
    /// workspace root. `None` when no workspace is configured.
    pub path_resolvable: Option<bool>,
}
