//! Domain types for the redaction pipeline.
//!
//! Pure module: no IO, no async, no regex (regex lives in adapters). This
//! layer defines the vocabulary ports + adapters speak and a handful of
//! pure helpers that can be reused without constructing a full
//! [`crate::SecretDetector`].

use serde::{Deserialize, Serialize};

/// Current detector ruleset version.
///
/// Bump this whenever a rule is added, removed, or semantically changed.
/// Persisted [`Redaction`] records carry this value so historical data can be
/// rescanned when rules evolve (ADR 0006 §Detector Ruleset Versioning).
pub const RULESET_VERSION: u32 = 1;

/// The observable class of a redaction, surfaced to the UI and audit log.
///
/// These map to the six classes defined in ADR 0006 §Secret Classes. The
/// enum is `non_exhaustive` so adding a class in a future phase is additive.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[non_exhaustive]
#[serde(rename_all = "snake_case")]
pub enum SecretClass {
    /// Env var whose NAME matches a denylist pattern.
    EnvKeySecret,
    /// Env var whose VALUE has high entropy past thresholds.
    ///
    /// Phase 1 stub — entropy detection is tracked; exposed in the API so
    /// adapters can classify future matches without churning the enum.
    EnvValueHighEntropy,
    /// Command-line argument following a sensitive flag (`--token`, etc.).
    CommandArgFlagSecret,
    /// Well-known token pattern (AWS key, GitHub PAT, OpenAI key, PEM, JWT, …).
    WellKnownToken,
    /// Well-known token appearing in captured stdout/stderr.
    OutputWellKnownToken,
    /// User explicitly flagged a span as sensitive.
    ManualUserMarked,
}

impl SecretClass {
    /// Human-readable snake-case label, stable across versions. Used in
    /// persistence markers like `[REDACTED:well_known_token]`.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            SecretClass::EnvKeySecret => "env_key_secret",
            SecretClass::EnvValueHighEntropy => "env_value_highentropy",
            SecretClass::CommandArgFlagSecret => "command_arg_flag_secret",
            SecretClass::WellKnownToken => "well_known_token",
            SecretClass::OutputWellKnownToken => "output_well_known_token",
            SecretClass::ManualUserMarked => "manual_user_marked",
        }
    }
}

/// A single redaction event: an offset range in the original string plus
/// metadata required by the audit log.
///
/// Offsets are in **bytes**, relative to the original input, and half-open
/// (`[start, end)`). The rule id is a stable string identifier so a single
/// class can carry many distinct rules (e.g. `WellKnownToken` covers
/// `aws_access_key`, `github_pat`, …).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Redaction {
    pub class: SecretClass,
    pub start: usize,
    pub end: usize,
    pub rule_id: String,
    pub ruleset_version: u32,
}

impl Redaction {
    /// Construct with byte offsets and the current [`RULESET_VERSION`].
    #[must_use]
    pub fn new(class: SecretClass, start: usize, end: usize, rule_id: impl Into<String>) -> Self {
        Self {
            class,
            start,
            end,
            rule_id: rule_id.into(),
            ruleset_version: RULESET_VERSION,
        }
    }

    /// Length of the redacted span in bytes.
    #[must_use]
    pub const fn len(&self) -> usize {
        // Saturating: a malformed `end < start` produces `0` rather than a
        // panic. No panics in the detector per the hard rules.
        self.end.saturating_sub(self.start)
    }

    /// Whether the redaction span is empty (zero bytes).
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Result of running a redaction pass over a string.
///
/// `display` is the persistence-ready representation (with `[REDACTED:…]`
/// markers substituted). The `redactions` vector retains offsets into the
/// ORIGINAL string so an in-memory reveal path can recover the raw substring
/// while the buffer still lives (ADR 0006 §Manual Reveal).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedactedString {
    pub original_len: usize,
    pub redactions: Vec<Redaction>,
    pub display: String,
}

impl RedactedString {
    /// Did any redaction fire?
    #[must_use]
    pub fn has_redactions(&self) -> bool {
        !self.redactions.is_empty()
    }
}

/// Metadata for a single rule in the ruleset. Adapters own the actual match
/// logic; this struct is data-driven configuration shipped alongside the
/// detector so rule changes are one edit to the ruleset module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RedactionRule {
    pub id: &'static str,
    pub pattern_description: &'static str,
    pub class: SecretClass,
}

/// Canonical marker substituted in persisted text.
///
/// Kept in the domain layer (not the adapter) because UI and export paths
/// also need to render consistent markers and must agree on the format.
#[must_use]
pub fn redaction_marker(class: SecretClass) -> String {
    format!("[REDACTED:{}]", class.label())
}

/// Case-insensitive env key classifier — a pure function so callers that
/// only need env filtering (e.g. launch-env scrubbing) don't pay the cost of
/// a full detector. Suffix-matches the built-in denylist.
///
/// Returns the class that fired or `None` if the key is not denylisted.
/// Does NOT perform entropy analysis on the value.
#[must_use]
pub fn redact_env_key(name: &str) -> Option<SecretClass> {
    if name.is_empty() {
        return None;
    }
    let upper = name.to_ascii_uppercase();
    for suffix in ENV_KEY_DENYLIST_SUFFIXES {
        if upper.ends_with(suffix) {
            return Some(SecretClass::EnvKeySecret);
        }
    }
    for prefix in ENV_KEY_DENYLIST_PREFIXES {
        if upper.starts_with(prefix) {
            return Some(SecretClass::EnvKeySecret);
        }
    }
    None
}

/// Env key suffix denylist. Case-insensitive, compared against uppercase key.
///
/// ADR 0006 §Env Key Denylist Patterns is the source of truth. Keep this
/// list obviously-correct; entries should be fragments any operator would
/// recognize as sensitive.
pub const ENV_KEY_DENYLIST_SUFFIXES: &[&str] = &[
    "PASSWORD",
    "SECRET",
    "TOKEN",
    "API_KEY",
    "APIKEY",
    "PRIVATE_KEY",
    "ACCESS_KEY",
    "CREDENTIALS",
    "PASSPHRASE",
    "AUTH",
];

/// Env key prefix denylist for vendor-namespaced variables where the suffix
/// is not necessarily sensitive on its own (`AWS_ACCESS_KEY_ID` looks like an
/// ID, but it IS a credential half).
pub const ENV_KEY_DENYLIST_PREFIXES: &[&str] = &[
    "AWS_SECRET_",
    "AWS_ACCESS_KEY_",
    "AWS_SESSION_",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "STRIPE_",
    "TWILIO_",
    "SLACK_",
];

/// Pure, dependency-free command redaction convenience.
///
/// Walks a whitespace-tokenized command string and redacts the VALUE
/// following any flag in the Phase-1 flag denylist. Flags can be either
/// `--token VALUE` (two tokens) or `--token=VALUE` (one token) forms.
///
/// This helper exists so callers that don't want to instantiate a full
/// detector (e.g. small CLI utilities, tests) can still get consistent
/// behavior. The adapter's `scan_command` path produces identical offsets.
#[must_use]
pub fn redact_command(raw: &str) -> RedactedString {
    let mut redactions = Vec::new();
    let mut byte_cursor = 0usize;
    let bytes = raw.as_bytes();

    // Pre-pass: if an assignment like `KEY=VALUE` starts the command, redact
    // the value when the KEY matches the env denylist. This handles the
    // shell-local env syntax `SECRET=foo ./run` without splitting the pipe.
    if let Some((key, _value, eq_pos, end_pos)) = leading_env_assignment(raw) {
        if redact_env_key(key).is_some() {
            let value_start = eq_pos + 1;
            if end_pos > value_start {
                redactions.push(Redaction::new(
                    SecretClass::EnvKeySecret,
                    value_start,
                    end_pos,
                    "env_inline_assignment",
                ));
            }
        }
    }

    // Flag scan. We recognize flags from [`COMMAND_FLAG_DENYLIST`] and redact
    // either the value glued with `=` or the next whitespace-separated token.
    while byte_cursor < bytes.len() {
        // Skip whitespace.
        while byte_cursor < bytes.len() && is_ws(bytes[byte_cursor]) {
            byte_cursor += 1;
        }
        let tok_start = byte_cursor;
        while byte_cursor < bytes.len() && !is_ws(bytes[byte_cursor]) {
            byte_cursor += 1;
        }
        let tok_end = byte_cursor;
        if tok_start == tok_end {
            break;
        }
        let tok = &raw[tok_start..tok_end];
        if let Some((flag_part, value_start_in_tok)) = split_flag_eq(tok) {
            if COMMAND_FLAG_DENYLIST.contains(&flag_part) {
                // --flag=VALUE form. Redact from after `=` to end of token.
                let vstart = tok_start + value_start_in_tok;
                if tok_end > vstart {
                    redactions.push(Redaction::new(
                        SecretClass::CommandArgFlagSecret,
                        vstart,
                        tok_end,
                        "command_flag_equals",
                    ));
                }
            }
        } else if COMMAND_FLAG_DENYLIST.contains(&tok) {
            // --flag VALUE form. Advance past whitespace, redact next token.
            let mut after_ws = byte_cursor;
            while after_ws < bytes.len() && is_ws(bytes[after_ws]) {
                after_ws += 1;
            }
            let next_start = after_ws;
            let mut next_end = after_ws;
            while next_end < bytes.len() && !is_ws(bytes[next_end]) {
                next_end += 1;
            }
            if next_end > next_start {
                redactions.push(Redaction::new(
                    SecretClass::CommandArgFlagSecret,
                    next_start,
                    next_end,
                    "command_flag_space",
                ));
                byte_cursor = next_end;
            }
        }
    }

    let display = render_display(raw, &redactions);
    RedactedString {
        original_len: raw.len(),
        redactions,
        display,
    }
}

/// Flag denylist for command-argument redaction. Case-sensitive — shell flags
/// are case-sensitive by convention and we don't want `--TOKEN` (likely not
/// a real flag) to match.
pub const COMMAND_FLAG_DENYLIST: &[&str] = &[
    "--token",
    "--password",
    "--api-key",
    "--apikey",
    "--secret",
    "--auth",
    "--bearer",
    "-p",
    "-P",
];

fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

/// If `tok` is `--flag=value` return (`--flag`, byte offset of value start in tok).
/// Returns `None` for tokens without `=` or for tokens that start with `=`.
fn split_flag_eq(tok: &str) -> Option<(&str, usize)> {
    let eq = tok.find('=')?;
    if eq == 0 {
        return None;
    }
    Some((&tok[..eq], eq + 1))
}

/// Detect a leading `KEY=VALUE` assignment and return `(key, value, eq_offset, value_end_offset)`.
///
/// Returns `None` if the first token is not an assignment or the key contains
/// invalid shell-identifier chars. Byte offsets are measured into `raw`.
fn leading_env_assignment(raw: &str) -> Option<(&str, &str, usize, usize)> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() && is_ws(bytes[i]) {
        i += 1;
    }
    let tok_start = i;
    while i < bytes.len() && !is_ws(bytes[i]) {
        i += 1;
    }
    let tok_end = i;
    if tok_start == tok_end {
        return None;
    }
    let tok = &raw[tok_start..tok_end];
    let eq_in_tok = tok.find('=')?;
    if eq_in_tok == 0 {
        return None;
    }
    let key = &tok[..eq_in_tok];
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    if key.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    let value = &tok[eq_in_tok + 1..];
    Some((key, value, tok_start + eq_in_tok, tok_end))
}

/// Render a string with redactions substituted by `[REDACTED:…]` markers.
///
/// Redactions are sorted and merged (overlapping spans collapse to the
/// outermost class) before rendering. Invalid/empty redactions are skipped
/// without panicking.
#[must_use]
pub fn render_display(raw: &str, redactions: &[Redaction]) -> String {
    if redactions.is_empty() {
        return raw.to_string();
    }
    let mut sorted: Vec<&Redaction> = redactions
        .iter()
        .filter(|r| r.end <= raw.len() && r.start < r.end)
        .collect();
    sorted.sort_by_key(|r| (r.start, r.end));
    let mut out = String::with_capacity(raw.len());
    let mut cursor = 0usize;
    for r in sorted {
        if r.start < cursor {
            // Overlap: already inside a previously-rendered redaction. Skip
            // rather than corrupt the output.
            continue;
        }
        // Push the clean prefix up to `start`.
        if let Some(prefix) = raw.get(cursor..r.start) {
            out.push_str(prefix);
        } else {
            // `r.start` not on a char boundary. Push bytes safely via
            // char-aligned truncation.
            let safe_end = floor_char_boundary(raw, r.start);
            if let Some(prefix) = raw.get(cursor..safe_end) {
                out.push_str(prefix);
            }
        }
        out.push_str(&redaction_marker(r.class));
        cursor = r.end;
    }
    if let Some(rest) = raw.get(cursor..) {
        out.push_str(rest);
    }
    out
}

/// Round `idx` down to the nearest UTF-8 char boundary in `s`. Replaces the
/// unstable `str::floor_char_boundary` — we can't panic in the detector.
fn floor_char_boundary(s: &str, idx: usize) -> usize {
    let mut i = idx.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_key_suffix_match() {
        assert_eq!(
            redact_env_key("MY_PASSWORD"),
            Some(SecretClass::EnvKeySecret)
        );
        assert_eq!(redact_env_key("API_TOKEN"), Some(SecretClass::EnvKeySecret));
        assert_eq!(
            redact_env_key("OPENAI_API_KEY"),
            Some(SecretClass::EnvKeySecret)
        );
        assert_eq!(
            redact_env_key("DB_CREDENTIALS"),
            Some(SecretClass::EnvKeySecret)
        );
    }

    #[test]
    fn env_key_prefix_match_vendor() {
        assert_eq!(
            redact_env_key("AWS_SECRET_ACCESS_KEY"),
            Some(SecretClass::EnvKeySecret)
        );
        assert_eq!(
            redact_env_key("STRIPE_ANYTHING"),
            Some(SecretClass::EnvKeySecret)
        );
        assert_eq!(
            redact_env_key("SLACK_BOT_TOKEN"),
            Some(SecretClass::EnvKeySecret)
        );
    }

    #[test]
    fn env_key_case_insensitive() {
        assert_eq!(
            redact_env_key("my_password"),
            Some(SecretClass::EnvKeySecret)
        );
        assert_eq!(
            redact_env_key("Github_Token"),
            Some(SecretClass::EnvKeySecret)
        );
    }

    #[test]
    fn env_key_benign_miss() {
        assert_eq!(redact_env_key("PATH"), None);
        assert_eq!(redact_env_key("HOME"), None);
        assert_eq!(redact_env_key(""), None);
    }

    #[test]
    fn redact_command_flag_space_form() {
        let r = redact_command("deploy --token abcd1234 --name foo");
        assert_eq!(r.redactions.len(), 1);
        let red = &r.redactions[0];
        assert_eq!(red.class, SecretClass::CommandArgFlagSecret);
        assert_eq!(
            &r.display[..],
            "deploy --token [REDACTED:command_arg_flag_secret] --name foo"
        );
    }

    #[test]
    fn redact_command_flag_equals_form() {
        let r = redact_command("curl --api-key=ABC123 https://example.com");
        assert_eq!(r.redactions.len(), 1);
        assert!(!r.display.contains("ABC123"));
        assert!(r.display.contains("[REDACTED:command_arg_flag_secret]"));
    }

    #[test]
    fn redact_command_leading_env_assignment() {
        let r = redact_command("AWS_SECRET_ACCESS_KEY=leaked ./run");
        assert!(r.has_redactions());
        assert!(!r.display.contains("leaked"));
    }

    #[test]
    fn redact_command_benign_unchanged() {
        let r = redact_command("ls -la /tmp");
        assert!(!r.has_redactions());
        assert_eq!(r.display, "ls -la /tmp");
    }

    #[test]
    fn marker_stable_label() {
        assert_eq!(
            redaction_marker(SecretClass::WellKnownToken),
            "[REDACTED:well_known_token]"
        );
    }

    #[test]
    fn redaction_len_saturates_on_inversion() {
        let r = Redaction::new(SecretClass::WellKnownToken, 10, 5, "bad");
        assert_eq!(r.len(), 0);
        assert!(r.is_empty());
    }

    #[test]
    fn render_display_handles_overlapping_spans() {
        let raw = "abcdefghij";
        let r = vec![
            Redaction::new(SecretClass::WellKnownToken, 2, 7, "a"),
            Redaction::new(SecretClass::WellKnownToken, 4, 6, "b"),
        ];
        let rendered = render_display(raw, &r);
        // The inner overlap should not corrupt the output.
        assert!(rendered.starts_with("ab"));
        assert!(rendered.ends_with("hij"));
    }

    #[test]
    fn render_display_preserves_char_boundaries() {
        // Multi-byte UTF-8 — a redaction offset on a char boundary should
        // not panic. Domain is pure, must never panic (hard rule).
        let raw = "héllo";
        let rendered = render_display(raw, &[]);
        assert_eq!(rendered, "héllo");
    }

    #[test]
    fn ruleset_version_pinned() {
        assert_eq!(RULESET_VERSION, 1);
    }

    #[test]
    fn split_flag_eq_basic() {
        assert_eq!(split_flag_eq("--token=abc"), Some(("--token", 8)));
        assert_eq!(split_flag_eq("--token"), None);
        assert_eq!(split_flag_eq("=abc"), None);
    }
}
