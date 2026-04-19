//! Ports — traits the UI/host bind to.
//!
//! Implementations live in `adapters/`. Callers should depend on the port so
//! test rigs can inject mocks or alternative providers (Phase 6 LLM adapter
//! plugs in here).

use async_trait::async_trait;

use crate::domain::{ClassifiedCommand, SuggestionRequest, SuggestionResponse};

/// Deterministic, sync, pure: classify a raw shell command string into a
/// tier + modifier set.
///
/// The classifier is intentionally synchronous and non-async. Per ADR 0012
/// §Determinism and Testing it is a pure function of the input and the
/// ruleset version; async plumbing would hide that fact behind a future.
pub trait RiskClassifier: Send + Sync + std::fmt::Debug {
    /// Classify a raw shell command. Never fails — a parse-unknown command is
    /// still classified (with the `ParseUnknown` modifier and at least
    /// [`crate::RiskTier::Caution`] per ADR 0012 §Parse-Unknown Handling).
    fn classify(&self, command: &str) -> ClassifiedCommand;

    /// Ruleset version this classifier was built against. Matches the
    /// `ruleset_version` stamped on returned [`ClassifiedCommand`]s.
    fn ruleset_version(&self) -> u32;
}

/// Errors a [`SuggestionProvider`] can return.
///
/// Variants are deliberately coarse-grained: each one maps to a distinct UI
/// treatment (toast copy, retry semantics). The `Auth`, `RateLimit`, `Server`,
/// `Network`, `Timeout`, and `Parse` variants were added for the Phase-6
/// Anthropic adapter; mock-style providers only ever emit `InvalidPrompt`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SuggestionProviderError {
    /// The provider rejected the prompt (empty, too long, policy-violation).
    InvalidPrompt(String),
    /// Generic unavailability (legacy variant). New adapters should prefer
    /// the more specific `Network` / `Server` / `Timeout` variants.
    Unavailable(String),
    /// Provider-specific failure with a human-readable message.
    Internal(String),
    /// HTTP 401 / 403 — API key missing, revoked, or not authorized.
    Auth(String),
    /// HTTP 429 — rate limit or quota exceeded. UI should back off.
    RateLimit(String),
    /// HTTP 5xx — transient upstream failure. Safe to retry.
    Server(String),
    /// Network-layer failure (DNS, TLS, connection reset).
    Network(String),
    /// Request exceeded the adapter's hard timeout cap.
    Timeout(String),
    /// Response body could not be parsed into the expected shape.
    Parse(String),
}

impl std::fmt::Display for SuggestionProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SuggestionProviderError::InvalidPrompt(m) => write!(f, "invalid prompt: {m}"),
            SuggestionProviderError::Unavailable(m) => write!(f, "provider unavailable: {m}"),
            SuggestionProviderError::Internal(m) => write!(f, "provider error: {m}"),
            SuggestionProviderError::Auth(m) => write!(f, "provider auth error: {m}"),
            SuggestionProviderError::RateLimit(m) => write!(f, "provider rate limited: {m}"),
            SuggestionProviderError::Server(m) => write!(f, "provider server error: {m}"),
            SuggestionProviderError::Network(m) => write!(f, "provider network error: {m}"),
            SuggestionProviderError::Timeout(m) => write!(f, "provider timeout: {m}"),
            SuggestionProviderError::Parse(m) => write!(f, "provider parse error: {m}"),
        }
    }
}

impl std::error::Error for SuggestionProviderError {}

/// Async port: turn a natural-language prompt into a classified suggestion.
///
/// Phase 5 ships exactly one adapter: [`crate::MockProvider`] returning
/// deterministic canned suggestions. A Phase-6 adapter will call a real LLM.
/// Every provider MUST classify the command before returning — that invariant
/// is what lets the UI treat "a suggestion exists" as "the suggestion is
/// already risk-tagged".
#[async_trait]
pub trait SuggestionProvider: Send + Sync + std::fmt::Debug {
    /// Produce a single suggestion for `request`. Providers that want to
    /// return multiple candidates should pick the top one deterministically
    /// so the UI never shows a moving target between frames.
    async fn suggest(
        &self,
        request: SuggestionRequest,
    ) -> Result<SuggestionResponse, SuggestionProviderError>;
}
