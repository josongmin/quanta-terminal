//! Fixture-corpus test for Tier-1 parsers (ADR 0007 §Fixture Corpus).
//!
//! Walks `crates/quanta-diagnostic/fixtures/<parser_id>/<case>/` and, for each
//! case, feeds `input.txt` through a single-parser [`DiagnosticPipeline`] then
//! asserts the emitted diagnostics match `expected.json` (subset fields).
//!
//! Accuracy contract (per parser, over its own corpus):
//!
//! - Precision ≥ 0.97 (Tier-1): emitted-and-expected / emitted ≥ 0.97.
//! - Recall    ≥ 0.85 (Tier-1): emitted-and-expected / expected ≥ 0.85.
//!
//! The test also prints a per-parser summary that the hand-in report quotes.

use std::fs;
use std::path::{Path, PathBuf};

use quanta_diagnostic::adapters::{NodeStackParser, PythonTracebackParser, RustcParser, TscParser};
use quanta_diagnostic::{DiagnosticPipeline, ParserAdapter};
use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq)]
struct ExpectedDiagnostic {
    parser_id: String,
    category: String,
    severity: String,
    message: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    column: Option<u32>,
    #[serde(default)]
    symbol: Option<String>,
}

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

fn build_pipeline(parser_id: &str) -> DiagnosticPipeline {
    let parser: Box<dyn ParserAdapter> = match parser_id {
        "rustc" => Box::new(RustcParser::new()),
        "tsc" => Box::new(TscParser::new()),
        "python_traceback" => Box::new(PythonTracebackParser::new()),
        "node_stack" => Box::new(NodeStackParser::new()),
        other => panic!("unknown parser id: {other}"),
    };
    DiagnosticPipeline::with_parsers(vec![parser])
}

fn load_cases(parser_dir: &Path) -> Vec<PathBuf> {
    let mut cases: Vec<PathBuf> = fs::read_dir(parser_dir)
        .expect("read parser dir")
        .filter_map(std::result::Result::ok)
        .filter(|e| e.file_type().map(|f| f.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    cases.sort();
    cases
}

fn compact_category(cat: quanta_proto::events::DiagnosticCategory) -> &'static str {
    use quanta_proto::events::DiagnosticCategory as C;
    match cat {
        C::Compiler => "compiler",
        C::Linter => "linter",
        C::Runtime => "runtime",
        C::Test => "test",
        C::Infra => "infra",
        C::Shell => "shell",
        C::Unknown => "unknown",
    }
}

fn compact_severity(sev: quanta_proto::events::DiagnosticSeverity) -> &'static str {
    use quanta_proto::events::DiagnosticSeverity as S;
    match sev {
        S::Error => "error",
        S::Warning => "warning",
        S::Info => "info",
    }
}

/// Accuracy summary across a parser's corpus.
#[derive(Default, Debug)]
struct Accuracy {
    /// Cases where the parser matched the expected set exactly (in order).
    perfect_cases: usize,
    /// Total candidate emissions across all cases.
    emitted: usize,
    /// Total expected diagnostics across all cases.
    expected: usize,
    /// Number of (parser_emit, expected) pairs that matched in the same
    /// position within a case. Used for precision/recall.
    matched: usize,
    /// Per-case failures for human debugging.
    failures: Vec<String>,
}

impl Accuracy {
    fn precision(&self) -> f32 {
        if self.emitted == 0 {
            1.0
        } else {
            self.matched as f32 / self.emitted as f32
        }
    }
    fn recall(&self) -> f32 {
        if self.expected == 0 {
            1.0
        } else {
            self.matched as f32 / self.expected as f32
        }
    }
}

fn run_case(case_dir: &Path, parser_id: &str, acc: &mut Accuracy) {
    let name = case_dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let input = fs::read_to_string(case_dir.join("input.txt"))
        .unwrap_or_else(|_| panic!("read input.txt for {name}"));
    let expected_raw = fs::read_to_string(case_dir.join("expected.json"))
        .unwrap_or_else(|_| panic!("read expected.json for {name}"));
    let expected: Vec<ExpectedDiagnostic> = serde_json::from_str(&expected_raw)
        .unwrap_or_else(|e| panic!("parse expected.json for {name}: {e}"));

    let mut pipeline = build_pipeline(parser_id);
    // Feed as one big chunk plus a trailing newline to be safe.
    let mut diags = pipeline.feed(&input);
    if !input.ends_with('\n') {
        diags.extend(pipeline.feed("\n"));
    }
    diags.extend(pipeline.flush());

    acc.emitted += diags.len();
    acc.expected += expected.len();

    // Order-preserving pairwise comparison.
    let mut perfect = diags.len() == expected.len();
    for (i, exp) in expected.iter().enumerate() {
        let Some(got) = diags.get(i) else {
            perfect = false;
            acc.failures
                .push(format!("{name}: missing emission at index {i}"));
            break;
        };
        let got_path = got.path.as_ref().map(|p| p.to_string_lossy().to_string());
        let got_cat = compact_category(got.category).to_string();
        let got_sev = compact_severity(got.severity).to_string();
        let fields_match = got.parser_id == exp.parser_id
            && got_cat == exp.category
            && got_sev == exp.severity
            && got.message == exp.message
            && got_path == exp.path
            && got.line == exp.line
            && got.column == exp.column
            && got.symbol == exp.symbol;
        if fields_match {
            acc.matched += 1;
        } else {
            perfect = false;
            acc.failures.push(format!(
                "{name}: mismatch at index {i}\n  got:      {:?}\n  expected: {:?}",
                (
                    &got.parser_id,
                    &got_cat,
                    &got_sev,
                    &got.message,
                    &got_path,
                    &got.line,
                    &got.column,
                    &got.symbol
                ),
                (
                    &exp.parser_id,
                    &exp.category,
                    &exp.severity,
                    &exp.message,
                    &exp.path,
                    &exp.line,
                    &exp.column,
                    &exp.symbol
                ),
            ));
        }
    }
    if diags.len() > expected.len() {
        perfect = false;
        for extra in diags.iter().skip(expected.len()) {
            acc.failures
                .push(format!("{name}: unexpected extra emission: {extra:?}"));
        }
    }
    if perfect {
        acc.perfect_cases += 1;
    }
}

fn run_parser_corpus(parser_id: &str, min_cases: usize) -> Accuracy {
    let parser_dir = fixtures_root().join(parser_id);
    let cases = load_cases(&parser_dir);
    assert!(
        cases.len() >= min_cases,
        "{parser_id} corpus must have >= {min_cases} cases, got {}",
        cases.len()
    );
    let mut acc = Accuracy::default();
    for case in &cases {
        run_case(case, parser_id, &mut acc);
    }
    eprintln!(
        "[{parser_id}] cases={} perfect={} emitted={} expected={} matched={} precision={:.3} recall={:.3}",
        cases.len(),
        acc.perfect_cases,
        acc.emitted,
        acc.expected,
        acc.matched,
        acc.precision(),
        acc.recall(),
    );
    acc
}

fn assert_tier1_targets(parser_id: &str, acc: &Accuracy) {
    let precision = acc.precision();
    let recall = acc.recall();
    if precision < 0.97 {
        for f in &acc.failures {
            eprintln!("  {}", f);
        }
        panic!(
            "{parser_id} precision {precision:.3} below 0.97 (ADR 0007 Tier-1 target); matched={} emitted={}",
            acc.matched, acc.emitted
        );
    }
    if recall < 0.85 {
        for f in &acc.failures {
            eprintln!("  {}", f);
        }
        panic!(
            "{parser_id} recall {recall:.3} below 0.85 (ADR 0007 Tier-1 target); matched={} expected={}",
            acc.matched, acc.expected
        );
    }
}

#[test]
fn rustc_corpus_meets_tier1_targets() {
    let acc = run_parser_corpus("rustc", 20);
    assert_tier1_targets("rustc", &acc);
}

#[test]
fn tsc_corpus_meets_tier1_targets() {
    let acc = run_parser_corpus("tsc", 20);
    assert_tier1_targets("tsc", &acc);
}

#[test]
fn python_traceback_corpus_meets_tier1_targets() {
    let acc = run_parser_corpus("python_traceback", 20);
    assert_tier1_targets("python_traceback", &acc);
}

#[test]
fn node_stack_corpus_meets_tier1_targets() {
    let acc = run_parser_corpus("node_stack", 20);
    assert_tier1_targets("node_stack", &acc);
}
