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
///
/// # Timing contract
///
/// `suggest()` MUST complete in bounded wall time — a hung provider is a
/// UX and resource-leak concern. In practice:
///
/// - Every implementation SHOULD return a result (success or error) within
///   **2 s median** for interactive UIs. A provider that routinely exceeds
///   this budget is a bug; the UI's "Ask AI" affordance surfaces a
///   loading state but has no backoff strategy for multi-second latencies.
/// - Callers needing a hard deadline MUST use
///   [`SuggestionProvider::suggest_with_timeout`]. If the supplied
///   duration elapses before the provider returns, the adapter MUST
///   surface [`SuggestionProviderError::Timeout`] — not a network error,
///   not a generic unavailability. The `Timeout` variant is what the UI
///   branches on for "try again" copy.
/// - Implementations are free to cap the effective deadline at their own
///   hard ceiling (e.g. the Anthropic adapter enforces a 10 s absolute
///   cap per request). A caller-supplied timeout shorter than that
///   ceiling wins; a longer one is clamped down silently. The net effect
///   is: `actual_deadline = min(caller_supplied, provider_ceiling)`.
///
/// The default `suggest_with_timeout` wraps `suggest` with
/// `tokio::time::timeout`, which is sufficient for adapters whose
/// `suggest` does not itself expose a timeout knob (the MockProvider in
/// particular). Adapters that natively accept a per-request timeout —
/// e.g. `reqwest::Client::timeout` on [`crate::AnthropicProvider`] —
/// SHOULD override for efficiency so the underlying transport can cancel
/// in-flight work instead of racing a spawned task.
#[async_trait]
pub trait SuggestionProvider: Send + Sync + std::fmt::Debug {
    /// Produce a single suggestion for `request`. Providers that want to
    /// return multiple candidates should pick the top one deterministically
    /// so the UI never shows a moving target between frames.
    async fn suggest(
        &self,
        request: SuggestionRequest,
    ) -> Result<SuggestionResponse, SuggestionProviderError>;

    /// Produce a suggestion with a caller-supplied hard timeout. Must
    /// return [`SuggestionProviderError::Timeout`] if the deadline is
    /// exceeded before the provider can complete.
    ///
    /// The default implementation wraps [`suggest`] in
    /// `tokio::time::timeout` so every provider gets the timing contract
    /// for free. Network-backed adapters SHOULD override if they can pass
    /// the timeout into their transport for earlier cancellation.
    async fn suggest_with_timeout(
        &self,
        request: SuggestionRequest,
        timeout: std::time::Duration,
    ) -> Result<SuggestionResponse, SuggestionProviderError> {
        match tokio::time::timeout(timeout, self.suggest(request)).await {
            Ok(res) => res,
            Err(_elapsed) => Err(SuggestionProviderError::Timeout(format!(
                "provider exceeded {timeout:?} caller-supplied deadline"
            ))),
        }
    }
}
