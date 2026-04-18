//! Embedded dev shell (Phase 1 only — see ADR 0001 / ADR 0004).
//!
//! DEV STUB, MARKED FOR REMOVAL.
//! ------------------------------------------------------------------
//! This module spawns a shell with `portable-pty` directly inside the
//! Tauri process so the walking skeleton works before the real
//! `quanta-core` sidecar exists. Once the sidecar lands:
//!   1. Drop this module.
//!   2. Rewire `ipc::quanta_*` commands to speak JSON-RPC over the
//!      sidecar's Unix domain socket (see ADR 0004).
//!   3. Remove `feature = "embedded-shell"` and its deps from Cargo.toml.
//!
//! The PTY is drained on a dedicated thread; output bytes are forwarded to
//! Tauri events by the caller in `ipc::wire_events`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};

pub struct EmbeddedShell;

pub struct SpawnedSession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    reader: Arc<Mutex<Box<dyn Read + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    pub shell_label: String,
    pub cwd: String,
    killed: AtomicBool,
}

impl EmbeddedShell {
    pub fn spawn(
        _session_id: &str,
        shell: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        env: HashMap<String, String>,
    ) -> anyhow::Result<SpawnedSession> {
        let shell_path = shell
            .or_else(|| std::env::var("SHELL").ok())
            .unwrap_or_else(default_shell);
        let launch_cwd = cwd
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| "/".to_string());

        let pty_system = NativePtySystem::default();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(&shell_path);
        cmd.cwd(&launch_cwd);

        // Sensible shell env defaults. The inherited process environment would
        // be picked up automatically by `portable-pty`, but we explicitly pin a
        // few terminal-facing vars so xterm.js behaves predictably.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env(
            "LANG",
            std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()),
        );
        // Per-caller overrides win.
        for (k, v) in env {
            cmd.env(k, v);
        }

        let child = pair.slave.spawn_command(cmd)?;

        let writer = pair.master.take_writer()?;
        let reader = pair.master.try_clone_reader()?;

        Ok(SpawnedSession {
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            reader: Arc::new(Mutex::new(reader)),
            child: Arc::new(Mutex::new(child)),
            shell_label: shell_path,
            cwd: launch_cwd,
            killed: AtomicBool::new(false),
        })
    }
}

impl SpawnedSession {
    pub fn write(&self, bytes: &[u8]) -> anyhow::Result<()> {
        let mut w = self.writer.lock();
        w.write_all(bytes)?;
        w.flush()?;
        Ok(())
    }

    pub fn read(&self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut r = self.reader.lock();
        r.read(buf)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.master.lock().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&self) {
        if self.killed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Err(err) = self.child.lock().kill() {
            tracing::warn!(%err, "failed to kill child; probably already exited");
        }
    }

    pub fn wait_exit(&self) -> Option<i32> {
        let mut child = self.child.lock();
        match child.wait() {
            Ok(status) => {
                let code: u32 = status.exit_code();
                i32::try_from(code).ok()
            }
            Err(err) => {
                tracing::warn!(%err, "wait failed");
                None
            }
        }
    }
}

fn default_shell() -> String {
    if cfg!(target_os = "macos") {
        "/bin/zsh".to_string()
    } else if cfg!(target_os = "windows") {
        "cmd.exe".to_string()
    } else {
        "/bin/bash".to_string()
    }
}
