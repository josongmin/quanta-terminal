//! Structured IPC error wire protocol for the Tauri host bridge.
//!
//! Audit finding (FIX 2, P1): `TauriHostBridge` on the TS side used to turn
//! every `Err(String)` returned by a Rust command into `new Error(msg)`,
//! which dumped raw sidecar strings (file paths, `std::io` error chains,
//! stack-ish text) straight into the UI. The UI then string-matched on
//! fragments like `"unknown session"` to branch its toast text — brittle and
//! leaky.
//!
//! This module defines the replacement shape. Every command returns
//! `Result<T, TauriError>`; serde emits the typed discriminator in
//! snake_case so the TS side can parse it verbatim:
//!
//! ```json
//! { "code": "session-not-found", "user_message": "The session ended." }
//! ```
//!
//! The migration strategy is minimal-diff: `?` operators that used to bubble
//! a `String` now go through `TauriError::from(err: String)` (or `&str`), which
//! classifies into `bridge-internal` when we don't yet have a better code.
//! Call sites that already know the semantic category use the dedicated
//! constructors (`session_not_found`, `editor_not_found`, …) so the UI can
//! switch on `.code` rather than string-matching.
//!
//! The error's `Display` impl is the `user_message` — that's the string that
//! shows up in the UI toast. Context goes in the structured `context` field
//! which is safe to log but not display raw. Do NOT put file paths or stack
//! traces in `user_message`; that is the exact leak FIX 2 closes.

use std::fmt;

use serde::Serialize;

/// Machine-readable error code. Must stay in sync with the TS
/// `HostBridgeErrorCode` union in `packages/host-common/src/bridge.ts`.
///
/// A code maps 1:1 to a UI intent (re-auth prompt, retry banner, silent
/// no-op). Adding a new code requires a TS-side addition in the same PR or
/// the TS `switch` will fall through to the `unknown` arm.
///
/// `SessionUnresponsive` and `Unknown` are defined so the enum stays in
/// lockstep with the TS union even though the Rust side doesn't currently
/// construct them (yet): the TS parser falls back to `Unknown` for a bare
/// string, and `SessionUnresponsive` is reserved for an upcoming watchdog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code, reason = "TS-union parity; see enum doc")]
pub enum ErrorCode {
    SessionNotFound,
    SessionUnresponsive,
    EditorNotFound,
    EditorInvalidPath,
    ShellIntegrationOutsideHome,
    ShellIntegrationMissing,
    AiSuggestAuthFailed,
    AiSuggestRateLimited,
    AiSuggestNetwork,
    AiSuggestTimeout,
    SidecarUnavailable,
    BridgeInternal,
    Unknown,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::SessionNotFound => "session-not-found",
            ErrorCode::SessionUnresponsive => "session-unresponsive",
            ErrorCode::EditorNotFound => "editor-not-found",
            ErrorCode::EditorInvalidPath => "editor-invalid-path",
            ErrorCode::ShellIntegrationOutsideHome => "shell-integration-outside-home",
            ErrorCode::ShellIntegrationMissing => "shell-integration-missing",
            ErrorCode::AiSuggestAuthFailed => "ai-suggest-auth-failed",
            ErrorCode::AiSuggestRateLimited => "ai-suggest-rate-limited",
            ErrorCode::AiSuggestNetwork => "ai-suggest-network",
            ErrorCode::AiSuggestTimeout => "ai-suggest-timeout",
            ErrorCode::SidecarUnavailable => "sidecar-unavailable",
            ErrorCode::BridgeInternal => "bridge-internal",
            ErrorCode::Unknown => "unknown",
        }
    }
}

impl Serialize for ErrorCode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// Wire-format error returned from every Tauri command instead of the old
/// `Err(String)`. `#[serde(rename_all = "snake_case")]` pins the key names so
/// the TS parser can rely on the exact shape `{code, user_message, context}`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TauriError {
    pub code: ErrorCode,
    pub user_message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<serde_json::Value>,
}

impl TauriError {
    pub fn new(code: ErrorCode, user_message: impl Into<String>) -> Self {
        Self {
            code,
            user_message: user_message.into(),
            context: None,
        }
    }

    pub fn with_context(mut self, context: serde_json::Value) -> Self {
        self.context = Some(context);
        self
    }

    pub fn session_not_found(session_id: &str) -> Self {
        Self::new(
            ErrorCode::SessionNotFound,
            "That session is no longer available.",
        )
        .with_context(serde_json::json!({ "session_id": session_id }))
    }

    #[allow(dead_code, reason = "reserved for upcoming watchdog timeout")]
    pub fn session_unresponsive() -> Self {
        Self::new(
            ErrorCode::SessionUnresponsive,
            "The session is not responding.",
        )
    }

    pub fn editor_not_found() -> Self {
        Self::new(
            ErrorCode::EditorNotFound,
            "No supported editor was found (tried code, cursor, subl, $VISUAL, $EDITOR).",
        )
    }

    pub fn editor_invalid_path(reason: &str) -> Self {
        Self::new(
            ErrorCode::EditorInvalidPath,
            "The file path was rejected.",
        )
        .with_context(serde_json::json!({ "reason": reason }))
    }

    pub fn shell_integration_outside_home() -> Self {
        Self::new(
            ErrorCode::ShellIntegrationOutsideHome,
            "Refusing to modify a file outside your home directory.",
        )
    }

    pub fn shell_integration_missing(detail: &str) -> Self {
        Self::new(
            ErrorCode::ShellIntegrationMissing,
            "Shell integration could not be located or written.",
        )
        .with_context(serde_json::json!({ "detail": detail }))
    }

    pub fn ai_suggest_auth_failed() -> Self {
        Self::new(
            ErrorCode::AiSuggestAuthFailed,
            "AI suggestions are unavailable: authentication failed.",
        )
    }

    pub fn ai_suggest_rate_limited() -> Self {
        Self::new(
            ErrorCode::AiSuggestRateLimited,
            "AI suggestions are rate-limited. Try again shortly.",
        )
    }

    pub fn ai_suggest_network() -> Self {
        Self::new(
            ErrorCode::AiSuggestNetwork,
            "AI suggestions are offline: network error.",
        )
    }

    pub fn ai_suggest_timeout() -> Self {
        Self::new(
            ErrorCode::AiSuggestTimeout,
            "AI suggestions timed out. Try again.",
        )
    }

    pub fn sidecar_unavailable(detail: &str) -> Self {
        Self::new(
            ErrorCode::SidecarUnavailable,
            "The terminal engine is not connected yet.",
        )
        .with_context(serde_json::json!({ "detail": detail }))
    }

    pub fn bridge_internal(detail: impl Into<String>) -> Self {
        // `bridge-internal` carries a generic user message so the UI never
        // shows the raw detail (paths, stack traces). The detail is kept in
        // `context` so logs still have the full signal.
        Self::new(
            ErrorCode::BridgeInternal,
            "An internal error occurred.",
        )
        .with_context(serde_json::json!({ "detail": detail.into() }))
    }
}

impl fmt::Display for TauriError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.user_message)
    }
}

/// Minimal-diff migration: legacy code paths that still produce a bare
/// `String` map through `.into()` to a `bridge-internal` TauriError. The
/// string is preserved as a context field so grepping the logs still works
/// during the migration window. Once every call site has a typed constructor,
/// this impl can be removed.
impl From<String> for TauriError {
    fn from(s: String) -> Self {
        classify_legacy_message(&s)
    }
}

impl From<&str> for TauriError {
    fn from(s: &str) -> Self {
        classify_legacy_message(s)
    }
}

/// Best-effort classifier for legacy string errors. Pattern-matches substrings
/// the pre-FIX-2 code produced so we don't regress the UI's existing behavior
/// during the transition. New code should use the typed constructors directly
/// and bypass this helper.
pub fn classify_legacy_message(s: &str) -> TauriError {
    let lower = s.to_lowercase();
    if lower.contains("unknown session") {
        return TauriError::new(
            ErrorCode::SessionNotFound,
            "That session is no longer available.",
        )
        .with_context(serde_json::json!({ "detail": s }));
    }
    if lower.contains("refusing to modify file outside") {
        return TauriError::shell_integration_outside_home();
    }
    if lower.contains("no supported editor found") {
        return TauriError::editor_not_found();
    }
    if lower.contains("sidecar") && (lower.contains("not connected") || lower.contains("unavailable")) {
        return TauriError::sidecar_unavailable(s);
    }
    TauriError::bridge_internal(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `bridge-internal` is the default for bare strings — pins that the
    /// minimal-diff migration doesn't accidentally upgrade an unclassified
    /// error into something more specific.
    #[test]
    fn bare_string_classifies_as_bridge_internal() {
        let err: TauriError = "some random failure".to_string().into();
        assert_eq!(err.code, ErrorCode::BridgeInternal);
    }

    /// Known-substring classifier: the "unknown session <id>" pattern the
    /// pre-FIX-2 code emitted must upgrade to `session-not-found` so the UI
    /// can branch without string-matching.
    #[test]
    fn unknown_session_classifies_as_session_not_found() {
        let err: TauriError = "unknown session 1234".into();
        assert_eq!(err.code, ErrorCode::SessionNotFound);
    }

    /// Home-scope refusal string must upgrade so the uninstall wizard can
    /// show the right toast without string-matching the message.
    #[test]
    fn outside_home_classifies_as_shell_integration_outside_home() {
        let err: TauriError = "refusing to modify file outside your home directory".into();
        assert_eq!(err.code, ErrorCode::ShellIntegrationOutsideHome);
    }

    /// Serialization must emit snake_case keys and the string-kebab code the
    /// TS side reads.
    #[test]
    fn serializes_as_snake_case_with_code_string() {
        let err = TauriError::session_not_found("abcd");
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["code"], "session-not-found");
        assert_eq!(v["user_message"], "That session is no longer available.");
        assert_eq!(v["context"]["session_id"], "abcd");
    }

    /// Absent `context` serializes as an omitted key, not `null`. Keeps the
    /// wire shape minimal for errors that don't carry structured context.
    #[test]
    fn context_is_omitted_when_none() {
        let err = TauriError::new(ErrorCode::Unknown, "something");
        let v = serde_json::to_value(&err).unwrap();
        assert!(v.get("context").is_none());
    }

    /// Display forwards to `user_message` so `?` / `.to_string()` produces
    /// the UI-safe text, not a debug dump.
    #[test]
    fn display_returns_user_message() {
        let err = TauriError::new(ErrorCode::SessionNotFound, "gone");
        assert_eq!(err.to_string(), "gone");
    }
}
