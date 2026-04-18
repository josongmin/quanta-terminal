//! IPC façade — Tauri commands + event topics consumed by the TS bridge.
//!
//! Kept intentionally small. The shape here is what the real `quanta-core`
//! sidecar will mirror over its JSON-RPC channel (see ADR 0004). Adding a new
//! command requires adding the corresponding TS wrapper in `packages/host-tauri`
//! and typing it in `@quanta/host-common`.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(feature = "embedded-shell")]
use crate::embedded_shell::{EmbeddedShell, SpawnedSession};

/// Opaque session id shared with the TS side.
pub type SessionId = String;

pub struct AppState {
    sessions: Mutex<HashMap<SessionId, Arc<SessionHandle>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

/// A live session. In Phase 1 this wraps an embedded PTY directly; when the
/// real sidecar arrives this becomes a handle on an RPC session id.
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

#[tauri::command]
pub async fn quanta_spawn_session(
    args: SpawnArgs,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SpawnReply, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    tracing::info!(%session_id, ?args, "spawn session");

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
        .map_err(|e| format!("spawn failed: {e}"))?;

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

    #[cfg(not(feature = "embedded-shell"))]
    {
        let _ = (app, state);
        Err("no shell backend available: rebuild with the `embedded-shell` feature or connect a `quanta-core` sidecar".to_string())
    }
}

#[tauri::command]
pub async fn quanta_write(
    session_id: SessionId,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let handle = state
        .sessions
        .lock()
        .get(&session_id)
        .cloned()
        .ok_or_else(|| format!("unknown session {session_id}"))?;

    #[cfg(feature = "embedded-shell")]
    {
        handle
            .embedded
            .write(data.as_bytes())
            .map_err(|e| format!("write failed: {e}"))?;
        return Ok(());
    }

    #[cfg(not(feature = "embedded-shell"))]
    {
        let _ = (handle, data);
        Err("write unavailable without embedded-shell feature".into())
    }
}

#[tauri::command]
pub async fn quanta_resize(
    session_id: SessionId,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let handle = state
        .sessions
        .lock()
        .get(&session_id)
        .cloned()
        .ok_or_else(|| format!("unknown session {session_id}"))?;

    #[cfg(feature = "embedded-shell")]
    {
        handle
            .embedded
            .resize(cols, rows)
            .map_err(|e| format!("resize failed: {e}"))?;
        return Ok(());
    }

    #[cfg(not(feature = "embedded-shell"))]
    {
        let _ = (handle, cols, rows);
        Ok(())
    }
}

#[tauri::command]
pub async fn quanta_close(
    session_id: SessionId,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let handle = state.sessions.lock().remove(&session_id);
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
                    if app_data.emit("quanta://pty.data", payload).is_err() {
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
        let _ = app_exit.emit("quanta://pty.exit", payload);
    });
}
