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
use tauri::{AppHandle, Emitter, Runtime};
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
    /// Build a config from environment variables with sensible defaults.
    ///
    /// Precedence:
    /// - `QUANTA_CORE_BIN` → binary path
    /// - `QUANTA_SOCKET_PATH` → socket path (default:
    ///   `$XDG_RUNTIME_DIR/quanta/core.sock` or `$TMPDIR/quanta-core-$PID.sock`)
    /// - `QUANTA_PROFILE_DIR` → profile dir (default: `$HOME/.local/share/quanta`)
    pub fn from_env() -> Result<Self> {
        let binary = std::env::var_os("QUANTA_CORE_BIN")
            .map(PathBuf::from)
            .ok_or_else(|| {
                anyhow!(
                    "QUANTA_CORE_BIN env var is not set. \
                    The sidecar feature requires an absolute path to a built `quanta-core` binary.",
                )
            })?;
        if !binary.exists() {
            bail!("QUANTA_CORE_BIN points to missing path: {}", binary.display());
        }
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

    #[allow(
        dead_code,
        reason = "cancel is wired on the IPC surface in a follow-up; kept public now so tests and future commands can target it without a Cargo.toml change."
    )]
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
            None => return Ok(()), // idempotent
        };
        let req = RpcMethod::CloseSession(CloseSession { session_id: sid });
        let resp = self
            .client
            .call(new_request_id("close"), req)
            .await
            .context("CloseSession rpc")?;
        if let RpcResult::Err { error } = resp.result {
            // Log and continue — the host side already dropped its mapping.
            tracing::warn!(
                code = %error.code,
                message = %error.message,
                "CloseSession returned error; dropping handle anyway",
            );
        }
        Ok(())
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
}
