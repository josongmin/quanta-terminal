//! Width-parity test — drives the committed `width_corpus.txt` golden file
//! through `DefaultClassifier::classify_grapheme` and asserts every entry
//! matches.
//!
//! The same corpus is consumed by the TS mirror under
//! `packages/ui/src/shared/lib/width/__tests__/parity.test.ts`. A
//! divergence between Rust and TS fails both suites.

use std::path::PathBuf;

use quanta_vt_width::{AmbiguousWidthPolicy, CellWidth, DefaultClassifier, WidthClassifier};

const FIXTURE: &str = include_str!("fixtures/width_corpus.txt");

fn parse_width(s: &str) -> CellWidth {
    match s {
        "0" => CellWidth::Zero,
        "1" => CellWidth::One,
        "2" => CellWidth::Two,
        other => panic!("unexpected width token in corpus: {other:?}"),
    }
}

#[test]
fn width_corpus_file_is_committed() {
    // Sanity: the fixture must exist on disk at the documented path so the
    // TS parity test can read it. `include_str!` above already guarantees
    // compile-time existence; this assertion just pins the path for
    // humans.
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests");
    p.push("fixtures");
    p.push("width_corpus.txt");
    assert!(
        p.exists(),
        "width_corpus.txt missing at {:?}; TS mirror reads this via fs",
        p
    );
}

#[test]
fn width_corpus_has_at_least_500_entries() {
    let count = FIXTURE
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .count();
    assert!(
        count >= 500,
        "width_corpus.txt has {count} entries; require ≥ 500 per epic spec"
    );
}

#[test]
fn classify_grapheme_matches_corpus_narrow() {
    let classifier = DefaultClassifier::new(AmbiguousWidthPolicy::Narrow);
    let mut total = 0;
    let mut mismatches: Vec<String> = Vec::new();
    for (idx, line) in FIXTURE.lines().enumerate() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let literal = parts
            .next()
            .unwrap_or_else(|| panic!("line {} missing literal", idx + 1));
        let expected = parts
            .next()
            .unwrap_or_else(|| panic!("line {} missing expected width", idx + 1));
        let note = parts.next().unwrap_or("");
        let (_, w) = classifier.classify_grapheme(literal);
        let expect_w = parse_width(expected);
        if w != expect_w {
            mismatches.push(format!(
                "line {}: literal={:?} expected={:?} got={:?} note={:?}",
                idx + 1,
                literal,
                expect_w,
                w,
                note
            ));
        }
        total += 1;
    }
    assert!(
        mismatches.is_empty(),
        "{} of {} corpus entries mismatched:\n{}",
        mismatches.len(),
        total,
        mismatches.join("\n"),
    );
}

#[test]
fn failure_mode_5_korean_han_is_two_cells() {
    // RFC 0001 §22 #5 — `한` must be 2 cells.
    let c = DefaultClassifier::new(AmbiguousWidthPolicy::Narrow);
    assert_eq!(c.classify_grapheme("한").1, CellWidth::Two);
}

#[test]
fn failure_mode_6_zwj_family_is_two_cells() {
    // RFC 0001 §22 #6 — `👨‍👩‍👧‍👦` must be 2 cells.
    let c = DefaultClassifier::new(AmbiguousWidthPolicy::Narrow);
    let cluster = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
    assert_eq!(c.classify_grapheme(cluster).1, CellWidth::Two);
}

#[test]
fn failure_mode_7_vs16_does_not_flip_mid_stream() {
    // RFC 0001 §22 #7 — VS16 must widen the preceding emoji, and it must
    // not affect adjacent clusters.
    let c = DefaultClassifier::new(AmbiguousWidthPolicy::Narrow);
    let out = c.classify_str("A\u{2764}\u{FE0F}B");
    // Expected graphemes: "A" (1), "❤\u{FE0F}" (2), "B" (1)
    assert_eq!(out.len(), 3);
    assert_eq!(out[0].0.as_str(), "A");
    assert_eq!(out[0].1, CellWidth::One);
    assert_eq!(out[1].1, CellWidth::Two);
    assert_eq!(out[2].0.as_str(), "B");
    assert_eq!(out[2].1, CellWidth::One);
}
