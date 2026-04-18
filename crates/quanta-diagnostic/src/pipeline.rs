//! `DiagnosticPipeline` — composes Tier-1 parser adapters.
//!
//! The pipeline owns a fleet of [`ParserAdapter`]s. Callers feed raw output
//! chunks (UTF-8 `&str`); the pipeline buffers partial lines until it sees a
//! newline, then fans each complete line out to every adapter. Adapter
//! candidates are ranked via [`rank`] and returned as [`Diagnostic`]s.
//!
//! Scoring (ADR 0007 §Confidence Scoring):
//!
//! - Start from the adapter's `precision_prior`.
//! - Add a small bump if the chunk was mostly stderr.
//! - Add a small bump for a non-zero exit code.
//! - Add a bump if the workspace says the path resolves.
//! - Cap at `0.99` (never claim certainty).
//!
//! The pipeline is synchronous and fast: all adapters are regex-based and
//! stateless relative to each other. Future work may push scoring into a
//! worker pool if an adapter grows expensive; today it runs in-line on the
//! caller's thread. The session actor calls this on the PTY reader task.

use std::collections::HashSet;

use crate::adapters::{NodeStackParser, PythonTracebackParser, RustcParser, TscParser};
use crate::domain::{Diagnostic, ParserCandidate};
use crate::ports::{CrossSignals, ParserAdapter, ParserId};

/// The diagnostic pipeline.
pub struct DiagnosticPipeline {
    parsers: Vec<Box<dyn ParserAdapter>>,
    /// Remainder of an input chunk that didn't end on a `\n`. The next feed
    /// prepends this before line-splitting, so a diagnostic whose header
    /// arrives in chunk N-1 and whose span arrives in chunk N is parsed
    /// correctly.
    line_buffer: String,
    signals: CrossSignals,
    /// Track emitted (parser_id, path, line, column, message) tuples for the
    /// current block so the same diagnostic isn't surfaced twice when cargo
    /// reprints it in a summary. Reset on [`DiagnosticPipeline::reset_block`].
    seen: HashSet<SeenKey>,
}

impl std::fmt::Debug for DiagnosticPipeline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DiagnosticPipeline")
            .field("parser_count", &self.parsers.len())
            .field("buffered_bytes", &self.line_buffer.len())
            .field("signals", &self.signals)
            .field("seen", &self.seen.len())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct SeenKey {
    parser_id: String,
    path: Option<std::path::PathBuf>,
    line: Option<u32>,
    column: Option<u32>,
    message: String,
}

impl Default for DiagnosticPipeline {
    fn default() -> Self {
        Self::new()
    }
}

impl DiagnosticPipeline {
    /// Create a new pipeline populated with every Tier-1 parser.
    pub fn new() -> Self {
        Self::with_parsers(vec![
            Box::new(RustcParser::new()),
            Box::new(TscParser::new()),
            Box::new(PythonTracebackParser::new()),
            Box::new(NodeStackParser::new()),
        ])
    }

    /// Explicit-parsers ctor — used by tests to feed a single adapter.
    pub fn with_parsers(parsers: Vec<Box<dyn ParserAdapter>>) -> Self {
        Self {
            parsers,
            line_buffer: String::new(),
            signals: CrossSignals::default(),
            seen: HashSet::new(),
        }
    }

    /// Ids of the parsers currently wired into the pipeline.
    pub fn parser_ids(&self) -> Vec<ParserId> {
        self.parsers.iter().map(|p| p.id()).collect()
    }

    /// Update the cross-signal priors the scorer uses. The session actor
    /// updates these as it observes exit codes and stream mixes.
    pub fn set_signals(&mut self, signals: CrossSignals) {
        self.signals = signals;
    }

    /// Reset per-block state (line buffer + dedupe cache). Called when a
    /// block ends so the next block starts from a clean slate.
    pub fn reset_block(&mut self) {
        self.line_buffer.clear();
        self.seen.clear();
        self.signals = CrossSignals::default();
        for p in &mut self.parsers {
            let _ = p.flush();
        }
    }

    /// Feed a chunk of output (UTF-8). Returns ranked, deduplicated
    /// diagnostics emitted by any parser.
    ///
    /// Partial codepoints across chunk boundaries are the caller's problem;
    /// the session actor uses `String::from_utf8_lossy` to guarantee this
    /// input is valid UTF-8.
    pub fn feed(&mut self, chunk: &str) -> Vec<Diagnostic> {
        if chunk.is_empty() {
            return Vec::new();
        }
        self.line_buffer.push_str(chunk);
        let mut out: Vec<Diagnostic> = Vec::new();
        // Drain complete lines. Use a loop so we can split off substrings
        // while respecting the remainder for the next call.
        loop {
            let Some(newline_idx) = self.line_buffer.find('\n') else {
                break;
            };
            let line: String = self.line_buffer.drain(..=newline_idx).collect();
            let line_trimmed = line.trim_end_matches(['\n', '\r']);
            for parser in &mut self.parsers {
                let cands = parser.parse_line(line_trimmed);
                for c in cands {
                    if let Some(d) = rank_and_dedupe(c, &self.signals, &mut self.seen) {
                        out.push(d);
                    }
                }
            }
        }
        out
    }

    /// Flush any buffered state. Parsers that hold in-flight multi-line
    /// diagnostics (e.g. the rustc adapter holding a header without its
    /// span) can emit here.
    ///
    /// Returning zero diagnostics is the common case: most Tier-1 parsers
    /// only emit on a terminator they already saw.
    pub fn flush(&mut self) -> Vec<Diagnostic> {
        // If the buffer has a trailing incomplete line, feed it as-is so a
        // final `tsc` line without a `\n` still parses.
        let tail = std::mem::take(&mut self.line_buffer);
        let mut out = Vec::new();
        if !tail.is_empty() {
            for parser in &mut self.parsers {
                for c in parser.parse_line(tail.trim_end_matches(['\n', '\r'])) {
                    if let Some(d) = rank_and_dedupe(c, &self.signals, &mut self.seen) {
                        out.push(d);
                    }
                }
            }
        }
        for parser in &mut self.parsers {
            for c in parser.flush() {
                if let Some(d) = rank_and_dedupe(c, &self.signals, &mut self.seen) {
                    out.push(d);
                }
            }
        }
        out
    }
}

/// Combine the parser's prior with cross-signal bumps, then stamp the final
/// `confidence`. Returns `None` if we've already emitted this diagnostic in
/// the current block (per `seen`).
fn rank_and_dedupe(
    mut candidate: ParserCandidate,
    signals: &CrossSignals,
    seen: &mut HashSet<SeenKey>,
) -> Option<Diagnostic> {
    let mut score = candidate.confidence;
    if let Some(code) = signals.exit_code {
        if code != 0 {
            score += 0.02;
        } else {
            // A successful exit + a diagnostic emission is suspicious —
            // downrank slightly. Keeps cargo's "warning:" in a passing build
            // visible but dims it.
            score -= 0.05;
        }
    }
    if signals.stderr_density > 0.5 {
        score += 0.02;
    }
    match signals.path_resolvable {
        Some(true) => score += 0.03,
        Some(false) => score -= 0.05,
        None => {}
    }
    // Clamp. Never claim absolute certainty; never go below zero.
    score = score.clamp(0.0, 0.99);
    candidate.confidence = score;

    let key = SeenKey {
        parser_id: candidate.parser_id.clone(),
        path: candidate.path.clone(),
        line: candidate.line,
        column: candidate.column,
        message: candidate.message.clone(),
    };
    if !seen.insert(key) {
        return None;
    }
    Some(candidate.into_diagnostic())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Severity;

    #[test]
    fn default_ctor_registers_all_tier1_parsers() {
        let p = DiagnosticPipeline::new();
        let ids = p.parser_ids();
        assert!(ids.contains(&"rustc"));
        assert!(ids.contains(&"tsc"));
        assert!(ids.contains(&"python_traceback"));
        assert!(ids.contains(&"node_stack"));
    }

    #[test]
    fn rustc_diagnostic_flows_end_to_end() {
        let mut p = DiagnosticPipeline::new();
        let diags =
            p.feed("error[E0425]: cannot find value `foo` in this scope\n --> src/main.rs:3:5\n");
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].severity, Severity::Error);
        assert_eq!(diags[0].line, Some(3));
        assert!(diags[0].confidence >= 0.9);
    }

    #[test]
    fn partial_chunks_rejoin() {
        let mut p = DiagnosticPipeline::new();
        let a = p.feed("error[E0425]: cannot find value");
        assert!(a.is_empty());
        let b = p.feed(" `foo` in this scope\n --> src/main.rs:3:5\n");
        assert_eq!(b.len(), 1);
    }

    #[test]
    fn dedupe_within_block() {
        let mut p = DiagnosticPipeline::new();
        let text = "error[E0425]: cannot find value `foo`\n --> src/main.rs:3:5\n";
        let mut all = p.feed(text);
        all.extend(p.feed(text));
        // Second feed is a duplicate; should not be re-emitted.
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn reset_block_clears_dedupe() {
        let mut p = DiagnosticPipeline::new();
        let text = "error[E0425]: cannot find value `foo`\n --> src/main.rs:3:5\n";
        let first = p.feed(text);
        assert_eq!(first.len(), 1);
        p.reset_block();
        let second = p.feed(text);
        assert_eq!(second.len(), 1);
    }

    #[test]
    fn exit_code_signal_raises_confidence() {
        let mut p = DiagnosticPipeline::new();
        p.set_signals(CrossSignals {
            exit_code: Some(1),
            stderr_density: 0.9,
            path_resolvable: Some(true),
        });
        let diags = p.feed("error[E0425]: cannot find value `foo`\n --> src/main.rs:3:5\n");
        assert_eq!(diags.len(), 1);
        // rustc prior is 0.95; + 0.02 + 0.02 + 0.03 = 1.02 clamped to 0.99.
        assert!(diags[0].confidence >= 0.98);
    }

    /// `reset_block` must clear the incomplete-line buffer so a partial line
    /// belonging to block N cannot be joined with the first bytes of block
    /// N+1 and misparsed. The session actor calls `reset_block()` on every
    /// block transition; this test guards the invariant at the domain level
    /// so a future refactor that accidentally drops the `line_buffer.clear()`
    /// from `reset_block` is caught by the diagnostic crate itself.
    #[test]
    fn reset_block_clears_partial_line_buffer() {
        let mut p = DiagnosticPipeline::new();
        // Block N: feed a diagnostic header with no newline. The pipeline
        // buffers it waiting for a terminator.
        let first = p.feed("error[E0425]: cannot find value `foo` in this scope");
        assert!(
            first.is_empty(),
            "no newline yet — must not emit a diagnostic"
        );
        // Boundary: simulate block close.
        p.reset_block();
        // Block N+1: feed the exact bytes that WOULD complete the prior
        // diagnostic if the buffer had not been cleared. Correct behaviour
        // is zero diagnostics: the leading space + newline is just a
        // stray blank line for the new block.
        let second = p.feed("\n --> src/main.rs:3:5\n");
        assert!(
            second.is_empty(),
            "reset_block must have cleared the header; got {} diagnostics",
            second.len(),
        );
    }
}
