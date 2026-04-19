//! Session domain types — pure.

use std::path::PathBuf;

use quanta_proto::events::{CwdSource, InputKind, ShellIntegrationStatus};

pub use quanta_proto::ids::SessionId;

/// Startup config for a session.
#[derive(Clone, Debug)]
pub struct SessionConfig {
    pub shell: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    /// EPIC-F — feed PTY bytes through `quanta_vt::Grid` and emit
    /// `TerminalEvent`-flavored envelopes in addition to the legacy
    /// `OutputChunk` stream.
    ///
    /// Defaults to `true`. Set to `false` for pre-EPIC-F rollback behavior
    /// (OutputChunk-only emission). Flag is removed in EPIC-I once xterm.js
    /// is deleted from the UI; until then, consumers may flip it back to
    /// `false` without data migration.
    pub use_vt_engine: bool,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            shell: String::new(),
            args: Vec::new(),
            cwd: PathBuf::new(),
            cols: 80,
            rows: 24,
            use_vt_engine: true,
        }
    }
}

impl SessionConfig {
    #[must_use]
    pub fn default_login(shell: impl Into<String>, cwd: PathBuf) -> Self {
        Self {
            shell: shell.into(),
            args: Vec::new(),
            cwd,
            cols: 80,
            rows: 24,
            use_vt_engine: true,
        }
    }
}

/// A single piece of user input the session should deliver to the PTY.
#[derive(Clone, Debug)]
pub struct InputSubmission {
    pub text: String,
    pub kind: InputKind,
    /// Whether to append a carriage return.
    pub submit: bool,
}

/// A snapshot of the session's observable metadata (ADR 0003).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionSnapshot {
    pub session_id: SessionId,
    pub shell_integration_status: ShellIntegrationStatus,
    pub cwd: PathBuf,
    pub cwd_source: CwdSource,
    /// EPIC-F — current VT engine epoch. Bumps on reconnect / reinit.
    /// See ADR 0017 §3.
    pub grid_epoch: u64,
    /// EPIC-F — current resize generation. Bumps on every resize that
    /// affects wrap/reflow.
    pub resize_generation: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_login_populates_defaults() {
        let cfg = SessionConfig::default_login("/bin/bash", PathBuf::from("/tmp"));
        assert_eq!(cfg.shell, "/bin/bash");
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert_eq!(cfg.cwd, PathBuf::from("/tmp"));
    }

    #[test]
    fn default_login_has_no_args() {
        let cfg = SessionConfig::default_login("/bin/zsh", PathBuf::from("/"));
        assert!(cfg.args.is_empty());
    }

    #[test]
    fn snapshot_equality() {
        let id = SessionId::new();
        let a = SessionSnapshot {
            session_id: id,
            shell_integration_status: ShellIntegrationStatus::Missing,
            cwd: PathBuf::from("/tmp"),
            cwd_source: CwdSource::Launch,
            grid_epoch: 1,
            resize_generation: 0,
        };
        let b = a.clone();
        assert_eq!(a, b);
    }

    #[test]
    fn snapshot_inequality_on_cwd_change() {
        let id = SessionId::new();
        let a = SessionSnapshot {
            session_id: id,
            shell_integration_status: ShellIntegrationStatus::Installed,
            cwd: PathBuf::from("/tmp"),
            cwd_source: CwdSource::Osc7,
            grid_epoch: 1,
            resize_generation: 0,
        };
        let mut b = a.clone();
        b.cwd = PathBuf::from("/home/alice");
        assert_ne!(a, b);
    }

    #[test]
    fn input_submission_submit_flag_preserved() {
        let s = InputSubmission {
            text: "ls".into(),
            kind: InputKind::Shell,
            submit: true,
        };
        assert!(s.submit);
        let p = InputSubmission {
            text: "\x03".into(),
            kind: InputKind::Shell,
            submit: false,
        };
        assert!(!p.submit);
    }
}
