//! Default detector ruleset — data-driven catalog.
//!
//! Adding a rule is a single-line edit here. The detector engine in
//! `adapters/default/mod.rs` consumes these tables; it does NOT hard-code
//! any pattern.
//!
//! All regexes are compiled lazily via [`once_cell::sync::Lazy`] — at most
//! once per process. Do NOT compile regexes in hot paths.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::domain::{RedactionRule, SecretClass};

/// Env key denylist. See ADR 0006 §Env Key Denylist Patterns.
///
/// This mirrors the pure-domain `ENV_KEY_DENYLIST_*` constants (the pure
/// function `redact_env_key` is the canonical checker); the array here
/// exists for diagnostics and to document that the env layer is a
/// first-class ruleset, not an afterthought.
pub(crate) const ENV_KEY_RULES: &[RedactionRule] = &[
    RedactionRule {
        id: "env_key_password_suffix",
        pattern_description: "case-insensitive suffix match on *PASSWORD",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_secret_suffix",
        pattern_description: "case-insensitive suffix match on *SECRET",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_token_suffix",
        pattern_description: "case-insensitive suffix match on *TOKEN",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_api_key_suffix",
        pattern_description: "case-insensitive suffix match on *API_KEY / *APIKEY",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_private_key_suffix",
        pattern_description: "case-insensitive suffix match on *PRIVATE_KEY",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_access_key_suffix",
        pattern_description: "case-insensitive suffix match on *ACCESS_KEY",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_credentials_suffix",
        pattern_description: "case-insensitive suffix match on *CREDENTIALS",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_passphrase_suffix",
        pattern_description: "case-insensitive suffix match on *PASSPHRASE",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_auth_suffix",
        pattern_description: "case-insensitive suffix match on *AUTH",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_aws_prefix",
        pattern_description: "case-insensitive prefix AWS_SECRET_ / AWS_ACCESS_KEY_ / AWS_SESSION_",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_github_exact",
        pattern_description: "GITHUB_TOKEN / GH_TOKEN",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_openai",
        pattern_description: "OPENAI_API_KEY",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_anthropic",
        pattern_description: "ANTHROPIC_API_KEY",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_stripe_prefix",
        pattern_description: "STRIPE_*",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_twilio_prefix",
        pattern_description: "TWILIO_*",
        class: SecretClass::EnvKeySecret,
    },
    RedactionRule {
        id: "env_key_slack_prefix",
        pattern_description: "SLACK_*",
        class: SecretClass::EnvKeySecret,
    },
];

/// Command-flag denylist. See ADR 0006 §Secret Classes → `command_arg_flag_secret`.
pub(crate) const COMMAND_FLAG_RULES: &[RedactionRule] = &[
    RedactionRule {
        id: "command_flag_token",
        pattern_description: "--token <value>",
        class: SecretClass::CommandArgFlagSecret,
    },
    RedactionRule {
        id: "command_flag_password",
        pattern_description: "--password <value>",
        class: SecretClass::CommandArgFlagSecret,
    },
    RedactionRule {
        id: "command_flag_api_key",
        pattern_description: "--api-key <value>",
        class: SecretClass::CommandArgFlagSecret,
    },
    RedactionRule {
        id: "command_flag_secret",
        pattern_description: "--secret <value>",
        class: SecretClass::CommandArgFlagSecret,
    },
    RedactionRule {
        id: "command_flag_auth",
        pattern_description: "--auth / --bearer <value>",
        class: SecretClass::CommandArgFlagSecret,
    },
    RedactionRule {
        id: "command_flag_short_p",
        pattern_description: "-p / -P <password-shaped value>",
        class: SecretClass::CommandArgFlagSecret,
    },
];

/// A token rule: a stable id + a function that returns the compiled regex.
///
/// The regex is wrapped in a Lazy so compilation happens exactly once per
/// process. Calling `regex()` is O(1) after first use.
pub(crate) struct TokenRule {
    pub(crate) id: &'static str,
    #[allow(dead_code, reason = "retained for future UI / audit descriptions")]
    pub(crate) pattern_description: &'static str,
    compiled: &'static Lazy<Regex>,
}

impl TokenRule {
    pub(crate) fn regex(&self) -> &'static Regex {
        self.compiled
    }
}

// ─── Compiled regexes ───────────────────────────────────────────────────────
// Each Lazy holds one Regex. The patterns are written to be anchored on
// word-ish boundaries where possible, and to AVOID over-capturing punctuation.
// False positives are as harmful as false negatives — see ADR 0006.

/// AWS access key id. Prefix `AKIA` + 16 uppercase alphanumerics.
static AWS_ACCESS_KEY_RE: Lazy<Regex> = Lazy::new(|| {
    // Unwrap is acceptable here: the literal is const and unit-tested on
    // the first call (see tests::compile_all_regexes). A compile failure
    // would be caught at test time, not in production.
    Regex::new(r"\bAKIA[0-9A-Z]{16}\b").expect("static AWS access key regex compiles")
});

/// GitHub classic personal access token. `ghp_` + 36 alphanumerics.
static GITHUB_CLASSIC_PAT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bghp_[A-Za-z0-9]{36}\b").expect("static GitHub PAT regex compiles"));

/// GitHub fine-grained PAT. `github_pat_` + 82 base62_.
static GITHUB_FINE_PAT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\bgithub_pat_[A-Za-z0-9_]{82}\b").expect("static GitHub fine-PAT regex compiles")
});

/// Anthropic API key. `sk-ant-` + 90+ base62/-/_.
///
/// NOTE: this rule is ordered before the OpenAI rule in [`TOKEN_RULES`] so
/// it matches first for Anthropic-specific strings (`sk-ant-...`). Without
/// this precedence, the looser `sk-*` pattern would shadow it.
static ANTHROPIC_KEY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\bsk-ant-[A-Za-z0-9_-]{90,}\b").expect("static Anthropic key regex compiles")
});

/// OpenAI API key. `sk-` + 20+ base62. Deliberately loose; pairs with the
/// Anthropic rule that matches first for `sk-ant-` strings.
static OPENAI_KEY_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bsk-[A-Za-z0-9]{20,}\b").expect("static OpenAI key regex compiles"));

/// JWT-shaped token. Three base64url segments separated by `.`.
static JWT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
        .expect("static JWT regex compiles")
});

/// PEM private key header. Catches RSA / EC / OPENSSH / generic.
static PEM_PRIVATE_KEY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----")
        .expect("static PEM regex compiles")
});

/// Stripe secret key. `sk_live_` or `sk_test_` + 24+ base62.
static STRIPE_SECRET_KEY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\bsk_(live|test)_[A-Za-z0-9]{24,}\b").expect("static Stripe regex compiles")
});

/// Google API key. `AIza` + 35 chars base64url-ish.
static GOOGLE_API_KEY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\bAIza[0-9A-Za-z_-]{35}\b").expect("static Google API key regex compiles")
});

/// Token rule table. Ordered: more specific patterns (like `sk-ant-`) come
/// BEFORE broader ones (`sk-`) so overlap resolution keeps the tighter class.
pub(crate) static TOKEN_RULES: Lazy<Vec<TokenRule>> = Lazy::new(|| {
    vec![
        TokenRule {
            id: "aws_access_key",
            pattern_description: "AWS access key id (AKIA…)",
            compiled: &AWS_ACCESS_KEY_RE,
        },
        TokenRule {
            id: "github_classic_pat",
            pattern_description: "GitHub classic PAT (ghp_…)",
            compiled: &GITHUB_CLASSIC_PAT_RE,
        },
        TokenRule {
            id: "github_fine_pat",
            pattern_description: "GitHub fine-grained PAT (github_pat_…)",
            compiled: &GITHUB_FINE_PAT_RE,
        },
        TokenRule {
            id: "anthropic_api_key",
            pattern_description: "Anthropic API key (sk-ant-…)",
            compiled: &ANTHROPIC_KEY_RE,
        },
        TokenRule {
            id: "openai_api_key",
            pattern_description: "OpenAI-shaped key (sk-…)",
            compiled: &OPENAI_KEY_RE,
        },
        TokenRule {
            id: "jwt",
            pattern_description: "JWT-shaped token (eyJ…)",
            compiled: &JWT_RE,
        },
        TokenRule {
            id: "pem_private_key",
            pattern_description: "PEM private key header",
            compiled: &PEM_PRIVATE_KEY_RE,
        },
        TokenRule {
            id: "stripe_secret_key",
            pattern_description: "Stripe sk_live_ / sk_test_ key",
            compiled: &STRIPE_SECRET_KEY_RE,
        },
        TokenRule {
            id: "google_api_key",
            pattern_description: "Google API key (AIza…)",
            compiled: &GOOGLE_API_KEY_RE,
        },
    ]
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compile_all_regexes() {
        // Force Lazy initialization early — catches a typo in a static
        // pattern at test time, not when production output touches it.
        for rule in TOKEN_RULES.iter() {
            // Smoke: the regex can produce a finder.
            let _ = rule.regex().is_match("");
        }
    }

    #[test]
    fn aws_access_key_matches_sample() {
        let re = &AWS_ACCESS_KEY_RE;
        assert!(re.is_match("AKIAIOSFODNN7EXAMPLE"));
        assert!(!re.is_match("AKIAshort"));
    }

    #[test]
    fn github_classic_pat_matches() {
        let re = &GITHUB_CLASSIC_PAT_RE;
        let sample = format!("ghp_{}", "a".repeat(36));
        assert!(re.is_match(&sample));
    }

    #[test]
    fn github_fine_pat_matches() {
        let re = &GITHUB_FINE_PAT_RE;
        let sample = format!("github_pat_{}", "A".repeat(82));
        assert!(re.is_match(&sample));
    }

    #[test]
    fn anthropic_key_matches() {
        let re = &ANTHROPIC_KEY_RE;
        let sample = format!("sk-ant-{}", "a".repeat(95));
        assert!(re.is_match(&sample));
    }

    #[test]
    fn openai_key_matches() {
        let re = &OPENAI_KEY_RE;
        let sample = format!("sk-{}", "X".repeat(30));
        assert!(re.is_match(&sample));
    }

    #[test]
    fn jwt_matches() {
        let re = &JWT_RE;
        let sample = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcDEF_123-xyz";
        assert!(re.is_match(sample));
    }

    #[test]
    fn pem_matches() {
        let re = &PEM_PRIVATE_KEY_RE;
        assert!(re.is_match("-----BEGIN RSA PRIVATE KEY-----"));
        assert!(re.is_match("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(re.is_match("-----BEGIN PRIVATE KEY-----"));
    }

    #[test]
    fn stripe_matches() {
        let re = &STRIPE_SECRET_KEY_RE;
        let sample = format!("sk_live_{}", "a".repeat(24));
        assert!(re.is_match(&sample));
    }

    #[test]
    fn google_api_key_matches() {
        let re = &GOOGLE_API_KEY_RE;
        let sample = format!("AIza{}", "a".repeat(35));
        assert!(re.is_match(&sample));
    }
}
