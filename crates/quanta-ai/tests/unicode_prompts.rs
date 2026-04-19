//! Unicode prompt handling for the Anthropic adapter (B3 in the Round-10 audit).
//!
//! Ensures that pathological but legitimate Unicode — combining marks,
//! RTL overrides, ZWJ-sequence emoji — round-trips the UTF-8 encoder
//! without byte loss. The outbound HTTP body is intercepted via
//! wiremock; the assertion is on byte-level fidelity, not on what the
//! model does with the content.
//!
//! A null-byte prompt is rejected at the adapter (see test below) so
//! the user gets a clean "invalid prompt" error before the network
//! round-trip cost is paid.

use std::time::Duration;

use quanta_ai::{
    AnthropicProvider, SuggestionProvider, SuggestionProviderError, SuggestionRequest,
};
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

fn provider_for(server: &MockServer) -> AnthropicProvider {
    AnthropicProvider::builder("test-api-key".into())
        .endpoint(format!("{}/v1/messages", server.uri()))
        .model("claude-test-model")
        .timeout(Duration::from_millis(1500))
        .build()
}

fn ok_body(text: &str) -> Value {
    json!({
        "id": "msg_unicode_test",
        "type": "message",
        "role": "assistant",
        "content": [
            { "type": "text", "text": text }
        ],
        "model": "claude-test-model",
        "stop_reason": "end_turn"
    })
}

/// Capture every POST body the mock received so the test can assert on
/// byte-level fidelity of the outbound prompt.
async fn send_and_capture(
    server: &MockServer,
    prompt: &str,
) -> Result<Vec<u8>, SuggestionProviderError> {
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body("ls")))
        .mount(server)
        .await;

    let provider = provider_for(server);
    provider.suggest(SuggestionRequest::new(prompt)).await?;

    // Pull the captured request body. wiremock stores bodies on the
    // received-requests list; we always take the first one since each
    // test starts with a fresh mock server.
    let reqs = server
        .received_requests()
        .await
        .expect("wiremock retained request bodies");
    let req: &Request = reqs.first().expect("at least one captured request");
    Ok(req.body.clone())
}

/// Pull the `content` field out of the first `messages[].content` in the
/// captured JSON body.
fn extract_user_content(body: &[u8]) -> String {
    let v: Value = serde_json::from_slice(body).expect("captured body is valid JSON");
    v.get("messages")
        .and_then(|m| m.as_array())
        .and_then(|arr| arr.first())
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .expect("messages[0].content is a string")
        .to_string()
}

/// (a) Combining marks: `é` as `e` + `U+0301` combining acute. The UTF-8
///     byte sequence must survive the JSON round-trip exactly.
#[tokio::test]
async fn combining_marks_round_trip_byte_equal() {
    let server = MockServer::start().await;
    // "caf" + "e" + COMBINING ACUTE ACCENT (U+0301)
    let prompt = "caf\u{0065}\u{0301}";
    let body = send_and_capture(&server, prompt).await.expect("ok");
    let sent = extract_user_content(&body);
    assert_eq!(
        sent.as_bytes(),
        prompt.as_bytes(),
        "combining-mark bytes must survive UTF-8 encoding without normalization"
    );
    // Sanity: the composed NFC form (single `é` = U+00E9) is NOT what we
    // sent, so this assertion is stricter than "looks equivalent".
    assert_ne!(sent, "café");
}

/// (b) RTL override (`U+202E`): must pass through byte-for-byte. A
///     stripping adapter would silently drop the marker and corrupt the
///     user's prompt.
#[tokio::test]
async fn rtl_override_passes_through_byte_for_byte() {
    let server = MockServer::start().await;
    let prompt = "before\u{202E}after";
    let body = send_and_capture(&server, prompt).await.expect("ok");
    let sent = extract_user_content(&body);
    assert_eq!(sent.as_bytes(), prompt.as_bytes());
    assert!(sent.contains('\u{202E}'));
}

/// (c) ZWJ-sequence emoji: `👨‍👩‍👧‍👦` (family) — four base emoji plus
///     three zero-width joiners, totalling 25 bytes in UTF-8. Any
///     stripping of ZWJs fragments the grapheme cluster into four
///     independent people.
#[tokio::test]
async fn zwj_sequence_emoji_preserves_every_joiner() {
    let server = MockServer::start().await;
    let prompt = "family: \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
    let body = send_and_capture(&server, prompt).await.expect("ok");
    let sent = extract_user_content(&body);
    assert_eq!(sent.as_bytes(), prompt.as_bytes());
    assert_eq!(
        sent.matches('\u{200D}').count(),
        3,
        "three ZWJ joiners must survive the roundtrip"
    );
}

/// (d) Null byte: rejected at the adapter with an `InvalidPrompt` error
///     so the user gets a clean message before the network roundtrip.
///     Documentation: we prefer reject-at-construction over "let the
///     server handle it" because Anthropic's error surface for null
///     bytes is opaque and routes back to the UI as a generic 400.
#[tokio::test]
async fn null_byte_in_prompt_is_rejected_before_network_call() {
    let server = MockServer::start().await;
    // No mock mounted — any HTTP call would 404 / fail. The adapter
    // MUST reject before reaching the mock.
    let provider = provider_for(&server);
    let err = provider
        .suggest(SuggestionRequest::new("foo\0bar"))
        .await
        .expect_err("null byte must be rejected");
    assert!(
        matches!(err, SuggestionProviderError::InvalidPrompt(_)),
        "expected InvalidPrompt for null-byte prompt; got {err:?}"
    );
    // Confirm no HTTP traffic reached the mock.
    let reqs = server
        .received_requests()
        .await
        .expect("wiremock retained request bodies");
    assert!(
        reqs.is_empty(),
        "null-byte prompt must be rejected BEFORE the network roundtrip; observed {} request(s)",
        reqs.len()
    );
}

/// Timing contract (B4): `suggest_with_timeout` must surface a
/// `Timeout` variant when the supplied deadline is exceeded, even if
/// the underlying transport's own cap would permit a longer wait.
#[tokio::test]
async fn anthropic_suggest_with_timeout_honours_caller_deadline() {
    let server = MockServer::start().await;
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
        .suggest_with_timeout(SuggestionRequest::new("ls"), Duration::from_millis(50))
        .await
        .expect_err("caller timeout must trip");
    assert!(
        matches!(err, SuggestionProviderError::Timeout(_)),
        "expected Timeout; got {err:?}"
    );
}
