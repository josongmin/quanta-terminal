//! `DefaultDetector` — Phase-1 secret detector.
//!
//! Data-driven: the set of rules is defined in [`rules`], so adding a rule
//! does not require touching the [`crate::SecretDetector`] trait impl.
//!
//! All regular expressions are compiled once per process via
//! [`once_cell::sync::Lazy`] — regex per-chunk is a pathology.

pub(crate) mod rules;

use std::collections::HashSet;

use crate::domain::{
    redact_env_key, Redaction, SecretClass, COMMAND_FLAG_DENYLIST, RULESET_VERSION,
};
use crate::ports::SecretDetector;

use self::rules::{COMMAND_FLAG_RULES, ENV_KEY_RULES, TOKEN_RULES};

/// Phase-1 production detector. Zero-sized: all state is `'static`.
#[derive(Default, Clone, Copy)]
pub struct DefaultDetector;

impl DefaultDetector {
    /// Build a detector bound to [`RULESET_VERSION`].
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

impl std::fmt::Debug for DefaultDetector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DefaultDetector")
            .field("ruleset_version", &RULESET_VERSION)
            .finish()
    }
}

impl SecretDetector for DefaultDetector {
    fn scan_env_entry(&self, key: &str, value: &str) -> Option<Redaction> {
        if redact_env_key(key).is_some() {
            return Some(Redaction::new(
                SecretClass::EnvKeySecret,
                0,
                value.len(),
                "env_key_denylist",
            ));
        }
        None
    }

    fn scan_command(&self, command: &str) -> Vec<Redaction> {
        let mut out = Vec::new();
        scan_leading_env_assignment(command, &mut out);
        scan_command_flags(command, &mut out);
        scan_tokens_in_str(command, SecretClass::WellKnownToken, &mut out);
        dedup_overlaps(&mut out);
        out
    }

    fn scan_output(&self, bytes: &[u8]) -> Vec<Redaction> {
        // Lossy UTF-8 tolerates invalid bytes without panicking. Offsets are
        // measured in the decoded string; since `from_utf8_lossy` replaces
        // invalid sequences with U+FFFD (3 bytes in UTF-8), the mapping back
        // to `bytes` is lossy for those stretches. Callers that need exact
        // mapping into the raw byte stream should chunk at known-UTF-8
        // boundaries before calling.
        let s = String::from_utf8_lossy(bytes);
        let mut out = Vec::new();
        scan_tokens_in_str(&s, SecretClass::OutputWellKnownToken, &mut out);
        dedup_overlaps(&mut out);
        out
    }

    fn ruleset_version(&self) -> u32 {
        RULESET_VERSION
    }
}

/// Number of built-in env-key denylist entries (for diagnostics / tests).
#[must_use]
pub fn env_rule_count() -> usize {
    ENV_KEY_RULES.len()
}

/// Number of token regex rules (for diagnostics / tests).
#[must_use]
pub fn token_rule_count() -> usize {
    TOKEN_RULES.len()
}

/// Number of command-flag denylist entries (for diagnostics / tests).
#[must_use]
pub fn command_flag_rule_count() -> usize {
    COMMAND_FLAG_RULES.len()
}

fn scan_tokens_in_str(input: &str, class: SecretClass, out: &mut Vec<Redaction>) {
    for rule in TOKEN_RULES.iter() {
        let re = rule.regex();
        for m in re.find_iter(input) {
            out.push(Redaction::new(class, m.start(), m.end(), rule.id));
        }
    }
}

fn scan_leading_env_assignment(raw: &str, out: &mut Vec<Redaction>) {
    // Recognize any number of leading `KEY=VALUE` tokens (shell supports
    // chaining: `A=1 B=2 cmd`). We stop at the first non-assignment token.
    let bytes = raw.as_bytes();
    let mut i = 0usize;
    loop {
        while i < bytes.len() && is_ws(bytes[i]) {
            i += 1;
        }
        let tok_start = i;
        while i < bytes.len() && !is_ws(bytes[i]) {
            i += 1;
        }
        let tok_end = i;
        if tok_start == tok_end {
            return;
        }
        let tok = &raw[tok_start..tok_end];
        let Some(eq) = tok.find('=') else { return };
        if eq == 0 {
            return;
        }
        let key = &tok[..eq];
        let valid = !key.is_empty()
            && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && !key.chars().next().is_some_and(|c| c.is_ascii_digit());
        if !valid {
            return;
        }
        if redact_env_key(key).is_some() {
            let vstart = tok_start + eq + 1;
            if tok_end > vstart {
                out.push(Redaction::new(
                    SecretClass::EnvKeySecret,
                    vstart,
                    tok_end,
                    "env_inline_assignment",
                ));
            }
        }
    }
}

fn scan_command_flags(raw: &str, out: &mut Vec<Redaction>) {
    let bytes = raw.as_bytes();
    let flag_set: HashSet<&&str> = COMMAND_FLAG_DENYLIST.iter().collect();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && is_ws(bytes[i]) {
            i += 1;
        }
        let tok_start = i;
        while i < bytes.len() && !is_ws(bytes[i]) {
            i += 1;
        }
        let tok_end = i;
        if tok_start == tok_end {
            break;
        }
        let tok = &raw[tok_start..tok_end];
        // `--key=value` form: redact everything after `=` if the flag matches.
        let mut handled_equals = false;
        if let Some(eq) = tok.find('=') {
            if eq > 0 {
                let flag = &tok[..eq];
                if flag_set.contains(&flag) {
                    let vstart = tok_start + eq + 1;
                    if tok_end > vstart {
                        out.push(Redaction::new(
                            SecretClass::CommandArgFlagSecret,
                            vstart,
                            tok_end,
                            "command_flag_equals",
                        ));
                    }
                }
                handled_equals = true;
            }
        }
        if handled_equals {
            continue;
        }
        if flag_set.contains(&tok) {
            // `-p` has a historical "only redact when followed by
            // password-shape" caveat in the ADR. A "password-shaped" value
            // here is conservatively: at least 4 chars, contains at least
            // one non-whitespace non-quote printable. Empty or shell-control
            // tokens are skipped.
            let is_short_p = tok == "-p" || tok == "-P";
            let mut j = i;
            while j < bytes.len() && is_ws(bytes[j]) {
                j += 1;
            }
            let vstart = j;
            while j < bytes.len() && !is_ws(bytes[j]) {
                j += 1;
            }
            let vend = j;
            if vend > vstart {
                let value = &raw[vstart..vend];
                if is_short_p && !looks_password_shaped(value) {
                    // Skip — likely a flag positional (e.g. `ssh -p 22 host`).
                    continue;
                }
                out.push(Redaction::new(
                    SecretClass::CommandArgFlagSecret,
                    vstart,
                    vend,
                    "command_flag_space",
                ));
                i = vend;
            }
        }
    }
}

fn looks_password_shaped(s: &str) -> bool {
    // Short port numbers `22`, `3306`, …, are not password-shaped.
    if s.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    // Very short tokens are usually not passwords either.
    s.len() >= 4
}

fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

/// Collapse overlapping redactions: keep the wider span. Stable under repeated
/// calls so adapter composition is idempotent.
fn dedup_overlaps(redactions: &mut Vec<Redaction>) {
    if redactions.len() < 2 {
        return;
    }
    redactions.sort_by_key(|r| (r.start, std::cmp::Reverse(r.end)));
    let mut kept: Vec<Redaction> = Vec::with_capacity(redactions.len());
    for r in redactions.drain(..) {
        if let Some(last) = kept.last_mut() {
            if r.start < last.end {
                // Overlap: merge by extending last's end and keeping its class.
                if r.end > last.end {
                    last.end = r.end;
                }
                continue;
            }
        }
        kept.push(r);
    }
    *redactions = kept;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ruleset_version_matches_domain() {
        let d = DefaultDetector::new();
        assert_eq!(d.ruleset_version(), RULESET_VERSION);
    }

    #[test]
    fn scan_env_entry_denylisted_key() {
        let d = DefaultDetector::new();
        let r = d.scan_env_entry("GITHUB_TOKEN", "ghp_abc").unwrap();
        assert_eq!(r.class, SecretClass::EnvKeySecret);
        assert_eq!(r.start, 0);
        assert_eq!(r.end, "ghp_abc".len());
    }

    #[test]
    fn scan_env_entry_benign_returns_none() {
        let d = DefaultDetector::new();
        assert!(d.scan_env_entry("PATH", "/usr/bin").is_none());
    }

    #[test]
    fn scan_command_redacts_aws_key() {
        let d = DefaultDetector::new();
        let r = d.scan_command("aws s3 ls --profile dev AKIAIOSFODNN7EXAMPLE");
        assert!(r.iter().any(|red| red.class == SecretClass::WellKnownToken));
    }

    #[test]
    fn scan_command_flag_value() {
        let d = DefaultDetector::new();
        let r = d.scan_command("curl --token abcdef1234567890");
        assert!(r
            .iter()
            .any(|red| red.class == SecretClass::CommandArgFlagSecret));
    }

    #[test]
    fn scan_command_short_p_ignores_port() {
        let d = DefaultDetector::new();
        let r = d.scan_command("ssh -p 22 host");
        // No redaction — `22` is digit-only and not password-shaped.
        assert!(r
            .iter()
            .all(|red| red.class != SecretClass::CommandArgFlagSecret));
    }

    #[test]
    fn scan_command_short_p_catches_password() {
        let d = DefaultDetector::new();
        let r = d.scan_command("mysql -p sup3rsecretpw");
        assert!(r
            .iter()
            .any(|red| red.class == SecretClass::CommandArgFlagSecret));
    }

    #[test]
    fn scan_output_finds_github_pat() {
        let d = DefaultDetector::new();
        let sample = format!("token printed: ghp_{}", "a".repeat(36));
        let r = d.scan_output(sample.as_bytes());
        assert!(r
            .iter()
            .any(|red| red.class == SecretClass::OutputWellKnownToken));
    }

    #[test]
    fn scan_output_finds_openai_key() {
        let d = DefaultDetector::new();
        let sample = format!("key=sk-{}", "x".repeat(30));
        let r = d.scan_output(sample.as_bytes());
        assert!(!r.is_empty());
    }

    #[test]
    fn scan_output_benign_empty() {
        let d = DefaultDetector::new();
        let r = d.scan_output(b"nothing interesting here");
        assert!(r.is_empty());
    }

    #[test]
    fn scan_output_tolerates_invalid_utf8() {
        let d = DefaultDetector::new();
        // Invalid UTF-8 must not panic.
        let r = d.scan_output(&[0xff, 0xfe, 0x00, 0x01]);
        assert!(r.is_empty());
    }

    #[test]
    fn rule_counts_meet_minimums() {
        // Guard against accidental rule-removal regressions.
        assert!(env_rule_count() >= 14);
        assert!(token_rule_count() >= 7);
        assert!(command_flag_rule_count() >= 5);
    }
}
