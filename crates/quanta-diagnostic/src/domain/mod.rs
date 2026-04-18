//! Domain types for the diagnostic pipeline.
//!
//! The domain carries value types only — no parser logic, no IO. Parser
//! adapters ingest raw output and emit `ParserCandidate`s; the pipeline
//! normalizes them into `Diagnostic`s for the rest of the system.

use std::path::PathBuf;

pub use quanta_proto::events::{DiagnosticCategory as Category, DiagnosticSeverity as Severity};

/// A normalized diagnostic as emitted by the pipeline to downstream consumers.
///
/// This mirrors the wire payload `DiagnosticDetected` from `quanta-proto`.
/// Keeping a domain-local copy lets the pipeline reason in terms of domain
/// values rather than wire payloads.
#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostic {
    pub parser_id: String,
    pub category: Category,
    pub severity: Severity,
    pub confidence: f32,
    pub message: String,
    pub path: Option<PathBuf>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub end_line: Option<u32>,
    pub end_column: Option<u32>,
    pub symbol: Option<String>,
}

/// A raw parser candidate before ranking. Confidence is not yet combined with
/// cross-signal priors.
#[derive(Clone, Debug, PartialEq)]
pub struct ParserCandidate {
    pub parser_id: String,
    pub category: Category,
    pub severity: Severity,
    pub confidence: f32,
    pub message: String,
    pub path: Option<PathBuf>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub end_line: Option<u32>,
    pub end_column: Option<u32>,
    pub symbol: Option<String>,
}

impl ParserCandidate {
    /// Promote a candidate to a `Diagnostic` once ranking is finalized.
    #[must_use]
    pub fn into_diagnostic(self) -> Diagnostic {
        Diagnostic {
            parser_id: self.parser_id,
            category: self.category,
            severity: self.severity,
            confidence: self.confidence,
            message: self.message,
            path: self.path,
            line: self.line,
            column: self.column,
            end_line: self.end_line,
            end_column: self.end_column,
            symbol: self.symbol,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_promotes_without_drift() {
        let c = ParserCandidate {
            parser_id: "rustc".into(),
            category: Category::Compiler,
            severity: Severity::Error,
            confidence: 0.91,
            message: "mismatched types".into(),
            path: Some(PathBuf::from("src/lib.rs")),
            line: Some(42),
            column: Some(8),
            end_line: Some(42),
            end_column: Some(19),
            symbol: Some("add".into()),
        };
        let d = c.clone().into_diagnostic();
        assert_eq!(d.parser_id, c.parser_id);
        assert_eq!(d.line, c.line);
        assert_eq!(d.symbol, c.symbol);
    }
}
