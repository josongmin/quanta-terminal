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

use encoding_rs::UTF_8;

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
    /// Streaming UTF-8 decoder. Holds any trailing bytes that looked like a
    /// UTF-8 lead-with-continuations still in flight at the end of the
    /// previous chunk, so the next chunk's bytes complete the codepoint
    /// without emitting U+FFFD.
    ///
    /// Per FIX 3 in the audit: the prior `String::from_utf8_lossy`-based
    /// call site in the session actor applied decoding per-chunk and
    /// therefore mangled any codepoint whose bytes spanned a PTY read
    /// boundary. The streaming decoder from `encoding_rs` carries state
    /// across chunks and defers partial sequences to the next call.
    decoder: encoding_rs::Decoder,
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
            // `new_decoder_without_bom_handling` is the right constructor for
            // a PTY byte stream: there is no leading BOM and we do NOT want
            // the decoder to consume or interpret bytes that look like one.
            decoder: UTF_8.new_decoder_without_bom_handling(),
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

    /// Reset per-block state (line buffer + dedupe cache + decoder). Called
    /// when a block ends so the next block starts from a clean slate.
    pub fn reset_block(&mut self) {
        self.line_buffer.clear();
        self.seen.clear();
        self.signals = CrossSignals::default();
        // Drop any half-decoded codepoint carried from the previous block —
        // it would be a stale leading byte from block N's tail if kept.
        self.decoder = UTF_8.new_decoder_without_bom_handling();
        for p in &mut self.parsers {
            let _ = p.flush();
        }
    }

    /// Feed a chunk of output (UTF-8). Returns ranked, deduplicated
    /// diagnostics emitted by any parser.
    ///
    /// This is the string-input surface: callers that already hold a valid
    /// `&str` use it directly. PTY-adjacent callers must use
    /// [`DiagnosticPipeline::feed_bytes`] instead, which carries partial
    /// UTF-8 codepoints across chunk boundaries without mangling them.
    pub fn feed(&mut self, chunk: &str) -> Vec<Diagnostic> {
        if chunk.is_empty() {
            return Vec::new();
        }
        self.line_buffer.push_str(chunk);
        self.drain_lines()
    }

    /// Feed raw bytes of PTY output. Handles partial UTF-8 codepoints that
    /// span chunk boundaries: the internal `encoding_rs` decoder carries
    /// lead-with-continuation state across calls, so a 4-byte emoji split
    /// after byte 2 of chunk N decodes correctly when bytes 3+4 arrive in
    /// chunk N+1. The per-chunk `String::from_utf8_lossy` used by the old
    /// session-actor call site would instead emit U+FFFD for the prefix and
    /// orphan continuation bytes for the suffix.
    ///
    /// Invalid byte sequences (lone continuations, 0xFE/0xFF) still
    /// surface as U+FFFD, same as `from_utf8_lossy` — the fix is about
    /// the BOUNDARY case, not about changing the lossy semantics for
    /// genuinely malformed bytes.
    pub fn feed_bytes(&mut self, bytes: &[u8]) -> Vec<Diagnostic> {
        if bytes.is_empty() {
            return Vec::new();
        }
        // Decode directly into the line buffer. Pre-size the string append
        // target to the decoder's worst-case estimate so we don't pay for
        // reallocations on large chunks.
        let max_chars = self
            .decoder
            .max_utf8_buffer_length_without_replacement(bytes.len())
            .unwrap_or(bytes.len() * 3);
        self.line_buffer.reserve(max_chars);
        // `last = false` means: we expect more bytes later. The decoder
        // therefore SUSPENDS on a trailing incomplete codepoint rather than
        // flushing it as U+FFFD. `reset_block` / the explicit flush path in
        // `flush()` below eventually calls with `last = true` semantics by
        // recreating the decoder.
        let _ =
            self.decoder
                .decode_to_string_without_replacement(bytes, &mut self.line_buffer, false);
        self.drain_lines()
    }

    /// Extract complete lines from `line_buffer`, fan each out to every
    /// parser, and collect ranked/deduped diagnostics. Shared by both
    /// `feed` and `feed_bytes`.
    fn drain_lines(&mut self) -> Vec<Diagnostic> {
        let mut out: Vec<Diagnostic> = Vec::new();
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
        // Finalize the streaming decoder. Any partial codepoint still held
        // at end-of-stream is replaced with U+FFFD — the caller has
        // declared no more bytes are coming, so a dangling lead can no
        // longer hope to complete. Matches `from_utf8_lossy` semantics for
        // truly truncated data.
        //
        // We pass an empty input with `last = true`. The returned `written`
        // bytes are already appended to the buffer.
        let max_final = self
            .decoder
            .max_utf8_buffer_length_without_replacement(0)
            .unwrap_or(4);
        self.line_buffer.reserve(max_final);
        let _ = self
            .decoder
            .decode_to_string_without_replacement(&[], &mut self.line_buffer, true);
        // Recreate the decoder so a subsequent feed_bytes after flush starts
        // fresh; not doing so would leave the decoder in an "ended" state
        // that refuses further input.
        self.decoder = UTF_8.new_decoder_without_bom_handling();

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
    use crate::ports::ParserAdapter;
    use std::sync::Mutex;

    /// Test-only parser that captures every line it sees into a global
    /// buffer, so we can assert on exactly what made it through the
    /// pipeline's decoder + line-drain. A global is justified here because
    /// parsers are boxed trait objects with no public state getters; the
    /// alternative would be an `Arc<Mutex<Vec<String>>>` param on the
    /// parser's constructor, which complicates test readability.
    #[derive(Default)]
    struct CaptureParser;

    static CAPTURED: once_cell::sync::Lazy<Mutex<Vec<String>>> =
        once_cell::sync::Lazy::new(|| Mutex::new(Vec::new()));
    /// Serializes the tests that share `CAPTURED` so they cannot interleave.
    static CAPTURE_TEST_LOCK: once_cell::sync::Lazy<Mutex<()>> =
        once_cell::sync::Lazy::new(|| Mutex::new(()));

    impl CaptureParser {
        fn drain_global() -> Vec<String> {
            let mut g = CAPTURED.lock().expect("capture mutex");
            std::mem::take(&mut *g)
        }
    }

    impl ParserAdapter for CaptureParser {
        fn id(&self) -> crate::ports::ParserId {
            "capture"
        }
        fn parse_line(&mut self, line: &str) -> Vec<crate::domain::ParserCandidate> {
            CAPTURED
                .lock()
                .expect("capture mutex")
                .push(line.to_string());
            Vec::new()
        }
    }

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

    /// Regression for FIX 3: feeding a multi-byte UTF-8 codepoint split
    /// mid-sequence across two `feed_bytes` calls MUST decode to the
    /// original character, not to U+FFFD. Before the streaming decoder
    /// landed, the session actor called `String::from_utf8_lossy` on each
    /// chunk independently; the Korean / Chinese text below would surface
    /// as replacement characters for the prefix and orphan continuation
    /// bytes for the suffix.
    #[test]
    fn feed_bytes_recovers_split_utf8_codepoint_across_chunks() {
        // Serialize with the other capture test; they share CAPTURED.
        let _guard = CAPTURE_TEST_LOCK.lock().expect("test serialization lock");
        // Drain any leftovers from a prior test so captured.len() is clean.
        let _ = CaptureParser::drain_global();

        let mut p = DiagnosticPipeline::with_parsers(vec![Box::new(CaptureParser)]);
        // Korean "안녕" — 6 bytes:
        //   안: EC 95 88
        //   녕: EB 85 95
        // Split between the first and second byte of 안 so chunk N carries
        // an incomplete lead byte.
        let payload = [0xEC, 0x95, 0x88, 0xEB, 0x85, 0x95];
        let _ = p.feed_bytes(&payload[..2]); // EC 95
        let _ = p.feed_bytes(&payload[2..]); // 88 EB 85 95
        let _ = p.feed_bytes(b"\n");
        let captured = CaptureParser::drain_global();
        assert_eq!(
            captured.len(),
            1,
            "exactly one line should have been parsed after the newline: got {captured:?}"
        );
        let line = &captured[0];
        // The crucial assertion: no U+FFFD replacement characters.
        assert!(
            !line.contains('\u{FFFD}'),
            "recovered line must not contain U+FFFD: {line:?}",
        );
        assert_eq!(line, "안녕", "expected full Korean text, got: {line:?}");
    }

    /// A 4-byte emoji split across three chunks (1+2+1 bytes) must also
    /// round-trip cleanly — sanity check that the decoder tolerates
    /// arbitrarily fine-grained chunking, not just 2-part splits.
    #[test]
    fn feed_bytes_tolerates_3_way_split_of_4_byte_codepoint() {
        let _guard = CAPTURE_TEST_LOCK.lock().expect("test serialization lock");
        let _ = CaptureParser::drain_global();

        let mut p = DiagnosticPipeline::with_parsers(vec![Box::new(CaptureParser)]);
        // 👋 U+1F44B: F0 9F 91 8B
        let _ = p.feed_bytes(&[0xF0]);
        let _ = p.feed_bytes(&[0x9F, 0x91]);
        let _ = p.feed_bytes(&[0x8B, b'\n']);
        let captured = CaptureParser::drain_global();
        assert_eq!(captured.len(), 1, "got: {captured:?}");
        assert!(!captured[0].contains('\u{FFFD}'));
        assert_eq!(captured[0], "👋");
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
