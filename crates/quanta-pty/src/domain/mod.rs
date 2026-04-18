//! Domain types for the PTY aggregate.
//!
//! No IO, no async. Just values the session actor and adapters agree on.

use std::path::PathBuf;

/// Terminal window dimensions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
}

impl PtySize {
    #[must_use]
    pub fn new(cols: u16, rows: u16) -> Self {
        Self { cols, rows }
    }
}

impl Default for PtySize {
    fn default() -> Self {
        Self { cols: 80, rows: 24 }
    }
}

/// Specification for a PTY spawn.
#[derive(Clone, Debug)]
pub struct PtySpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub size: PtySize,
}

impl PtySpec {
    #[must_use]
    pub fn shell(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            size: PtySize::default(),
        }
    }

    #[must_use]
    pub fn with_arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    #[must_use]
    pub fn with_cwd(mut self, cwd: PathBuf) -> Self {
        self.cwd = Some(cwd);
        self
    }

    #[must_use]
    pub fn with_size(mut self, size: PtySize) -> Self {
        self.size = size;
        self
    }

    #[must_use]
    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }
}

/// Result of a PTY child process exiting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PtyExit {
    pub exit_code: Option<i32>,
    pub signal: Option<u32>,
}

impl PtyExit {
    #[must_use]
    pub fn code(exit_code: i32) -> Self {
        Self {
            exit_code: Some(exit_code),
            signal: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_defaults_to_80x24() {
        let s = PtySize::default();
        assert_eq!(s.cols, 80);
        assert_eq!(s.rows, 24);
    }

    #[test]
    fn size_constructor_preserves_values() {
        let s = PtySize::new(132, 43);
        assert_eq!(s.cols, 132);
        assert_eq!(s.rows, 43);
    }

    #[test]
    fn size_boundaries_u16_min_and_max() {
        // Legitimate edge: a 1x1 pty (trivially small) and the u16 ceiling.
        let tiny = PtySize::new(1, 1);
        assert_eq!(tiny.cols, 1);
        assert_eq!(tiny.rows, 1);
        let huge = PtySize::new(u16::MAX, u16::MAX);
        assert_eq!(huge.cols, u16::MAX);
    }

    #[test]
    fn size_equality_and_copy() {
        let a = PtySize::new(80, 24);
        let b = a; // Copy
        assert_eq!(a, b);
        let c = a;
        assert_eq!(a, c);
    }

    #[test]
    fn spec_builder_accumulates_args_and_env() {
        let spec = PtySpec::shell("bash")
            .with_arg("-lc")
            .with_arg("echo hi")
            .with_env("FOO", "bar")
            .with_size(PtySize::new(120, 40));
        assert_eq!(spec.program, "bash");
        assert_eq!(spec.args, vec!["-lc".to_string(), "echo hi".into()]);
        assert_eq!(spec.env, vec![("FOO".into(), "bar".into())]);
        assert_eq!(spec.size, PtySize::new(120, 40));
    }

    #[test]
    fn spec_builder_cwd_none_by_default_and_set_by_with_cwd() {
        let spec = PtySpec::shell("sh");
        assert!(spec.cwd.is_none());
        let spec = spec.with_cwd(std::path::PathBuf::from("/workspace"));
        assert_eq!(
            spec.cwd.as_deref(),
            Some(std::path::Path::new("/workspace"))
        );
    }

    #[test]
    fn spec_builder_env_is_stable_order() {
        // Order matters for shells that read duplicated vars.
        let spec = PtySpec::shell("sh")
            .with_env("A", "1")
            .with_env("B", "2")
            .with_env("A", "3");
        assert_eq!(
            spec.env,
            vec![
                ("A".into(), "1".into()),
                ("B".into(), "2".into()),
                ("A".into(), "3".into()),
            ]
        );
    }

    #[test]
    fn spec_shell_default_size_matches_ptysize_default() {
        let spec = PtySpec::shell("bash");
        assert_eq!(spec.size, PtySize::default());
        assert!(spec.args.is_empty());
        assert!(spec.env.is_empty());
    }

    #[test]
    fn exit_code_roundtrips() {
        let ex = PtyExit::code(0);
        assert_eq!(ex.exit_code, Some(0));
        assert!(ex.signal.is_none());
    }

    #[test]
    fn exit_signal_alone_has_no_code() {
        // Legitimate case: killed by SIGTERM (15) carries signal only.
        let ex = PtyExit {
            exit_code: None,
            signal: Some(15),
        };
        assert!(ex.exit_code.is_none());
        assert_eq!(ex.signal, Some(15));
    }

    #[test]
    fn exit_equality_and_copy() {
        let a = PtyExit::code(42);
        let b = a; // Copy
        assert_eq!(a, b);
    }
}
