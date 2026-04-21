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

/// Disable cooked-mode `ECHO` on the PTY line discipline so the shell
/// doesn't echo bytes we write back to us.
///
/// **Bug history**: the previous implementation set termios on the
/// MASTER fd, which `pty(4)` on macOS and `pty(7)` on Linux both
/// describe as a no-op for line-discipline flags ("Ioctls affecting
/// the underlying device driver such as TIOC_{GET,SET}ATTR are only
/// honored on the slave side"). That manifested as the user-visible
/// "ls → lls", "cd → ccd" command-doubling in block output: the tty
/// line discipline was still echoing every char, and zsh's zle was
/// echoing each char again, producing a duplicated first character at
/// the head of the next command's output. The fix opens the slave fd
/// via `ptsname` and clears ECHO there — the same approach used by
/// iTerm2, Alacritty, and libvte.
///
/// Unix-only; ConPTY doesn't expose termios at all.
#[cfg(unix)]
fn disable_echo(master: &dyn MasterPty) {
    use std::ffi::CStr;
    use std::os::fd::{BorrowedFd, RawFd};

    use nix::sys::termios::{tcgetattr, tcsetattr, LocalFlags, SetArg};

    let Some(master_fd) = master.as_raw_fd() else {
        return;
    };

    // ptsname returns a static buffer — copy it out immediately so we
    // don't race any other libc caller in the process.
    //
    // SAFETY: `master_fd` is a live, owned fd held by the caller; we
    // read its pts mapping and immediately copy the returned static
    // string.
    #[allow(unsafe_code)]
    let slave_path = unsafe {
        let ptr = libc::ptsname(master_fd);
        if ptr.is_null() {
            tracing::warn!("embedded_shell: ptsname returned null; echo stays on");
            return;
        }
        CStr::from_ptr(ptr).to_owned()
    };

    // Reopen the slave read-write. O_NOCTTY avoids stealing the slave
    // as our controlling terminal — the child needs to claim it.
    //
    // SAFETY: `slave_path` is a valid owned CString.
    #[allow(unsafe_code)]
    let slave_fd: RawFd = unsafe {
        libc::open(slave_path.as_ptr(), libc::O_RDWR | libc::O_NOCTTY)
    };
    if slave_fd < 0 {
        tracing::warn!(
            "embedded_shell: open({:?}) failed; echo stays on: {}",
            slave_path,
            std::io::Error::last_os_error(),
        );
        return;
    }

    // RAII guard so we close the slave fd even if tcsetattr panics.
    struct AutoClose(RawFd);
    impl Drop for AutoClose {
        fn drop(&mut self) {
            #[allow(unsafe_code)]
            unsafe { libc::close(self.0); }
        }
    }
    let _guard = AutoClose(slave_fd);

    // SAFETY: `slave_fd` lives until `_guard` drops at end of scope.
    #[allow(unsafe_code)]
    let fd = unsafe { BorrowedFd::borrow_raw(slave_fd) };
    let Ok(mut t) = tcgetattr(fd) else {
        tracing::warn!("embedded_shell: tcgetattr on slave failed; echo stays on");
        return;
    };
    t.local_flags.remove(
        LocalFlags::ECHO
            | LocalFlags::ECHOE
            | LocalFlags::ECHOK
            | LocalFlags::ECHOKE
            | LocalFlags::ECHOCTL
            | LocalFlags::ECHONL,
    );
    if let Err(err) = tcsetattr(fd, SetArg::TCSANOW, &t) {
        tracing::warn!(%err, "embedded_shell: tcsetattr to clear ECHO failed");
    }
}

#[cfg(not(unix))]
fn disable_echo(_master: &dyn MasterPty) {
    // ConPTY on Windows has no termios concept; cooked-mode echo is
    // handled differently and not the source of our block-output
    // duplication bug.
}

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

        // Disable line-discipline ECHO BEFORE spawn so the child inherits
        // it off. Prevents the cooked-mode shell from echoing bytes we
        // write (Composer input) back as fake "output" bytes.
        disable_echo(pair.master.as_ref());

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
    } else if is_wsl() {
        // Running on the Linux kernel shim embedded in Windows: the Linux
        // branch already picks `/bin/bash`, but we spell out the WSL case
        // explicitly so future changes (e.g. prefer `wsl.exe bash` to
        // straddle a Windows-host process) have an obvious seam.
        "/bin/bash".to_string()
    } else {
        "/bin/bash".to_string()
    }
}

/// Detect whether the current Linux kernel is running inside WSL.
///
/// WSL1 / WSL2 both surface a `/proc/version` string containing
/// "Microsoft" (capital M, historical) or "WSL" (lowercase, WSL2+). We
/// check both — the test harness swaps `/proc/version` for a fixture via
/// the `QUANTA_WSL_PROC_VERSION_OVERRIDE` env var to exercise this
/// without a real Microsoft kernel. On non-Linux targets this is a
/// compile-time false.
pub fn is_wsl() -> bool {
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
    #[cfg(target_os = "linux")]
    {
        is_wsl_from_proc_version(read_wsl_proc_version().as_deref())
    }
}

#[cfg(target_os = "linux")]
fn read_wsl_proc_version() -> Option<String> {
    // Test-friendly override: when set, tests inject a synthetic version
    // string so we don't need the real `/proc/version` (which on the CI
    // runners is always vanilla Linux, never Microsoft).
    if let Ok(override_text) = std::env::var("QUANTA_WSL_PROC_VERSION_OVERRIDE") {
        return Some(override_text);
    }
    std::fs::read_to_string("/proc/version").ok()
}

/// Pure detection helper — exported for unit tests. The `version` string is
/// whatever `/proc/version` would have returned (or a fixture).
pub fn is_wsl_from_proc_version(version: Option<&str>) -> bool {
    let Some(v) = version else {
        return false;
    };
    v.contains("Microsoft") || v.contains("microsoft") || v.contains("WSL")
}

/// Best-effort home directory for the current session.
///
/// On WSL the Linux `$HOME` is the preferred launch cwd — it matches user
/// expectations when they drop into the terminal (code/bash under `~`). The
/// `/mnt/c/Users/...` fallback is retained for hosts that launch without
/// `$HOME` (rare but seen on some startup scripts); we probe `USER` /
/// `USERNAME` to synthesize the Windows home path.
#[allow(dead_code)]
pub fn wsl_default_cwd() -> Option<String> {
    if !is_wsl() {
        return None;
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return Some(home);
        }
    }
    let user = std::env::var("USER")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("USERNAME").ok().filter(|s| !s.is_empty()))?;
    Some(format!("/mnt/c/Users/{user}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_microsoft_capital_m() {
        assert!(is_wsl_from_proc_version(Some(
            "Linux version 5.10.102.1-microsoft-standard-WSL2 (...)"
        )));
        assert!(is_wsl_from_proc_version(Some(
            "Linux version 4.4.0-19041-Microsoft"
        )));
    }

    #[test]
    fn detects_wsl_token() {
        assert!(is_wsl_from_proc_version(Some(
            "Linux version 5.15.90.1-WSL2-standard"
        )));
    }

    #[test]
    fn rejects_vanilla_linux() {
        assert!(!is_wsl_from_proc_version(Some(
            "Linux version 6.5.0-21-generic (buildd@ubuntu)"
        )));
        assert!(!is_wsl_from_proc_version(Some("Linux version 5.10.0-0-arm64")));
    }

    #[test]
    fn rejects_missing_file() {
        assert!(!is_wsl_from_proc_version(None));
    }
}
