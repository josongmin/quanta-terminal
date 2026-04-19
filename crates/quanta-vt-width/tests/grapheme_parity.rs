//! Grapheme-parity test — drives `grapheme_corpus.txt` through the
//! classifier's `classify_str` method and asserts both segmentation count
//! and per-cluster width match.
//!
//! The TS mirror consumes the same fixture. Divergence fails both.

use quanta_vt_width::{AmbiguousWidthPolicy, CellWidth, DefaultClassifier, WidthClassifier};

const FIXTURE: &str = include_str!("fixtures/grapheme_corpus.txt");

fn hex_bytes_to_string(hex: &str) -> String {
    let mut bytes = Vec::new();
    for token in hex.split_whitespace() {
        let b = u8::from_str_radix(token, 16)
            .unwrap_or_else(|e| panic!("bad hex token {:?}: {}", token, e));
        bytes.push(b);
    }
    String::from_utf8(bytes).unwrap_or_else(|e| panic!("not UTF-8: {}", e))
}

fn parse_widths(csv: &str) -> Vec<CellWidth> {
    csv.split(',')
        .map(|s| match s.trim() {
            "0" => CellWidth::Zero,
            "1" => CellWidth::One,
            "2" => CellWidth::Two,
            other => panic!("unexpected width in widths_csv: {other:?}"),
        })
        .collect()
}

#[test]
fn grapheme_corpus_has_at_least_100_entries() {
    let count = FIXTURE
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .count();
    assert!(
        count >= 100,
        "grapheme_corpus.txt has {count} entries; require ≥ 100 per epic spec"
    );
}

#[test]
fn classify_str_matches_grapheme_corpus() {
    let classifier = DefaultClassifier::new(AmbiguousWidthPolicy::Narrow);
    let mut total = 0;
    let mut mismatches: Vec<String> = Vec::new();
    for (idx, line) in FIXTURE.lines().enumerate() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let hex = parts.next().unwrap_or_else(|| panic!("line {} no hex", idx + 1));
        let count_str = parts
            .next()
            .unwrap_or_else(|| panic!("line {} no count", idx + 1));
        let widths_csv = parts
            .next()
            .unwrap_or_else(|| panic!("line {} no widths", idx + 1));
        let s = hex_bytes_to_string(hex);
        let expected_count: usize = count_str
            .trim()
            .parse()
            .unwrap_or_else(|e| panic!("line {} bad count {:?}: {}", idx + 1, count_str, e));
        let expected_widths = parse_widths(widths_csv);
        let got = classifier.classify_str(&s);
        if got.len() != expected_count {
            mismatches.push(format!(
                "line {}: {:?}: grapheme count mismatch expected={} got={}",
                idx + 1,
                s,
                expected_count,
                got.len(),
            ));
            total += 1;
            continue;
        }
        if got.len() == expected_widths.len() {
            for (i, (g, w)) in got.iter().enumerate() {
                if *w != expected_widths[i] {
                    mismatches.push(format!(
                        "line {}: {:?}: cluster {} ({:?}): expected width={:?} got={:?}",
                        idx + 1,
                        s,
                        i,
                        g.as_str(),
                        expected_widths[i],
                        w,
                    ));
                }
            }
        }
        total += 1;
    }
    assert!(
        mismatches.is_empty(),
        "{} of {} grapheme entries mismatched:\n{}",
        mismatches.len(),
        total,
        mismatches.join("\n"),
    );
}

#[test]
fn combining_mark_is_one_grapheme_with_base() {
    let c = DefaultClassifier::new(AmbiguousWidthPolicy::Narrow);
    let out = c.classify_str("e\u{0301}");
    assert_eq!(out.len(), 1, "e + combining acute is ONE grapheme");
    assert_eq!(out[0].0.as_str(), "e\u{0301}");
    assert_eq!(out[0].1, CellWidth::One);
}

#[test]
fn zwj_family_is_one_grapheme() {
    let c = DefaultClassifier::new(AmbiguousWidthPolicy::Narrow);
    let cluster = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
    let out = c.classify_str(cluster);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].1, CellWidth::Two);
}

#[test]
fn regional_indicator_pair_is_one_grapheme() {
    let c = DefaultClassifier::new(AmbiguousWidthPolicy::Narrow);
    let out = c.classify_str("\u{1F1F0}\u{1F1F7}");
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].1, CellWidth::Two);
}
