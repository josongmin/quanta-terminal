//! Mock suggestion provider — canned, deterministic, offline.
//!
//! Phase 5 intentionally ships no LLM. The UI needs a provider-shaped thing
//! to wire against, and every higher layer needs a predictable fixture to
//! test against. This adapter satisfies both and is what the Tauri IPC glue
//! delegates to today.
//!
//! The mock chooses a canned command by matching keywords in the prompt.
//! The full table lives in [`suggestion_for_prompt`] — adding a new fixture
//! is a one-liner and every fixture gets classified via the caller-provided
//! [`crate::RiskClassifier`], so the tier is always fresh against the
//! current ruleset.

use std::sync::Arc;

use async_trait::async_trait;

use crate::adapters::HeuristicClassifier;
use crate::domain::{SuggestionRequest, SuggestionResponse};
use crate::ports::{RiskClassifier, SuggestionProvider, SuggestionProviderError};

/// Deterministic canned-suggestion provider. Thread-safe; the classifier is
/// held as an `Arc<dyn …>` so tests can swap in alternates.
#[derive(Clone, Debug)]
pub struct MockProvider {
    classifier: Arc<dyn RiskClassifier>,
}

impl MockProvider {
    /// Construct with the default [`HeuristicClassifier`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            classifier: Arc::new(HeuristicClassifier::new()),
        }
    }

    /// Construct with a caller-supplied classifier. Lets tests inject
    /// deterministic alternates (e.g. a classifier that always returns
    /// `Blocked`) without binding to the heuristic implementation.
    #[must_use]
    pub fn with_classifier(classifier: Arc<dyn RiskClassifier>) -> Self {
        Self { classifier }
    }
}

impl Default for MockProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SuggestionProvider for MockProvider {
    async fn suggest(
        &self,
        request: SuggestionRequest,
    ) -> Result<SuggestionResponse, SuggestionProviderError> {
        let prompt = request.prompt.trim();
        if prompt.is_empty() {
            return Err(SuggestionProviderError::InvalidPrompt(
                "prompt is empty".into(),
            ));
        }

        let (id, command, rationale) = suggestion_for_prompt(prompt);
        let classified = self.classifier.classify(command);
        Ok(SuggestionResponse {
            id: id.to_string(),
            classified,
            rationale: Some(rationale.to_string()),
        })
    }
}

/// Deterministic prompt → canned command mapping.
///
/// The table is intentionally small and easy to audit. Matching is
/// case-insensitive substring. The default fallback is a read-only `ls`.
/// Every returned command flows through the classifier before reaching the
/// UI, so risk labels always match the current ruleset.
#[must_use]
pub fn suggestion_for_prompt(prompt: &str) -> (&'static str, &'static str, &'static str) {
    let p = prompt.to_ascii_lowercase();
    // Checked in declaration order — first match wins. Keep the most specific
    // matches at the top.
    if p.contains("delete") && p.contains("everything") {
        return (
            "mock-rm-rf-root",
            "rm -rf /",
            "Mocked: the classifier blocks this command; it is returned only so the UI can surface a Blocked tier.",
        );
    }
    if p.contains("recursive") && p.contains("delete") {
        return (
            "mock-rm-recursive",
            "rm -rf ./build",
            "Mocked: recursive delete of the build directory.",
        );
    }
    if p.contains("install") && p.contains("script") {
        return (
            "mock-curl-pipe-sh",
            "curl -fsSL https://example.com/install.sh | sh",
            "Mocked: network-sourced exec. Review carefully before approving.",
        );
    }
    if p.contains("background") || p.contains("run in bg") {
        return (
            "mock-background-build",
            "npm run build &",
            "Mocked: backgrounded build. Fire-and-forget hides failures.",
        );
    }
    if p.contains("status") || p.contains("git status") {
        return (
            "mock-git-status",
            "git status",
            "Mocked: show repository status.",
        );
    }
    if p.contains("log") {
        return (
            "mock-git-log",
            "git log --oneline -n 20",
            "Mocked: last 20 commits.",
        );
    }
    if p.contains("disk") && p.contains("usage") {
        return ("mock-du", "du -sh ./*", "Mocked: disk usage summary.");
    }
    if p.contains("permissions") && p.contains("fix") {
        return (
            "mock-chmod-777",
            "chmod 777 /",
            "Mocked: the classifier blocks this command; returned only so the UI can show a Blocked tier.",
        );
    }
    if p.contains("sudo") {
        return (
            "mock-sudo-ls",
            "sudo ls /root",
            "Mocked: sudo-prefixed read. The classifier escalates per ADR 0012.",
        );
    }
    (
        "mock-ls",
        "ls -la",
        "Mocked: list files (default fallback).",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_classified_command_for_default_prompt() {
        let p = MockProvider::new();
        let r = p
            .suggest(SuggestionRequest::new("show me files"))
            .await
            .expect("mock should succeed");
        assert_eq!(r.classified.command, "ls -la");
        assert!(!r.classified.tier.requires_approval());
    }

    #[tokio::test]
    async fn returns_blocked_for_delete_everything() {
        let p = MockProvider::new();
        let r = p
            .suggest(SuggestionRequest::new("please delete everything"))
            .await
            .expect("mock should succeed");
        assert!(r.classified.is_blocked());
    }

    #[tokio::test]
    async fn empty_prompt_rejected() {
        let p = MockProvider::new();
        let e = p
            .suggest(SuggestionRequest::new("   "))
            .await
            .expect_err("empty prompt must be rejected");
        assert!(matches!(e, SuggestionProviderError::InvalidPrompt(_)));
    }

    #[tokio::test]
    async fn deterministic_across_calls() {
        let p = MockProvider::new();
        let a = p
            .suggest(SuggestionRequest::new("git status"))
            .await
            .unwrap();
        let b = p
            .suggest(SuggestionRequest::new("git status"))
            .await
            .unwrap();
        assert_eq!(a.classified.command, b.classified.command);
        assert_eq!(a.classified.tier, b.classified.tier);
        assert_eq!(a.id, b.id);
    }
}
