//! Anthropic Claude suggestion provider — Phase-6 LLM adapter.
//!
//! Talks to `https://api.anthropic.com/v1/messages`. The adapter is pure plumbing:
//!
//! 1. Builds a request body with a fixed system prompt (the assistant must
//!    reply with a single shell command, no prose).
//! 2. Sends it with a 10s hard timeout, honoring the configured model.
//! 3. Extracts `content[0].text`, strips whitespace, and runs the local
//!    [`RiskClassifier`] on the resulting command. The LLM is never trusted
//!    to self-classify — the heuristic table in `HeuristicClassifier` is the
//!    only source of truth for risk labels.
//! 4. Wraps any HTTP / parse failure in a specific `SuggestionProviderError`
//!    variant so the UI can branch on retry-ability.
//!
//! # Security boundary
//!
//! - The API key is accepted through [`AnthropicProvider::new`] and held in an
//!   [`ApiKey`] newtype whose `Debug` impl redacts the value. The adapter does
//!   **not** read environment variables — the Tauri host owns key sourcing so
//!   unit tests never accidentally hit the real API.
//! - Logging is strictly metadata: model name, HTTP status, latency, and the
//!   character length of the returned suggestion. The prompt body, the
//!   response body, and the API key itself are never logged.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};

use crate::adapters::HeuristicClassifier;
use crate::domain::{SuggestionRequest, SuggestionResponse};
use crate::ports::{RiskClassifier, SuggestionProvider, SuggestionProviderError};

/// Default Claude model used when the caller does not override via
/// [`AnthropicProviderBuilder::model`].
pub const DEFAULT_MODEL: &str = "claude-sonnet-4-6";

/// Anthropic messages API endpoint.
const DEFAULT_ENDPOINT: &str = "https://api.anthropic.com/v1/messages";

/// Anthropic API version pin. Matches the adapter's known-good response shape.
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Hard timeout cap for a single `/messages` call.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// System prompt. Intentionally terse: we want exactly one shell line, no
/// commentary, no fences.
const SYSTEM_PROMPT: &str = "You are a terminal assistant. The user will give \
a natural-language prompt, you respond with a single shell command that \
accomplishes the task, nothing else. No prose, no markdown, no code fences — \
just the command.";

/// Max tokens requested from the model. A single shell command is short; the
/// cap keeps pathological outputs bounded.
const MAX_TOKENS: u32 = 512;

/// Redacting newtype for the API key. `Debug` and `Display` never emit the
/// actual bytes — only `"<redacted>"`.
///
/// Kept `Clone` so the provider can hand a copy to each request without
/// leaking the key into a shared `Arc<str>`.
#[derive(Clone)]
pub struct ApiKey(String);

impl ApiKey {
    /// Wrap a raw key. The caller is responsible for the key's provenance
    /// (env var, OS keychain, etc.).
    #[must_use]
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    /// Expose the raw key. Deliberately named so a grep for `expose` surfaces
    /// every call site.
    fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("ApiKey").field(&"<redacted>").finish()
    }
}

impl std::fmt::Display for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

/// Production Anthropic adapter.
///
/// Thread-safe and cheap to clone — the underlying `reqwest::Client` pools
/// connections internally. Construct once at app startup and share.
#[derive(Clone, Debug)]
pub struct AnthropicProvider {
    http: Client,
    endpoint: String,
    model: String,
    api_key: ApiKey,
    classifier: Arc<dyn RiskClassifier>,
}

impl AnthropicProvider {
    /// Construct with the default model and classifier. Reads no env vars —
    /// the caller owns key sourcing.
    ///
    /// # Panics
    ///
    /// Panics only if `reqwest` cannot build its internal client, which in
    /// practice means the host is missing rustls roots. We propagate that as
    /// a panic rather than an error because it is a deployment-time defect,
    /// not a per-request one.
    #[must_use]
    pub fn new(api_key: String) -> Self {
        AnthropicProviderBuilder::new(api_key).build()
    }

    /// Start a builder so tests can override the endpoint, model, or classifier.
    #[must_use]
    pub fn builder(api_key: String) -> AnthropicProviderBuilder {
        AnthropicProviderBuilder::new(api_key)
    }

    /// Model this provider will call. Exposed for observability tests.
    #[must_use]
    pub fn model(&self) -> &str {
        &self.model
    }
}

/// Builder for [`AnthropicProvider`]. Lets tests point at a mock server
/// without exposing the HTTP client directly.
#[derive(Debug)]
pub struct AnthropicProviderBuilder {
    endpoint: String,
    model: String,
    api_key: ApiKey,
    classifier: Arc<dyn RiskClassifier>,
    timeout: Duration,
}

impl AnthropicProviderBuilder {
    /// Seed the builder with sensible production defaults.
    #[must_use]
    pub fn new(api_key: String) -> Self {
        Self {
            endpoint: DEFAULT_ENDPOINT.to_string(),
            model: DEFAULT_MODEL.to_string(),
            api_key: ApiKey::new(api_key),
            classifier: Arc::new(HeuristicClassifier::new()),
            timeout: REQUEST_TIMEOUT,
        }
    }

    /// Override the endpoint. Tests point this at the mock server URL.
    #[must_use]
    pub fn endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = endpoint.into();
        self
    }

    /// Override the model.
    #[must_use]
    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    /// Override the classifier. Useful for tests that want to pin a specific
    /// tier independently of the heuristic rule table.
    #[must_use]
    pub fn classifier(mut self, classifier: Arc<dyn RiskClassifier>) -> Self {
        self.classifier = classifier;
        self
    }

    /// Override the request timeout. Production always uses 10s; tests use
    /// a shorter value to keep the suite fast.
    #[must_use]
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Finalize the builder into an [`AnthropicProvider`].
    #[must_use]
    pub fn build(self) -> AnthropicProvider {
        let http = Client::builder()
            .timeout(self.timeout)
            .build()
            .expect("reqwest client build failed — rustls roots missing?");
        AnthropicProvider {
            http,
            endpoint: self.endpoint,
            model: self.model,
            api_key: self.api_key,
            classifier: self.classifier,
        }
    }
}

#[async_trait]
impl SuggestionProvider for AnthropicProvider {
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

        let body = MessagesRequest {
            model: &self.model,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: vec![UserMessage {
                role: "user",
                content: prompt,
            }],
        };

        tracing::info!(
            model = %self.model,
            prompt_len = prompt.len(),
            "anthropic: sending /messages request"
        );

        let started = Instant::now();
        let http_result = self
            .http
            .post(&self.endpoint)
            .header("x-api-key", self.api_key.expose())
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await;

        let response = match http_result {
            Ok(r) => r,
            Err(err) if err.is_timeout() => {
                tracing::warn!(model = %self.model, "anthropic: request timed out");
                return Err(SuggestionProviderError::Timeout(
                    "request exceeded 10s cap".into(),
                ));
            }
            Err(err) => {
                tracing::warn!(model = %self.model, ?err, "anthropic: network failure");
                return Err(SuggestionProviderError::Network(format!(
                    "request failed: {err}"
                )));
            }
        };

        let status = response.status();
        let latency_ms = started.elapsed().as_millis();

        if !status.is_success() {
            tracing::warn!(
                model = %self.model,
                status = status.as_u16(),
                latency_ms,
                "anthropic: non-2xx response"
            );
            return Err(classify_http_error(status));
        }

        // Only read the body after status is 2xx — no point parsing an error
        // payload we already know how to classify.
        let parsed: MessagesResponse = response.json().await.map_err(|err| {
            SuggestionProviderError::Parse(format!("decode response body: {err}"))
        })?;

        let raw_command = parsed
            .content
            .into_iter()
            .find(|block| block.content_type == "text")
            .map(|block| block.text)
            .ok_or_else(|| {
                SuggestionProviderError::Parse("no text block in response content".into())
            })?;

        let command = raw_command.trim();
        if command.is_empty() {
            return Err(SuggestionProviderError::Parse(
                "model returned empty command".into(),
            ));
        }

        let classified = self.classifier.classify(command);

        tracing::info!(
            model = %self.model,
            status = status.as_u16(),
            latency_ms,
            suggestion_len = command.len(),
            tier = classified.tier.label(),
            "anthropic: /messages ok"
        );

        Ok(SuggestionResponse {
            id: parsed
                .id
                .unwrap_or_else(|| format!("anthropic-{}", latency_ms)),
            classified,
            rationale: None,
        })
    }
}

/// Map a non-2xx status to the appropriate provider error variant.
fn classify_http_error(status: StatusCode) -> SuggestionProviderError {
    let code = status.as_u16();
    let msg = format!("HTTP {code}");
    match code {
        401 | 403 => SuggestionProviderError::Auth(msg),
        429 => SuggestionProviderError::RateLimit(msg),
        500..=599 => SuggestionProviderError::Server(msg),
        _ => SuggestionProviderError::Internal(msg),
    }
}

/* -------------------- wire types -------------------- */

#[derive(Serialize)]
struct MessagesRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: &'a str,
    messages: Vec<UserMessage<'a>>,
}

#[derive(Serialize)]
struct UserMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct MessagesResponse {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    content_type: String,
    #[serde(default)]
    text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_key_debug_redacts() {
        let k = ApiKey::new("sk-ant-super-secret");
        let dbg = format!("{k:?}");
        assert!(dbg.contains("<redacted>"));
        assert!(!dbg.contains("super-secret"));
    }

    #[test]
    fn api_key_display_redacts() {
        let k = ApiKey::new("sk-ant-super-secret");
        let s = format!("{k}");
        assert_eq!(s, "<redacted>");
    }

    #[test]
    fn provider_debug_does_not_leak_key() {
        let p = AnthropicProvider::new("sk-ant-leak-me".into());
        let dbg = format!("{p:?}");
        assert!(!dbg.contains("leak-me"));
    }

    #[test]
    fn builder_defaults_to_default_model() {
        let p = AnthropicProvider::new("k".into());
        assert_eq!(p.model(), DEFAULT_MODEL);
    }

    #[test]
    fn builder_overrides_model() {
        let p = AnthropicProvider::builder("k".into())
            .model("claude-haiku-test")
            .build();
        assert_eq!(p.model(), "claude-haiku-test");
    }

    #[test]
    fn classify_http_error_maps_codes() {
        assert!(matches!(
            classify_http_error(StatusCode::UNAUTHORIZED),
            SuggestionProviderError::Auth(_)
        ));
        assert!(matches!(
            classify_http_error(StatusCode::FORBIDDEN),
            SuggestionProviderError::Auth(_)
        ));
        assert!(matches!(
            classify_http_error(StatusCode::TOO_MANY_REQUESTS),
            SuggestionProviderError::RateLimit(_)
        ));
        assert!(matches!(
            classify_http_error(StatusCode::INTERNAL_SERVER_ERROR),
            SuggestionProviderError::Server(_)
        ));
        assert!(matches!(
            classify_http_error(StatusCode::BAD_GATEWAY),
            SuggestionProviderError::Server(_)
        ));
        assert!(matches!(
            classify_http_error(StatusCode::IM_A_TEAPOT),
            SuggestionProviderError::Internal(_)
        ));
    }

    #[tokio::test]
    async fn rejects_empty_prompt() {
        let p = AnthropicProvider::new("k".into());
        let err = p
            .suggest(SuggestionRequest::new("   "))
            .await
            .expect_err("empty prompt must reject without making a network call");
        assert!(matches!(err, SuggestionProviderError::InvalidPrompt(_)));
    }
}
