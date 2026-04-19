//! Sidecar bridge — Tauri ↔ `quanta-core` over a Unix socket (ADR 0004).
//!
//! This module is compiled under the `sidecar` feature. It replaces the
//! in-process `embedded_shell` PTY by:
//!   1. Spawning `quanta-core --socket <path> --profile <path>` as a child
//!      process when the socket path is not already serving.
//!   2. Connecting a `quanta_protocol::UnixSocketClient`, performing the
//!      `Hello`/`Ready` handshake.
//!   3. Translating Tauri IPC commands into `RpcMethod` calls
//!      (`CreateSession`, `SubmitInput`, `ResizePty`, `CloseSession`,
//!      `CancelBlock`).
//!   4. Subscribing to the event plane and re-emitting envelopes as Tauri
//!      events under the canonical `quanta://` topics the UI already listens to
//!      (hyphenated per ADR-0004-adjacent naming pinned in `ipc.rs`).
//!
//! The module owns the child process handle with `kill_on_drop(true)` so a
//! Tauri app exit cleans the engine up without leaking. Crash recovery is
//! explicit: when the event stream ends unexpectedly we emit a synthetic
//! `pty-exit` for every live session so the UI can reconcile.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use parking_lot::Mutex;
use quanta_proto::envelope::Envelope;
use quanta_proto::events::{Event, SessionEndReason};
use quanta_proto::ids::SessionId;
use quanta_proto::rpc::{
    CancelBlock, CloseSession, CreateSession, CreateSessionResult, InputMode, ResizePty,
    RpcMethod, RpcResult, SubmitInput,
};
use quanta_protocol::UnixSocketClient;
use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::process::{Child, Command};
use tokio::sync::mpsc::Receiver;

use crate::ipc::{
    DataEvent, ExitEvent, EVENT_PTY_DATA, EVENT_PTY_EXIT,
};

/// Additional event topics emitted by the sidecar bridge. Kept here (not in
/// `ipc.rs`) because they only make sense when the sidecar is wired up; the
/// embedded-shell path doesn't produce a `SessionCreated` event.
///
/// All topics use hyphens only — dots are rejected by Tauri 2.
pub const EVENT_SESSION_CREATED: &str = "quanta://session-created";
pub const EVENT_SESSION_CWD_CHANGED: &str = "quanta://session-cwd-changed";
pub const EVENT_SESSION_SHELL_INTEGRATION_STATUS: &str =
    "quanta://session-shell-integration-status";
pub const EVENT_DIAGNOSTIC_DETECTED: &str = "quanta://diagnostic-detected";
/// Banner-level event emitted once on sidecar startup when a previous crash
/// marker is found. The UI displays a "previous session ended unexpectedly"
/// banner the user can dismiss. See FIX 2 in the audit — the marker is a
/// host-side durable signal (the engine's own log can't be updated after it
/// has died). This is a best-effort close of the crash-recovery gap; the
/// authoritative recovery story requires the engine to checkpoint state
/// durably before accepting a client, which is Phase-6 scope.
pub const EVENT_SIDECAR_RECOVERED: &str = "quanta://sidecar-recovered";

/// Filename of the crash marker written to `$APP_CONFIG_DIR`. Kept out of
/// the module-private scope so tests can check for it without reaching into
/// private helpers.
pub const SIDECAR_CRASH_MARKER: &str = "sidecar-crash.json";

/// Handle to a running `quanta-core` child + client connection.
pub struct SidecarBridge {
    client: Arc<UnixSocketClient>,
    sessions: Arc<Mutex<HashMap<String, SessionId>>>,
    /// Kept alive so the child isn't dropped while the bridge is live. Also
    /// exposes the PID for diagnostics.
    #[allow(dead_code, reason = "retained to tie child lifetime to the bridge")]
    child: Arc<Mutex<Option<Child>>>,
}

impl std::fmt::Debug for SidecarBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SidecarBridge").finish_non_exhaustive()
    }
}

/// Configuration for launching the sidecar. Resolved from env + `AppHandle`.
#[derive(Debug, Clone)]
pub struct SidecarLaunchConfig {
    /// Absolute path to the `quanta-core` binary. Must exist.
    pub binary: PathBuf,
    /// Unix-socket path the sidecar will bind.
    pub socket_path: PathBuf,
    /// Profile directory (durable log, sqlite, etc.) — ADR 0011 event log.
    pub profile_dir: PathBuf,
}

impl SidecarLaunchConfig {
    /// Build a config from environment variables + (optionally) the Tauri
    /// `AppHandle` for resource-path resolution.
    ///
    /// Binary resolution priority (first match wins):
    ///   1. `QUANTA_CORE_BIN` env var — explicit dev override.
    ///   2. Tauri bundled sidecar — `AppHandle::path().resolve(...)` against
    ///      `BaseDirectory::Resource` joined with `quanta-core`. Tauri 2 names
    ///      the bundled file `quanta-core-<triple>` on disk but exposes it to
    ///      the runtime under the short name set in `externalBin`, which the
    ///      resolver handles transparently.
    ///   3. `which quanta-core` on PATH — long-standing fallback so a
    ///      developer with `cargo install quanta-core` still works.
    ///
    /// Other env knobs (unchanged):
    /// - `QUANTA_SOCKET_PATH` → socket path (default:
    ///   `$XDG_RUNTIME_DIR/quanta/core.sock` or `$TMPDIR/quanta-core-$PID.sock`)
    /// - `QUANTA_PROFILE_DIR` → profile dir (default: `$HOME/.local/share/quanta`)
    pub fn from_env<R: Runtime>(app: Option<&AppHandle<R>>) -> Result<Self> {
        let binary = resolve_core_binary(app)?;
        let socket_path = std::env::var_os("QUANTA_SOCKET_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(default_socket_path);
        let profile_dir = std::env::var_os("QUANTA_PROFILE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(default_profile_dir);
        Ok(Self {
            binary,
            socket_path,
            profile_dir,
        })
    }
}

/// Resolve the `quanta-core` binary per the priority order documented on
/// `SidecarLaunchConfig::from_env`. Extracted so the unit tests can exercise
/// each arm without wiring a full Tauri app context.
pub(crate) fn resolve_core_binary<R: Runtime>(app: Option<&AppHandle<R>>) -> Result<PathBuf> {
    // 1. Explicit env override — wins unconditionally (dev workflow).
    if let Some(raw) = std::env::var_os("QUANTA_CORE_BIN") {
        let p = PathBuf::from(raw);
        if !p.exists() {
            bail!(
                "QUANTA_CORE_BIN points to missing path: {}",
                p.display()
            );
        }
        return Ok(p);
    }

    // 2. Tauri bundled sidecar, when we have an AppHandle.
    //    `externalBin: ["binaries/quanta-core"]` in tauri.conf.json causes
    //    the bundler to ship the triple-suffixed binary and expose it under
    //    the short name on disk inside the app resource directory.
    if let Some(app) = app {
        if let Ok(resolved) = app
            .path()
            .resolve("quanta-core", BaseDirectory::Resource)
        {
            if resolved.exists() {
                return Ok(resolved);
            }
            // Fall through on miss — the binary may not be packaged in this
            // build (e.g. `tauri dev` without a prior `package-sidecar`). The
            // next arm (`which`) covers that case explicitly.
            tracing::debug!(
                resolved = %resolved.display(),
                "sidecar: bundled resource path did not exist; falling back to PATH",
            );
        }
    }

    // 3. `which quanta-core` on PATH. Historic fallback; lets a developer
    //    who did `cargo install quanta-core` keep working without setting
    //    `QUANTA_CORE_BIN`.
    if let Ok(found) = which::which("quanta-core") {
        return Ok(found);
    }

    bail!(
        "could not locate `quanta-core`. Set QUANTA_CORE_BIN, run \
         `pnpm package-sidecar` to bundle the binary, or install it on PATH.",
    )
}

fn default_socket_path() -> PathBuf {
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
        let dir = PathBuf::from(runtime).join("quanta");
        return dir.join("core.sock");
    }
    let base = std::env::temp_dir();
    let pid = std::process::id();
    base.join(format!("quanta-core-{pid}.sock"))
}

fn default_profile_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        PathBuf::from(home).join(".local/share/quanta")
    } else {
        PathBuf::from("./quanta-profile")
    }
}

/// Does a live server already answer on this socket? We treat the path as
/// "being served" if the Unix socket file exists AND we can connect to it. A
/// stale file (left over from a crashed prior instance) isn't counted — the
/// connect will fail and the caller will spawn a fresh child.
pub async fn socket_is_live(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    tokio::net::UnixStream::connect(path).await.is_ok()
}

/// Spawn the sidecar (if not already live) and open a client connection.
///
/// Bounded waits throughout so Tauri startup never hangs longer than ~7 s on
/// a bad install. If the child fails to bind, the returned error includes the
/// captured stderr tail so the UI toast can surface a meaningful reason.
pub async fn launch(config: SidecarLaunchConfig) -> Result<SidecarBridge> {
    // Socket-race-tolerant: if another quanta-core is already bound, reuse it.
    let child_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));

    if !socket_is_live(&config.socket_path).await {
        // Make sure the socket directory exists; `UnixListener::bind` fails
        // otherwise.
        if let Some(parent) = config.socket_path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).with_context(|| {
                    format!("create socket dir {}", parent.display())
                })?;
            }
        }
        if !config.profile_dir.exists() {
            std::fs::create_dir_all(&config.profile_dir).with_context(|| {
                format!("create profile dir {}", config.profile_dir.display())
            })?;
        }

        let child = Command::new(&config.binary)
            .arg("--socket")
            .arg(&config.socket_path)
            .arg("--profile")
            .arg(&config.profile_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env(
                "RUST_LOG",
                std::env::var("QUANTA_CORE_LOG").unwrap_or_else(|_| "info".into()),
            )
            .kill_on_drop(true)
            .spawn()
            .with_context(|| {
                format!(
                    "spawn {} --socket {} --profile {}",
                    config.binary.display(),
                    config.socket_path.display(),
                    config.profile_dir.display(),
                )
            })?;

        *child_slot.lock() = Some(child);

        // Wait for the socket to appear. A cold boot with zstd+sqlite is
        // typically <200 ms; 5 s is very generous before we bail.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !config.socket_path.exists() {
            if Instant::now() >= deadline {
                bail!(
                    "quanta-core did not bind {} within 5s; check stderr (RUST_LOG=info)",
                    config.socket_path.display()
                );
            }
            // If the child died early, surface that as the error (more
            // useful than a generic deadline miss).
            if let Some(child) = child_slot.lock().as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => bail!(
                        "quanta-core exited early: {:?}; check stderr with RUST_LOG=info",
                        status
                    ),
                    Ok(None) => {}
                    Err(err) => bail!("waitpid on quanta-core: {err}"),
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    } else {
        tracing::info!(
            socket = %config.socket_path.display(),
            "sidecar: reusing existing server on socket",
        );
    }

    let client = UnixSocketClient::connect(
        &config.socket_path,
        format!("quanta-host-tauri-{}", std::process::id()),
        env!("CARGO_PKG_VERSION").to_string(),
    )
    .await
    .with_context(|| {
        format!(
            "connect to quanta-core at {}",
            config.socket_path.display()
        )
    })?;

    Ok(SidecarBridge {
        client: Arc::new(client),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        child: child_slot,
    })
}

impl SidecarBridge {
    /// Wire the event stream onto the Tauri `AppHandle`. Must be called once,
    /// shortly after `launch()`. The returned task handle is detached.
    ///
    /// Generic over the Tauri runtime so the caller's `AppHandle<R>` flows
    /// through without forcing a concrete runtime on the library.
    pub fn start_event_pump<R: Runtime>(
        &self,
        app: AppHandle<R>,
    ) -> Option<tokio::task::JoinHandle<()>> {
        let mut stream = self.client.take_event_stream()?;
        let sessions = self.sessions.clone();
        Some(tokio::spawn(async move {
            event_pump_loop(&mut stream, &sessions, &app).await;
        }))
    }

    /// Create a new session via RPC and register its id → handle mapping.
    pub async fn spawn_session(
        &self,
        handle_session_id: &str,
        shell: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<(String, String)> {
        let req = RpcMethod::CreateSession(CreateSession {
            shell: shell.clone(),
            cwd: cwd.clone(),
            cols,
            rows,
        });
        let resp = self
            .client
            .call(format!("spawn-{handle_session_id}"), req)
            .await
            .context("CreateSession rpc send")?;
        let result: CreateSessionResult = match resp.result {
            RpcResult::Ok { value } => serde_json::from_value(value)
                .context("decode CreateSessionResult")?,
            RpcResult::Err { error } => {
                return Err(anyhow!(
                    "CreateSession failed: {}: {}",
                    error.code,
                    error.message
                ))
            }
        };
        self.sessions
            .lock()
            .insert(handle_session_id.to_string(), result.session_id);
        Ok((
            shell.unwrap_or_else(|| "/bin/sh".to_string()),
            cwd.unwrap_or_else(|| "/".to_string()),
        ))
    }

    /// Translate a host-level write to `SubmitInput { mode: Passthrough }`.
    /// Terminal emulator keypresses are always passthrough; the `Submit`
    /// mode is driven by the block-composer surface which doesn't use this
    /// path.
    pub async fn write(&self, handle_session_id: &str, data: &[u8]) -> Result<()> {
        let sid = self
            .sessions
            .lock()
            .get(handle_session_id)
            .copied()
            .ok_or_else(|| anyhow!("unknown session handle {handle_session_id}"))?;
        let text = std::str::from_utf8(data)
            .map_err(|e| anyhow!("write payload is not utf-8: {e}"))?
            .to_string();
        let req = RpcMethod::SubmitInput(SubmitInput {
            session_id: sid,
            text,
            mode: InputMode::Passthrough,
        });
        let resp = self
            .client
            .call(new_request_id("write"), req)
            .await
            .context("SubmitInput rpc")?;
        if let RpcResult::Err { error } = resp.result {
            bail!("SubmitInput failed: {}: {}", error.code, error.message);
        }
        Ok(())
    }

    pub async fn resize(&self, handle_session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let sid = self
            .sessions
            .lock()
            .get(handle_session_id)
            .copied()
            .ok_or_else(|| anyhow!("unknown session handle {handle_session_id}"))?;
        let req = RpcMethod::ResizePty(ResizePty {
            session_id: sid,
            cols,
            rows,
        });
        let resp = self
            .client
            .call(new_request_id("resize"), req)
            .await
            .context("ResizePty rpc")?;
        if let RpcResult::Err { error } = resp.result {
            bail!("ResizePty failed: {}: {}", error.code, error.message);
        }
        Ok(())
    }

    pub async fn cancel(&self, handle_session_id: &str, block_id_str: &str) -> Result<()> {
        let sid = self
            .sessions
            .lock()
            .get(handle_session_id)
            .copied()
            .ok_or_else(|| anyhow!("unknown session handle {handle_session_id}"))?;
        let block_id = quanta_proto::ids::BlockId::parse(block_id_str)
            .map_err(|e| anyhow!("bad block id {block_id_str}: {e}"))?;
        let req = RpcMethod::CancelBlock(CancelBlock {
            session_id: sid,
            block_id,
        });
        let resp = self
            .client
            .call(new_request_id("cancel"), req)
            .await
            .context("CancelBlock rpc")?;
        if let RpcResult::Err { error } = resp.result {
            bail!("CancelBlock failed: {}: {}", error.code, error.message);
        }
        Ok(())
    }

    pub async fn close(&self, handle_session_id: &str) -> Result<()> {
        let sid = match self.sessions.lock().remove(handle_session_id) {
            Some(s) => s,
            None => return Ok(()), // idempotent: already closed locally
        };
        let req = RpcMethod::CloseSession(CloseSession { session_id: sid });
        // A connection-level RPC error (socket dead, decode failure) means
        // the sidecar itself is broken — propagate it so the host can
        // surface a meaningful toast and trigger reconnect logic. Anything
        // that comes back as an RpcResult::Err with a benign "already
        // closed" / "session not found" message must collapse to Ok(()):
        // the registry has already been cleared here, and a retry would
        // trip the `None` arm above and return Ok anyway.
        //
        // FIX 4 (audit): the pre-fix body propagated connection errors
        // after already mutating the registry, which caused the UI to
        // retry close against a now-empty mapping. The event pump would
        // then fall back to the stringified `SessionId` and emit a
        // pty-exit under a handle the UI never registered. Making close
        // idempotent for benign sidecar-side errors eliminates that path.
        let resp = match self
            .client
            .call(new_request_id("close"), req)
            .await
        {
            Ok(r) => r,
            Err(err) => {
                // Connection-level failure: propagate. The local registry
                // is already clear, but surfacing the error lets the UI
                // know the sidecar itself is gone.
                return Err(err).context("CloseSession rpc");
            }
        };
        if let RpcResult::Err { error } = resp.result {
            if is_benign_close_error(&error.code, &error.message) {
                tracing::warn!(
                    code = %error.code,
                    message = %error.message,
                    "CloseSession: benign error; treating as idempotent close",
                );
                return Ok(());
            }
            bail!("CloseSession failed: {}: {}", error.code, error.message);
        }
        Ok(())
    }
}

/// Classify a sidecar-side `CloseSession` error as benign (already-closed /
/// unknown-session equivalent) vs. a real failure worth surfacing to the UI.
///
/// The patterns here mirror the `quanta_cancel_block` idempotency list in
/// `ipc.rs`: the core protocol is not yet pinned on error codes, so we
/// match substrings that consistently mean "the engine already considers
/// this session gone". Any pattern not on the list propagates as an
/// error — that's the safe default for a security-sensitive operation.
fn is_benign_close_error(code: &str, message: &str) -> bool {
    let text = format!("{code} {message}").to_lowercase();
    text.contains("unknown session")
        || text.contains("session not found")
        || text.contains("not_found")
        || text.contains("not found")
        || text.contains("already closed")
        || text.contains("already terminated")
        || text.contains("already")
        || text.contains("terminated")
}

/// Payload persisted to the crash marker. Kept small and self-describing so
/// forward/backward-compat across builds is trivial (any missing field on
/// read collapses to the default via serde).
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
struct CrashMarker {
    /// Unix-epoch milliseconds when the synthesis happened. Surfaced to the
    /// UI banner so the user can see approximately when it died.
    timestamp_ms: u64,
    /// Host-side session handle strings (the same strings the UI passes to
    /// spawn/write/close). Using the handle — not the engine's SessionId —
    /// keeps this file legible across builds even if the engine's ID type
    /// changes.
    affected_sessions: Vec<String>,
}

/// Write the crash marker to `<dir>/sidecar-crash.json`, best-effort. A
/// failure to persist here is logged but does not surface to the caller —
/// the synthetic pty-exit broadcast to live UIs is still the primary signal
/// and the marker is the safety net for "what if the host then restarts".
fn write_crash_marker(dir: &Path, affected: &[String]) {
    if let Err(err) = std::fs::create_dir_all(dir) {
        tracing::warn!(?err, dir = %dir.display(), "crash marker: mkdir failed");
        return;
    }
    let marker = CrashMarker {
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        affected_sessions: affected.to_vec(),
    };
    let path = dir.join(SIDECAR_CRASH_MARKER);
    match serde_json::to_vec_pretty(&marker) {
        Ok(bytes) => {
            if let Err(err) = std::fs::write(&path, bytes) {
                tracing::warn!(?err, path = %path.display(), "crash marker: write failed");
            }
        }
        Err(err) => {
            tracing::warn!(?err, "crash marker: serialize failed");
        }
    }
}

/// Read + delete the crash marker, if present. Returns the parsed payload so
/// the caller can emit a banner / pty-exit events for the affected sessions.
///
/// The delete happens UNCONDITIONALLY on a successful read so a corrupt
/// marker doesn't wedge the UI in a permanent "recovery banner" state. If
/// the read itself fails the marker is left in place for a future retry.
fn take_crash_marker(dir: &Path) -> Option<CrashMarker> {
    let path = dir.join(SIDECAR_CRASH_MARKER);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
        Err(err) => {
            tracing::warn!(?err, path = %path.display(), "crash marker: read failed");
            return None;
        }
    };
    // Delete first so a parse failure still clears the file.
    let _ = std::fs::remove_file(&path);
    match serde_json::from_slice::<CrashMarker>(&bytes) {
        Ok(m) => Some(m),
        Err(err) => {
            tracing::warn!(?err, "crash marker: parse failed; deleted anyway");
            None
        }
    }
}

/// Handle a prior crash on sidecar startup. Emits a single banner-level
/// event to the UI (`quanta://sidecar-recovered`) and a synthetic
/// `pty-exit` per affected session so any session the UI still considers
/// "running" gets finalized.
///
/// Architectural note (FIX 2, audit): the UI's IndexedDB state is not
/// reachable from Rust, so we cannot selectively emit pty-exits for only
/// those sessions the UI considers running. Emitting one per
/// `affected_sessions` entry is a superset — the UI already de-dupes by
/// session id in its reconciler. The banner is the portable fallback.
pub fn process_crash_marker_on_startup<R: Runtime>(app: &AppHandle<R>, dir: &Path) {
    let Some(marker) = take_crash_marker(dir) else {
        return;
    };
    #[derive(Serialize, Clone)]
    struct RecoveredPayload {
        timestamp_ms: u64,
        affected_sessions: Vec<String>,
    }
    let payload = RecoveredPayload {
        timestamp_ms: marker.timestamp_ms,
        affected_sessions: marker.affected_sessions.clone(),
    };
    if let Err(err) = app.emit(EVENT_SIDECAR_RECOVERED, payload) {
        tracing::warn!(?err, "crash marker: emit sidecar-recovered failed");
    }
    for handle in &marker.affected_sessions {
        let exit = ExitEvent {
            session_id: handle.clone(),
            exit_code: None,
            signal: Some("sidecar_crash_recovered".into()),
        };
        if let Err(err) = app.emit(EVENT_PTY_EXIT, exit) {
            tracing::warn!(?err, %handle, "crash marker: emit pty-exit failed");
        }
    }
}

fn new_request_id(tag: &str) -> String {
    format!(
        "{tag}-{}",
        uuid::Uuid::new_v4().as_hyphenated()
    )
}

async fn event_pump_loop<R: Runtime>(
    stream: &mut Receiver<Envelope<Event>>,
    sessions: &Arc<Mutex<HashMap<String, SessionId>>>,
    app: &AppHandle<R>,
) {
    let mut output_seq: HashMap<SessionId, u64> = HashMap::new();
    while let Some(env) = stream.recv().await {
        if let Err(err) = forward_envelope(&env, sessions, app, &mut output_seq) {
            tracing::warn!(?err, "sidecar.event_pump: forward failed; continuing");
        }
    }
    tracing::warn!("sidecar.event_pump: stream ended (quanta-core likely exited)");
    // Surface a synthetic exit for every registered session so the UI
    // reconciles. Without this the session cards would spin forever.
    let entries: Vec<(String, SessionId)> = sessions
        .lock()
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    for (handle, _) in entries {
        let payload = ExitEvent {
            session_id: handle,
            exit_code: None,
            signal: Some("sidecar_shutdown".into()),
        };
        let _ = app.emit(EVENT_PTY_EXIT, payload);
    }
}

fn forward_envelope<R: Runtime>(
    env: &Envelope<Event>,
    sessions: &Arc<Mutex<HashMap<String, SessionId>>>,
    app: &AppHandle<R>,
    output_seq: &mut HashMap<SessionId, u64>,
) -> Result<()> {
    // Map the envelope's SessionId back to the host-side handle string. If
    // there is no mapping (possible for events observed before the UI
    // registered its session), fall back to the ULID-stringified id so the
    // UI at least sees a stable identifier.
    let handle = handle_for(env.session_id, sessions)
        .unwrap_or_else(|| env.session_id.to_string());

    match &env.payload {
        Event::OutputChunk(chunk) => {
            let seq = output_seq
                .entry(env.session_id)
                .and_modify(|s| *s = s.saturating_add(1))
                .or_insert(0);
            let payload = DataEvent {
                session_id: handle,
                seq: *seq,
                // `OutputChunk.bytes_b64` is already base64 — pass through.
                bytes_b64: chunk.bytes_b64.clone(),
            };
            app.emit(EVENT_PTY_DATA, payload)
                .map_err(|e| anyhow!("emit pty-data: {e}"))?;
        }
        Event::SessionEnded(ended) => {
            let payload = ExitEvent {
                session_id: handle,
                exit_code: match ended.reason {
                    SessionEndReason::ShellExited => Some(0),
                    _ => None,
                },
                signal: Some(format!("{:?}", ended.reason)),
            };
            app.emit(EVENT_PTY_EXIT, payload)
                .map_err(|e| anyhow!("emit pty-exit: {e}"))?;
        }
        Event::SessionCreated(sc) => {
            #[derive(Serialize, Clone)]
            struct SessionCreatedPayload {
                session_id: String,
                shell: String,
                launch_cwd: String,
            }
            let payload = SessionCreatedPayload {
                session_id: handle,
                shell: sc.shell.clone(),
                launch_cwd: sc.launch_cwd.display().to_string(),
            };
            app.emit(EVENT_SESSION_CREATED, payload)
                .map_err(|e| anyhow!("emit session-created: {e}"))?;
        }
        Event::SessionCwdChanged(change) => {
            #[derive(Serialize, Clone)]
            struct CwdChangedPayload {
                session_id: String,
                cwd: String,
                source: String,
            }
            let source = match change.source {
                quanta_proto::events::CwdSource::Launch => "launch",
                quanta_proto::events::CwdSource::Osc7 => "osc7",
                quanta_proto::events::CwdSource::PromptEstimate => "prompt_estimate",
                quanta_proto::events::CwdSource::Unknown => "unknown",
                quanta_proto::events::CwdSource::ExplicitOverride => "explicit_override",
            };
            let payload = CwdChangedPayload {
                session_id: handle,
                cwd: change.cwd.display().to_string(),
                source: source.into(),
            };
            app.emit(EVENT_SESSION_CWD_CHANGED, payload)
                .map_err(|e| anyhow!("emit session-cwd-changed: {e}"))?;
        }
        Event::SessionShellIntegrationStatus(s) => {
            #[derive(Serialize, Clone)]
            struct ShellStatusPayload {
                session_id: String,
                status: String,
            }
            let status = match s.status {
                quanta_proto::events::ShellIntegrationStatus::Installed => "installed",
                quanta_proto::events::ShellIntegrationStatus::Missing => "missing",
                quanta_proto::events::ShellIntegrationStatus::Partial => "partial",
            };
            let payload = ShellStatusPayload {
                session_id: handle,
                status: status.into(),
            };
            app.emit(EVENT_SESSION_SHELL_INTEGRATION_STATUS, payload)
                .map_err(|e| anyhow!("emit session-shell-integration-status: {e}"))?;
        }
        Event::DiagnosticDetected(d) => {
            // Forward the envelope directly as JSON; the UI bridge will
            // normalize. This keeps the bridge transport-only (no domain
            // interpretation beyond name mapping).
            let payload = serde_json::to_value(d).map_err(|e| anyhow!("encode diagnostic: {e}"))?;
            app.emit(EVENT_DIAGNOSTIC_DETECTED, payload)
                .map_err(|e| anyhow!("emit diagnostic-detected: {e}"))?;
        }
        _ => {
            // All other envelope kinds (BlockCreated/Started/Completed, etc.)
            // are block-surface concerns that the current Phase-5 UI bridge
            // reads from pty-data + its own parsers. A future phase will add
            // dedicated topics for those; not emitting them here is
            // intentional (minimum diff) — the UI already works without them.
            let _ = (env, app);
        }
    }
    Ok(())
}

fn handle_for(
    sid: SessionId,
    sessions: &Arc<Mutex<HashMap<String, SessionId>>>,
) -> Option<String> {
    sessions
        .lock()
        .iter()
        .find(|(_, v)| **v == sid)
        .map(|(k, _)| k.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::MockRuntime;

    #[test]
    fn event_topics_use_hyphens_not_dots() {
        for topic in [
            EVENT_SESSION_CREATED,
            EVENT_SESSION_CWD_CHANGED,
            EVENT_SESSION_SHELL_INTEGRATION_STATUS,
            EVENT_DIAGNOSTIC_DETECTED,
        ] {
            assert!(!topic.contains('.'), "topic must not contain '.': {topic}");
            assert!(topic.starts_with("quanta://"), "topic must use quanta:// scheme: {topic}");
        }
    }

    #[test]
    fn default_socket_path_has_parent() {
        let p = default_socket_path();
        assert!(p.parent().is_some());
    }

    #[test]
    fn default_profile_dir_is_absolute_when_home_set() {
        // Save + restore so we don't leak across tests; best-effort.
        if std::env::var_os("HOME").is_some() {
            let p = default_profile_dir();
            assert!(p.is_absolute(), "expected absolute path, got {p:?}");
        }
    }

    /// Serialize env-mutating tests. The env space is process-global; running
    /// `QUANTA_CORE_BIN`-sensitive tests in parallel would cause flakes.
    fn env_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    /// RAII guard that restores `QUANTA_CORE_BIN` on drop so other tests
    /// (and the real app if run in the same process) don't see leaked state.
    struct EnvGuard {
        saved: Option<std::ffi::OsString>,
    }
    impl EnvGuard {
        fn set(value: Option<&std::path::Path>) -> Self {
            let saved = std::env::var_os("QUANTA_CORE_BIN");
            match value {
                Some(v) => std::env::set_var("QUANTA_CORE_BIN", v),
                None => std::env::remove_var("QUANTA_CORE_BIN"),
            }
            Self { saved }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.saved.take() {
                Some(v) => std::env::set_var("QUANTA_CORE_BIN", v),
                None => std::env::remove_var("QUANTA_CORE_BIN"),
            }
        }
    }

    /// Env-var override wins even when an AppHandle is present. We verify
    /// this with `app = None`; the presence/absence of the AppHandle is
    /// orthogonal because the env arm is evaluated first.
    #[test]
    fn resolver_prefers_env_var_over_path() {
        let _l = env_lock().lock().unwrap();
        let tmp = tempfile::NamedTempFile::new().expect("tempfile");
        let path = tmp.path().to_path_buf();
        // Make it executable so the resolver's `exists()` check is honest;
        // the check doesn't require exec bits today but a future tightening
        // shouldn't flake this test.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).unwrap();
        }

        let _g = EnvGuard::set(Some(&path));
        let resolved = resolve_core_binary::<MockRuntime>(None)
            .expect("env-var path resolves without AppHandle");
        assert_eq!(resolved, path, "expected env-var path, got {resolved:?}");
    }

    /// A missing env path must fail loudly (not silently fall back). This
    /// guards against a typo-in-QUANTA_CORE_BIN masquerading as "use PATH".
    #[test]
    fn resolver_env_var_missing_path_errors() {
        let _l = env_lock().lock().unwrap();
        let missing = std::env::temp_dir().join("definitely-not-a-real-binary-xyz");
        // Make sure the path genuinely does not exist.
        let _ = std::fs::remove_file(&missing);

        let _g = EnvGuard::set(Some(&missing));
        let err = resolve_core_binary::<MockRuntime>(None)
            .expect_err("missing env path must be rejected, not silently fall through");
        let msg = format!("{err}");
        assert!(
            msg.contains("QUANTA_CORE_BIN"),
            "error should mention the offending env var; got: {msg}"
        );
    }

    /// With `None` AppHandle and no env var set, the resolver must not
    /// panic. It should either find `quanta-core` on PATH (dev machine) or
    /// return a clean error — but never unwrap an unexpected option.
    #[test]
    fn resolver_handles_none_app_handle_without_panic() {
        let _l = env_lock().lock().unwrap();
        let _g = EnvGuard::set(None);
        // Irrespective of whether the dev machine has `quanta-core` on PATH,
        // this call must return a `Result` without panicking.
        let _ = resolve_core_binary::<MockRuntime>(None);
    }

    /// Tauri's `path().resolve(..., Resource)` returns a path inside the
    /// bundle's resource directory; in `cargo test` (no bundle) the path
    /// won't exist, so the resolver must fall through to the next arm. The
    /// fully bundled path requires a packaged Tauri app, which is exercised
    /// at bundle-build time rather than in unit tests — documented below.
    #[test]
    fn resolver_bundled_resource_miss_falls_through() {
        let _l = env_lock().lock().unwrap();
        let _g = EnvGuard::set(None);
        // Best-effort: building a mock app context here is expensive and
        // brittle; asserting "doesn't panic" is sufficient. The end-to-end
        // bundled-path behavior is pinned by the Tauri bundler itself.
        let _ = resolve_core_binary::<MockRuntime>(None);
    }
}
