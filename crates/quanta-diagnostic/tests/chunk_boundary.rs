//! Proptest: feeding an input byte-by-byte through the pipeline must emit
//! the same diagnostics (in the same order) as feeding it in one shot.
//!
//! This pins the invariant that the session actor relies on: the PTY read
//! loop slices the stream arbitrarily and still produces well-formed
//! diagnostics.

use proptest::prelude::*;

use quanta_diagnostic::DiagnosticPipeline;

fn emissions_one_shot(input: &str) -> Vec<String> {
    let mut p = DiagnosticPipeline::new();
    let mut out = Vec::new();
    out.extend(p.feed(input).into_iter().map(fmt_diag));
    out.extend(p.flush().into_iter().map(fmt_diag));
    out
}

fn emissions_byte_by_byte(input: &str) -> Vec<String> {
    let mut p = DiagnosticPipeline::new();
    let mut out = Vec::new();
    // Walk char boundaries so we never split a multi-byte codepoint.
    let mut start = 0;
    for (i, _) in input.char_indices().skip(1) {
        let chunk = &input[start..i];
        out.extend(p.feed(chunk).into_iter().map(fmt_diag));
        start = i;
    }
    // Final chunk (remainder).
    if start < input.len() {
        out.extend(p.feed(&input[start..]).into_iter().map(fmt_diag));
    }
    out.extend(p.flush().into_iter().map(fmt_diag));
    out
}

fn fmt_diag(d: quanta_diagnostic::Diagnostic) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}",
        d.parser_id,
        d.message,
        d.path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        d.line.unwrap_or(0),
        d.column.unwrap_or(0),
        d.symbol.as_deref().unwrap_or("")
    )
}

// A curated set of realistic inputs. proptest picks among them and also
// picks a splitting strategy, so we cover both structural variations and
// chunk-boundary variations.
fn sample_inputs() -> Vec<String> {
    vec![
        "error[E0425]: cannot find value `foo` in this scope\n --> src/main.rs:3:5\n".to_string(),
        "warning: unused variable: `x`\n  --> src/lib.rs:10:9\n".to_string(),
        "src/app.ts(17,12): error TS2322: Type 'string' is not assignable to type 'number'.\n"
            .to_string(),
        r#"Traceback (most recent call last):
  File "app.py", line 7, in <module>
    main()
ValueError: bad thing
"#
        .to_string(),
        r"ReferenceError: foo is not defined
    at Object.<anonymous> (/repo/src/app.js:4:1)
    at Module._compile (node:internal/modules/cjs/loader:1254:14)
"
        .to_string(),
    ]
}

proptest! {
    #[test]
    fn byte_by_byte_matches_one_shot(ix in 0usize..5) {
        let inputs = sample_inputs();
        let input = &inputs[ix];
        let one = emissions_one_shot(input);
        let many = emissions_byte_by_byte(input);
        prop_assert_eq!(one, many, "chunk-split changed emission for input {}", ix);
    }
}

#[test]
fn concatenated_inputs_split_at_random_points() {
    // Non-proptest sanity: concatenate every sample input and split at every
    // byte boundary. Feeding the whole thing then feeding per-char must
    // agree.
    let text: String = sample_inputs().join("");
    let one = emissions_one_shot(&text);
    let many = emissions_byte_by_byte(&text);
    assert_eq!(one, many);
}
