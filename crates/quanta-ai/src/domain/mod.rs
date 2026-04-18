//! Domain types for the AI suggestion flow.
//!
//! Pure module: no IO, no async, no regex. This layer defines the vocabulary
//! ports + adapters speak.
//!
//! # Tier mapping (ADR 0012 → approval gate)
//!
//! ADR 0012 defines five classification levels (`safe_readonly`,
//! `workspace_write`, `system_mutation`, `network_external`, `destructive`).
//! The Phase-5 approval gate only branches four ways — "run without prompt",
//! "press Enter to confirm", "type to confirm", "not allowed". The
//! [`RiskTier`] in this crate collapses the five ADR levels into those four
//! buckets. The mapping is exact and monotonic:
//!
//! | ADR 0012 level     | `RiskTier`    |
//! |--------------------|---------------|
//! | `safe_readonly`    | `Safe`        |
//! | `workspace_write`  | `Caution`     |
//! | `system_mutation`  | `Caution`     |
//! | `network_external` | `Caution`     |
//! | `destructive`      | `Destructive` |
//!
//! [`RiskTier::Blocked`] is a UI-level terminal state that cannot be reached
//! by composition alone: only the adapter's hard-deny rules (e.g. writes to
//! `/dev/sd*`, `mkfs`, `dd of=…`) can produce it. The ADR's `destructive`
//! level alone maps to `Destructive` (typed-to-confirm); `Blocked` is the
//! "refuse even with override" bucket.

use serde::{Deserialize, Serialize};

/// Current classifier ruleset version.
///
/// Bump this whenever a rule in [`crate::adapters::HeuristicClassifier`] is
/// added, removed, or semantically changed. Classified commands carry this
/// value so persisted approvals can be audited against the classifier that
/// produced them (ADR 0012 §Ruleset Versioning).
pub const RULESET_VERSION: u32 = 1;

/// The four review buckets the approval UI branches on.
///
/// Ordering is low → high so `max(a, b)` composes per ADR 0012 §Pipeline
/// Composition Rule: the riskier operand wins, always.
///
/// See the module docs for the exact ADR-0012 tier mapping.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskTier {
    /// Allowlisted read-only command. Runs on first Enter.
    Safe,
    /// Mutating but reversible, or unknown-parse. Single Enter to confirm.
    Caution,
    /// Irreversible mutation. User must type the exact command to confirm.
    Destructive,
    /// Hard-denied pattern. Cannot be executed even with override.
    Blocked,
}

impl RiskTier {
    /// Human-readable snake-case label. Stable across versions; used by the
    /// UI and any audit log that persists a tier.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            RiskTier::Safe => "safe",
            RiskTier::Caution => "caution",
            RiskTier::Destructive => "destructive",
            RiskTier::Blocked => "blocked",
        }
    }

    /// Escalate by one tier, saturating at [`RiskTier::Blocked`].
    ///
    /// ADR 0012: modifiers cap at `destructive`. We additionally saturate at
    /// `Blocked` because our approval UI has no higher bucket.
    #[must_use]
    pub const fn escalate(self) -> Self {
        match self {
            RiskTier::Safe => RiskTier::Caution,
            RiskTier::Caution => RiskTier::Destructive,
            RiskTier::Destructive | RiskTier::Blocked => RiskTier::Blocked,
        }
    }

    /// Whether the tier requires any approval at all before execution.
    #[must_use]
    pub const fn requires_approval(self) -> bool {
        !matches!(self, RiskTier::Safe)
    }

    /// Whether execution is forbidden regardless of user override.
    #[must_use]
    pub const fn is_blocked(self) -> bool {
        matches!(self, RiskTier::Blocked)
    }
}

/// An escalation modifier fired by the classifier. Each carries a
/// human-readable reason so the approval UI can show "system_mutation
/// because: sudo prefix; recursive glob" per ADR 0012 §Approval Gate Mapping.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskModifier {
    /// `sudo` or `doas` prefix — +1 tier, system_mutation floor.
    SudoPrefix,
    /// `-r`, `-R`, or `--recursive` on a mutating command.
    Recursion,
    /// Trailing `&` (backgrounding).
    Backgrounding,
    /// Pipe into a shell (`… | sh`, `… | bash`).
    PipeToShell,
    /// Parse failed or the command shape is unrecognized.
    ParseUnknown,
    /// Network-sourced executable (`curl URL | sh`, `wget -O- | bash`).
    NetworkSourcedExec,
    /// Redirection targets a device node (`/dev/sd*`, `/dev/disk*`).
    RedirectToDevice,
    /// `chmod 777` on a root path (`/`, `/etc`, `/usr`, …).
    ChmodWorldOnRoot,
    /// Known-destructive verb (`rm -rf`, `mkfs`, `dd`, …).
    DestructiveVerb,
    /// Command appears on the Safe allowlist. Emitted for observability; does
    /// not itself change the tier.
    AllowlistMatch,
}

impl RiskModifier {
    /// Stable snake-case label for UI rendering and persistence.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            RiskModifier::SudoPrefix => "sudo_prefix",
            RiskModifier::Recursion => "recursion",
            RiskModifier::Backgrounding => "backgrounding",
            RiskModifier::PipeToShell => "pipe_to_shell",
            RiskModifier::ParseUnknown => "parse_unknown",
            RiskModifier::NetworkSourcedExec => "network_sourced_exec",
            RiskModifier::RedirectToDevice => "redirect_to_device",
            RiskModifier::ChmodWorldOnRoot => "chmod_world_on_root",
            RiskModifier::DestructiveVerb => "destructive_verb",
            RiskModifier::AllowlistMatch => "allowlist_match",
        }
    }
}

/// Set of modifiers that fired on a single classification.
///
/// A `Vec` with push-if-absent semantics rather than a `HashSet` so the UI
/// can render modifiers in the order they were detected — "sudo prefix" then
/// "recursive glob" reads more naturally than a lexically-sorted set.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RiskFlags {
    modifiers: Vec<RiskModifier>,
}

impl RiskFlags {
    /// Empty flag set.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            modifiers: Vec::new(),
        }
    }

    /// Add a modifier if not already present. Idempotent.
    pub fn insert(&mut self, m: RiskModifier) {
        if !self.modifiers.contains(&m) {
            self.modifiers.push(m);
        }
    }

    /// Whether the given modifier fired.
    #[must_use]
    pub fn contains(&self, m: RiskModifier) -> bool {
        self.modifiers.contains(&m)
    }

    /// Number of distinct modifiers that fired.
    #[must_use]
    pub fn len(&self) -> usize {
        self.modifiers.len()
    }

    /// Whether no modifiers fired.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.modifiers.is_empty()
    }

    /// Ordered slice of modifiers in the order they were detected.
    #[must_use]
    pub fn as_slice(&self) -> &[RiskModifier] {
        &self.modifiers
    }
}

/// A command that has been through the classifier. Carries both the final
/// tier and the reasons so the approval UI can show both.
///
/// `ruleset_version` pins the ruleset the classification was produced with;
/// downstream audit code compares against the current [`RULESET_VERSION`]
/// to decide whether historical approvals need a re-review (ADR 0012
/// §Ruleset Versioning).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClassifiedCommand {
    /// The raw command string exactly as classified. No normalization — the
    /// approval UI displays this verbatim.
    pub command: String,
    pub tier: RiskTier,
    pub flags: RiskFlags,
    pub ruleset_version: u32,
}

impl ClassifiedCommand {
    /// Construct with the current [`RULESET_VERSION`].
    #[must_use]
    pub fn new(command: impl Into<String>, tier: RiskTier, flags: RiskFlags) -> Self {
        Self {
            command: command.into(),
            tier,
            flags,
            ruleset_version: RULESET_VERSION,
        }
    }

    /// Convenience: whether this command needs any confirmation surface.
    #[must_use]
    pub fn requires_approval(&self) -> bool {
        self.tier.requires_approval()
    }

    /// Convenience: whether execution is forbidden regardless of override.
    #[must_use]
    pub fn is_blocked(&self) -> bool {
        self.tier.is_blocked()
    }
}

/// A stable id for a [`SuggestionResponse`]. The UI uses this to correlate an
/// approval decision with the suggestion that produced it.
pub type SuggestionId = String;

/// Input to [`crate::SuggestionProvider::suggest`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestionRequest {
    /// Natural-language prompt the user typed (Command Palette "Ask AI" mode)
    /// or the partial command the inline completion is riffing on.
    pub prompt: String,
    /// Optional working-directory hint the provider may use to shape the
    /// suggestion. The classifier does NOT use this.
    pub cwd: Option<String>,
}

impl SuggestionRequest {
    /// Construct from a plain prompt. `cwd` defaults to `None`.
    #[must_use]
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            cwd: None,
        }
    }
}

/// Output from [`crate::SuggestionProvider::suggest`].
///
/// Always carries a [`ClassifiedCommand`] — the provider is responsible for
/// asking the classifier before returning. This keeps the approval UI from
/// having to remember to classify: a suggestion that reaches the UI is always
/// already classified.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestionResponse {
    pub id: SuggestionId,
    pub classified: ClassifiedCommand,
    /// Short rationale shown under the suggestion in the UI. Optional — a
    /// mock provider might omit it, a richer provider might attach diff
    /// previews here in a later phase.
    pub rationale: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_ordering_monotonic() {
        assert!(RiskTier::Safe < RiskTier::Caution);
        assert!(RiskTier::Caution < RiskTier::Destructive);
        assert!(RiskTier::Destructive < RiskTier::Blocked);
    }

    #[test]
    fn tier_escalate_saturates() {
        assert_eq!(RiskTier::Safe.escalate(), RiskTier::Caution);
        assert_eq!(RiskTier::Caution.escalate(), RiskTier::Destructive);
        assert_eq!(RiskTier::Destructive.escalate(), RiskTier::Blocked);
        assert_eq!(RiskTier::Blocked.escalate(), RiskTier::Blocked);
    }

    #[test]
    fn risk_flags_is_set_like() {
        let mut f = RiskFlags::new();
        f.insert(RiskModifier::SudoPrefix);
        f.insert(RiskModifier::SudoPrefix);
        f.insert(RiskModifier::Recursion);
        assert_eq!(f.len(), 2);
        assert!(f.contains(RiskModifier::SudoPrefix));
        assert!(f.contains(RiskModifier::Recursion));
        assert!(!f.contains(RiskModifier::Backgrounding));
    }

    #[test]
    fn risk_flags_preserves_insertion_order() {
        let mut f = RiskFlags::new();
        f.insert(RiskModifier::Recursion);
        f.insert(RiskModifier::SudoPrefix);
        assert_eq!(
            f.as_slice(),
            &[RiskModifier::Recursion, RiskModifier::SudoPrefix]
        );
    }

    #[test]
    fn requires_approval_matches_tier() {
        assert!(!RiskTier::Safe.requires_approval());
        assert!(RiskTier::Caution.requires_approval());
        assert!(RiskTier::Destructive.requires_approval());
        assert!(RiskTier::Blocked.requires_approval());
    }

    #[test]
    fn is_blocked_only_true_for_blocked() {
        assert!(!RiskTier::Safe.is_blocked());
        assert!(!RiskTier::Caution.is_blocked());
        assert!(!RiskTier::Destructive.is_blocked());
        assert!(RiskTier::Blocked.is_blocked());
    }

    #[test]
    fn classified_command_carries_ruleset_version() {
        let c = ClassifiedCommand::new("ls", RiskTier::Safe, RiskFlags::new());
        assert_eq!(c.ruleset_version, RULESET_VERSION);
        assert_eq!(c.command, "ls");
    }

    #[test]
    fn tier_label_stable() {
        assert_eq!(RiskTier::Safe.label(), "safe");
        assert_eq!(RiskTier::Caution.label(), "caution");
        assert_eq!(RiskTier::Destructive.label(), "destructive");
        assert_eq!(RiskTier::Blocked.label(), "blocked");
    }
}
