//! Heuristic classifier — the Phase-5 rule table.
//!
//! Boring by design (ADR 0012 §Consequences). The rules here are small,
//! additive, and monotonic. A parse failure can only escalate a command; it
//! can never demote one. The pipeline composition rule (`max` of component
//! tiers) is implemented by iterating over pipeline segments and keeping the
//! highest seen tier.
//!
//! # Rule order (matches ADR 0012 §Classification Stage Order)
//!
//! 1. Split the command on top-level `|` (pipeline segments). The split is
//!    simplistic: we do not honor quoted pipes because a shell AST is out of
//!    scope for Phase 5. When the simple split produces an ambiguous result
//!    the `ParseUnknown` modifier fires and the tier floor becomes
//!    [`crate::RiskTier::Caution`] per ADR §Parse-Unknown Handling.
//! 2. For each segment: tokenize on whitespace, base-classify by verb,
//!    hard-deny if a Blocked pattern matches, otherwise seed the segment
//!    tier from the base classification.
//! 3. Accumulate modifiers: sudo prefix, recursion flag, trailing `&`, pipe
//!    into shell, curl/wget pipe, redirect to device, chmod 777 on a root.
//! 4. Compose: tier = max over segments, then apply each fired modifier as
//!    `tier.escalate()` once. Order of modifier application does not matter
//!    because `escalate` is monotonic.
//!
//! The tokenizer is line-noise whitespace splitting: quotes and escapes are
//! not parsed. Good enough for Phase 5 — every edge case surfaces as a
//! `ParseUnknown` that escalates rather than demotes.

use crate::domain::{ClassifiedCommand, RiskFlags, RiskModifier, RiskTier, RULESET_VERSION};
use crate::ports::RiskClassifier;

/// The Phase-5 heuristic classifier. Stateless.
#[derive(Clone, Copy, Debug, Default)]
pub struct HeuristicClassifier;

impl HeuristicClassifier {
    /// Construct. Equivalent to `Default::default()`.
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

impl RiskClassifier for HeuristicClassifier {
    fn classify(&self, command: &str) -> ClassifiedCommand {
        let raw = command;
        let trimmed = raw.trim();
        let mut flags = RiskFlags::new();

        // Empty input: nothing to run. Treat as Caution with ParseUnknown
        // because no allowlist match justifies Safe and the UI should still
        // gate on an empty suggestion rather than silently succeed.
        if trimmed.is_empty() {
            flags.insert(RiskModifier::ParseUnknown);
            return ClassifiedCommand {
                command: raw.to_string(),
                tier: RiskTier::Caution,
                flags,
                ruleset_version: RULESET_VERSION,
            };
        }

        // Trailing `&` is detected on the whole command so `ls &` still
        // escalates even though `&` is its own token. Strip it before
        // segment splitting so the rest of the pipeline parses cleanly.
        let (stripped, is_backgrounded) = strip_trailing_background(trimmed);
        if is_backgrounded {
            flags.insert(RiskModifier::Backgrounding);
        }

        // Reject obviously-malformed shapes before segment splitting. These
        // produce ParseUnknown immediately so the floor stays ≥ Caution
        // regardless of what the recognizer would otherwise classify.
        let is_parse_unknown_shape = has_suspicious_shape(stripped);
        if is_parse_unknown_shape {
            flags.insert(RiskModifier::ParseUnknown);
        }

        // Pipeline split. A segment is a run of tokens between top-level `|`.
        // We purposely do not honor quoted pipes — see module docs.
        let segments: Vec<&str> = stripped
            .split('|')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();

        let mut composed_tier = RiskTier::Safe;
        let mut saw_any_segment = false;

        for segment in &segments {
            saw_any_segment = true;
            let seg_tier = classify_segment(segment, &mut flags);
            if seg_tier > composed_tier {
                composed_tier = seg_tier;
            }
        }

        if !saw_any_segment {
            // No segments parsed out of a non-empty input — shape was funky
            // (e.g. all pipes). Treat as ParseUnknown, Caution floor.
            flags.insert(RiskModifier::ParseUnknown);
            composed_tier = RiskTier::Caution;
        }

        // ADR 0012 §Pipeline Composition Rule: `curl URL | sh` is the
        // canonical network-sourced exec pattern. We detect it explicitly
        // because the left side alone is only `Caution` (network) and the
        // right is `Safe` (sh is allowlisted). The combination is
        // Destructive — a value the segment-wise max misses.
        if is_pipe_to_shell(&segments) {
            flags.insert(RiskModifier::PipeToShell);
            if mentions_network_fetcher(&segments) {
                flags.insert(RiskModifier::NetworkSourcedExec);
                // NetworkSourcedExec on its own means this is Destructive
                // per the task spec "curl ... | sh → Destructive".
                if composed_tier < RiskTier::Destructive {
                    composed_tier = RiskTier::Destructive;
                }
            } else {
                // Piping to a shell without a network fetch is still one
                // tier hotter than the max segment.
                composed_tier = composed_tier.escalate();
            }
        }

        // Parse-unknown floor per ADR 0012. Floor-only: never demote.
        if is_parse_unknown_shape && composed_tier < RiskTier::Caution {
            composed_tier = RiskTier::Caution;
        }

        // Apply escalation modifiers.
        if flags.contains(RiskModifier::SudoPrefix) {
            composed_tier = composed_tier.escalate();
        }
        if flags.contains(RiskModifier::Recursion) {
            composed_tier = composed_tier.escalate();
        }
        if flags.contains(RiskModifier::Backgrounding) {
            composed_tier = composed_tier.escalate();
        }

        ClassifiedCommand {
            command: raw.to_string(),
            tier: composed_tier,
            flags,
            ruleset_version: RULESET_VERSION,
        }
    }

    fn ruleset_version(&self) -> u32 {
        RULESET_VERSION
    }
}

/// Remove a trailing `&` (possibly surrounded by whitespace). Returns the
/// stripped command plus a bool indicating whether `&` was present.
fn strip_trailing_background(s: &str) -> (&str, bool) {
    let t = s.trim_end();
    if let Some(stripped) = t.strip_suffix('&') {
        // Guard against `&&` (logical AND) which is NOT backgrounding.
        if stripped.ends_with('&') {
            return (s, false);
        }
        return (stripped.trim_end(), true);
    }
    (s, false)
}

/// Classify a single pipeline segment. Mutates `flags` in place so per-segment
/// modifiers (recursion, chmod, destructive verb, …) accumulate across the
/// whole pipeline.
fn classify_segment(segment: &str, flags: &mut RiskFlags) -> RiskTier {
    let tokens: Vec<&str> = segment.split_whitespace().collect();
    if tokens.is_empty() {
        flags.insert(RiskModifier::ParseUnknown);
        return RiskTier::Caution;
    }

    // sudo / doas prefix — advance past it and mark the modifier. Per ADR
    // 0012 the prefix sets a system_mutation floor; the +1 escalation
    // happens once at the end, not per segment.
    let mut cursor = 0usize;
    if matches!(tokens[0], "sudo" | "doas") {
        flags.insert(RiskModifier::SudoPrefix);
        cursor = 1;
        // Swallow `sudo -u foo`, `sudo -E`, etc. Any `-X` after sudo is a
        // flag to sudo, not to the underlying command.
        while cursor < tokens.len() && tokens[cursor].starts_with('-') {
            cursor += 1;
            // `sudo -u USER` — consume the arg too.
            if cursor <= tokens.len()
                && cursor > 0
                && matches!(tokens[cursor - 1], "-u" | "-g" | "-p")
                && cursor < tokens.len()
            {
                cursor += 1;
            }
        }
    }

    let verb = tokens.get(cursor).copied().unwrap_or("");
    if verb.is_empty() {
        flags.insert(RiskModifier::ParseUnknown);
        return RiskTier::Caution;
    }

    // Hard-deny patterns → Blocked. Evaluated first because nothing downstream
    // should be able to talk them down.
    if is_blocked_pattern(verb, &tokens[cursor..]) {
        // Stamp modifiers that contributed so the UI can explain why.
        if matches!(verb, "dd" | "mkfs") || is_mkfs_family(verb) {
            flags.insert(RiskModifier::DestructiveVerb);
        }
        if has_redirect_to_device(&tokens[cursor..]) {
            flags.insert(RiskModifier::RedirectToDevice);
        }
        if is_chmod_world_on_root(&tokens[cursor..]) {
            flags.insert(RiskModifier::ChmodWorldOnRoot);
        }
        return RiskTier::Blocked;
    }

    // Destructive verbs (not outright blocked, but irreversible).
    if is_destructive_verb(verb, &tokens[cursor..]) {
        flags.insert(RiskModifier::DestructiveVerb);
        if has_recursion_flag(&tokens[cursor..]) {
            flags.insert(RiskModifier::Recursion);
        }
        return RiskTier::Destructive;
    }

    // Recursion flag on a non-destructive verb still escalates.
    if has_recursion_flag(&tokens[cursor..]) {
        flags.insert(RiskModifier::Recursion);
    }

    // Safe allowlist — read-only commands and explicitly-read-only git
    // subcommands (`git status`, `git log`, `git diff`, `git branch`).
    if is_on_allowlist(&tokens[cursor..]) {
        flags.insert(RiskModifier::AllowlistMatch);
        return RiskTier::Safe;
    }

    // Network fetchers — curl/wget naked (not yet piped). Caution tier.
    if matches!(verb, "curl" | "wget" | "ssh" | "scp" | "rsync") {
        return RiskTier::Caution;
    }

    // Unknown verb → Caution (ParseUnknown); ADR 0012 floor-only.
    flags.insert(RiskModifier::ParseUnknown);
    RiskTier::Caution
}

/// Extremely conservative "is this segment completely bogus?" check. Covers
/// obvious malformed shapes — nothing but punctuation, starts with a redirect,
/// contains NUL, etc. Any positive hit raises the parse-unknown floor.
fn has_suspicious_shape(s: &str) -> bool {
    if s.contains('\0') {
        return true;
    }
    let trimmed = s.trim();
    if trimmed.starts_with('|') || trimmed.starts_with('&') || trimmed.ends_with('|') {
        return true;
    }
    false
}

/// Hard-deny patterns: execution forbidden even with override.
fn is_blocked_pattern(verb: &str, tokens: &[&str]) -> bool {
    // rm -rf / and variants. We treat rm on a root-like target as Blocked so
    // "rm -rf /" (and its cousins) cannot be executed at all.
    if verb == "rm" && has_recursion_flag(tokens) && has_root_path(tokens) {
        return true;
    }

    // dd with device-level of=
    if verb == "dd" && has_device_output(tokens) {
        return true;
    }

    // mkfs family — filesystem creation is Blocked.
    if is_mkfs_family(verb) {
        return true;
    }

    // Any redirect to /dev/sd* or /dev/disk*.
    if has_redirect_to_device(tokens) {
        return true;
    }

    // chmod 777 on a root path.
    if is_chmod_world_on_root(tokens) {
        return true;
    }

    false
}

fn is_mkfs_family(verb: &str) -> bool {
    verb == "mkfs" || verb.starts_with("mkfs.")
}

/// True if any token is a raw device-like redirection target. Covers the
/// space-separated form `> /dev/sda` by matching on any token that begins
/// with `/dev/sd` or `/dev/disk`.
fn has_redirect_to_device(tokens: &[&str]) -> bool {
    let mut saw_redirect = false;
    for t in tokens {
        if *t == ">" || *t == ">>" {
            saw_redirect = true;
            continue;
        }
        if saw_redirect && is_device_path(t) {
            return true;
        }
        if let Some(rest) = t.strip_prefix('>') {
            // Glued form `>/dev/sda` — we still want to catch this.
            if is_device_path(rest) {
                return true;
            }
        }
        saw_redirect = false;
    }
    false
}

fn is_device_path(s: &str) -> bool {
    s.starts_with("/dev/sd") || s.starts_with("/dev/disk") || s.starts_with("/dev/nvme")
}

fn has_device_output(tokens: &[&str]) -> bool {
    tokens.iter().any(|t| {
        t.strip_prefix("of=")
            .is_some_and(|rest| is_device_path(rest) || rest.starts_with("/dev/"))
    })
}

fn is_chmod_world_on_root(tokens: &[&str]) -> bool {
    // Need: verb chmod, 777 mode, root-ish target.
    let mut iter = tokens.iter().copied().peekable();
    let first = iter.next().unwrap_or("");
    if first != "chmod" {
        return false;
    }
    let mut has_777 = false;
    let mut has_root = false;
    for t in iter {
        if t == "777" {
            has_777 = true;
        } else if !t.starts_with('-') && is_root_path(t) {
            has_root = true;
        }
    }
    has_777 && has_root
}

fn is_root_path(s: &str) -> bool {
    matches!(
        s,
        "/" | "/etc" | "/usr" | "/var" | "/bin" | "/sbin" | "/lib"
    ) || s.starts_with("/etc/")
        || s.starts_with("/usr/")
        || s.starts_with("/var/")
        || s.starts_with("/System")
        || s.starts_with("/Library")
}

fn has_root_path(tokens: &[&str]) -> bool {
    tokens.iter().any(|t| is_root_path(t))
}

fn is_destructive_verb(verb: &str, tokens: &[&str]) -> bool {
    matches!(verb, "rm" | "dd" | "shred")
        || (verb == "git" && is_destructive_git(tokens))
        || matches!(verb, "kubectl") && tokens.contains(&"delete")
}

fn is_destructive_git(tokens: &[&str]) -> bool {
    // `git reset --hard`, `git clean -f`, force push.
    let has = |needle: &str| tokens.contains(&needle);
    if has("reset") && has("--hard") {
        return true;
    }
    if has("clean") && (has("-f") || has("--force") || has("-fd")) {
        return true;
    }
    if has("push") && (has("--force") || has("-f")) {
        return true;
    }
    false
}

fn has_recursion_flag(tokens: &[&str]) -> bool {
    tokens.iter().any(|t| {
        *t == "-r" || *t == "-R" || *t == "--recursive" || *t == "-rf" || *t == "-Rf" || *t == "-fr"
    })
}

/// Safe allowlist. Covers read-only shell commands and the readonly git
/// subcommands listed in the task spec (`status`, `log`, `diff`, `branch`).
fn is_on_allowlist(tokens: &[&str]) -> bool {
    let Some(verb) = tokens.first() else {
        return false;
    };
    match *verb {
        "ls" | "cat" | "echo" | "pwd" | "cd" | "head" | "tail" | "wc" | "which" | "type"
        | "stat" | "tree" | "printf" | "true" | "false" | "date" | "whoami" | "uname" | "id"
        | "rg" | "grep" | "find" | "man" | "history" | "env" | "sh" | "bash" => {
            // `find` with `-delete` is not safe.
            if *verb == "find" && tokens.contains(&"-delete") {
                return false;
            }
            // `sh`/`bash` are Safe here ONLY as a pipeline terminator for the
            // pipe-to-shell detector to notice; a bare `sh` segment with no
            // input is benign. The composition rule still escalates
            // `curl URL | sh` because of the NetworkSourcedExec modifier.
            true
        }
        "git" => {
            let sub = tokens.get(1).copied().unwrap_or("");
            matches!(sub, "status" | "log" | "diff" | "branch" | "show")
                && !tokens.iter().any(|t| *t == "--delete" || *t == "-D")
        }
        _ => false,
    }
}

fn is_pipe_to_shell(segments: &[&str]) -> bool {
    if segments.len() < 2 {
        return false;
    }
    let last = segments.last().copied().unwrap_or("");
    let first_tok = last.split_whitespace().next().unwrap_or("");
    matches!(first_tok, "sh" | "bash" | "zsh" | "fish")
}

fn mentions_network_fetcher(segments: &[&str]) -> bool {
    segments.iter().any(|seg| {
        // Look past a leading sudo/doas prefix (plus any sudo flags) so
        // `sudo curl URL | sh` still matches. Keep the scan cheap: we only
        // need to know whether `curl`/`wget` appears as the effective verb.
        let mut toks = seg.split_whitespace();
        let mut tok = toks.next().unwrap_or("");
        if matches!(tok, "sudo" | "doas") {
            // Skip sudo's own flags (tokens starting with `-`). The verb
            // we care about is the first non-flag token after sudo.
            loop {
                tok = toks.next().unwrap_or("");
                if !tok.starts_with('-') {
                    break;
                }
            }
        }
        matches!(tok, "curl" | "wget" | "fetch") || tok.starts_with("https://")
    })
}

#[cfg(test)]
mod tests {
    // Unit tests cover a handful of internal helpers. The full classifier
    // corpus lives in `tests/classifier.rs`; this module only needs smoke
    // coverage to catch obvious breakages to the private helpers.
    use super::*;

    #[test]
    fn strip_trailing_background_handles_and_and() {
        assert_eq!(
            strip_trailing_background("ls && echo"),
            ("ls && echo", false)
        );
        assert_eq!(strip_trailing_background("ls &"), ("ls", true));
        assert_eq!(strip_trailing_background("ls "), ("ls ", false));
    }

    #[test]
    fn is_device_path_positive() {
        assert!(is_device_path("/dev/sda"));
        assert!(is_device_path("/dev/sda1"));
        assert!(is_device_path("/dev/disk0"));
        assert!(is_device_path("/dev/nvme0n1"));
        assert!(!is_device_path("/tmp/sda"));
    }

    #[test]
    fn allowlist_rejects_find_delete() {
        assert!(is_on_allowlist(&["find", ".", "-name", "*.log"]));
        assert!(!is_on_allowlist(&["find", ".", "-delete"]));
    }

    #[test]
    fn allowlist_git_readonly_only() {
        assert!(is_on_allowlist(&["git", "status"]));
        assert!(is_on_allowlist(&["git", "log", "--oneline"]));
        assert!(!is_on_allowlist(&["git", "commit", "-m", "x"]));
        assert!(!is_on_allowlist(&["git", "branch", "--delete", "x"]));
    }
}
