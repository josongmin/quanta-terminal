//! Integration tests for the Anthropic suggestion adapter.
//!
//! The adapter is pointed at a local `wiremock` server in every test; no case
//! reaches the real API. Tests cover:
//!
//! - happy path (status + body parsing)
//! - whitespace trim on returned command
//! - 401 / 429 / 5xx error mapping
//! - connect-timeout → `Timeout` variant
//! - classifier integration (Blocked, Caution)
//! - empty body / missing-text content parse failures

use std::time::Duration;

use quanta_ai::{
    AnthropicProvider, RiskTier, SuggestionProvider, SuggestionProviderError, SuggestionRequest,
};

use serde_json::json;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Build a provider pointed at the given mock server with a short timeout.
fn provider_for(server: &MockServer) -> AnthropicProvider {
    AnthropicProvider::builder("test-api-key".into())
        .endpoint(format!("{}/v1/messages", server.uri()))
        .model("claude-test-model")
        .timeout(Duration::from_millis(1500))
        .build()
}

fn ok_body(text: &str) -> serde_json::Value {
    json!({
        "id": "msg_test_123",
        "type": "message",
        "role": "assistant",
        "content": [
            { "type": "text", "text": text }
        ],
        "model": "claude-test-model",
        "stop_reason": "end_turn"
    })
}

#[tokio::test]
async fn success_returns_suggestion_and_classified_command() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(header("x-api-key", "test-api-key"))
        .and(header("anthropic-version", "2023-06-01"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body("ls -la")))
        .mount(&server)
        .await;

    let provider = provider_for(&server);
    let response = provider
        .suggest(SuggestionRequest::new("list files"))
        .await
        .expect("ok");

    assert_eq!(response.classified.command, "ls -la");
    assert_eq!(response.classified.tier, RiskTier::Safe);
    assert_eq!(response.id, "msg_test_123");
}

#[tokio::test]
async fn whitespace_is_trimmed_from_model_output() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body("   git status\n\n")))
        .mount(&server)
        .await;

    let provider = provider_for(&server);
    let response = provider
        .suggest(SuggestionRequest::new("repo status"))
        .await
        .expect("ok");
    assert_eq!(response.classified.command, "git status");
}

#[tokio::test]
async fn unauthorized_maps_to_auth_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "error": { "type": "authentication_error", "message": "bad key" }
        })))
        .mount(&server)
        .await;

    let provider = provider_for(&server);
    let err = provider
        .suggest(SuggestionRequest::new("anything"))
        .await
        .expect_err("401 must error");
    assert!(matches!(err, SuggestionProviderError::Auth(_)), "{err:?}");
}

#[tokio::test]
async fn rate_limit_maps_to_rate_limit_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(429).set_body_json(json!({
            "error": { "type": "rate_limit_error", "message": "slow down" }
        })))
        .mount(&server)
        .await;

    let provider = provider_for(&server);
    let err = provider
        .suggest(SuggestionRequest::new("anything"))
        .await
        .expect_err("429 must error");
    assert!(
        matches!(err, SuggestionProviderError::RateLimit(_)),
        "{err:?}"
    );
}

#[tokio::test]
async fn server_5xx_maps_to_server_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(503).set_body_string("upstream down"))
        .mount(&server)
        .await;

    let provider = provider_for(&server);
    let err = provider
        .suggest(SuggestionRequest::new("anything"))
        .await
        .expect_err("503 must error");
    assert!(matches!(err, SuggestionProviderError::Server(_)), "{err:?}");
}

#[tokio::test]
async fn timeout_maps_to_timeout_error() {
    let server = MockServer::start().await;
    // Delay the response past the provider's 1.5s timeout cap.
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(ok_body("ls"))
                .set_delay(Duration::from_secs(5)),
        )
        .mount(&server)
        .await;

    let provider = provider_for(&server);
    let err = provider
        .suggest(SuggestionRequest::new("anything"))
        .await
        .expect_err("must time out");
    assert!(
        matches!(err, SuggestionProviderError::Timeout(_)),
        "{err:?}"
    );
}

#[tokio::test]
async fn classifier_integration_blocks_rm_rf_root() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body("rm -rf /")))
        .mount(&server)
        .await;

    let provider = provider_for(&server);
    let response = provider
        .suggest(SuggestionRequest::new("nuke the machine"))
        .await
        .expect("ok");
    assert_eq!(
        response.classified.tier,
        RiskTier::Blocked,
        "rm -rf / must be Blocked regardless of what the LLM claims"
    );
}

#[tokio::test]
async fn classifier_integration_escalates_sudo_install() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body("sudo apt install ripgrep")))
        .mount(&server)
        .await;

    let provider = provider_for(&server);
    let response = provider
        .suggest(SuggestionRequest::new("install ripgrep"))
        .await
        .expect("ok");
    assert!(
        response.classified.tier >= RiskTier::Caution,
        "sudo apt install must be at least Caution, got {:?}",
        response.classified.tier
    );
}

#[tokio::test]
async fn empty_content_block_maps_to_parse_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_empty",
            "content": []
        })))
        .mount(&server)
        .await;

    let provider = provider_for(&server);
    let err = provider
        .suggest(SuggestionRequest::new("anything"))
        .await
        .expect_err("missing text block must parse-error");
    assert!(matches!(err, SuggestionProviderError::Parse(_)), "{err:?}");
}

#[tokio::test]
async fn whitespace_only_command_maps_to_parse_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body("   \n\t  ")))
        .mount(&server)
        .await;

    let provider = provider_for(&server);
    let err = provider
        .suggest(SuggestionRequest::new("anything"))
        .await
        .expect_err("whitespace-only command must parse-error");
    assert!(matches!(err, SuggestionProviderError::Parse(_)), "{err:?}");
}
