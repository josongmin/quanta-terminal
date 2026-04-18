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
