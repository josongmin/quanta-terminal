//! Shell integration install wizard — back-end half.
//!
//! Owns the Tauri command `quanta_install_shell_integration`. Pairs with the
//! UI `features/shell-integration-wizard/` slice.
//!
//! Contract (per ADR 0002 "Execution Boundary Contract" §Degraded Mode):
//!
//!   1. The UI opens the wizard when `session.shellIntegration === 'missing'`.
//!   2. The wizard first previews the snippet (`confirm: false`) — this path
//!      MUST NOT mutate any file. The Rust command returns the snippet, the
//!      target dotfile path, and whether an install is already present.
//!   3. Only on an explicit second invocation with `confirm: true` do we
//!      append the guarded block. The idempotency guard is:
//!
//!        # >>> quanta shell integration >>>
//!        ... embedded script ...
//!        # <<< quanta shell integration <<<
//!
//!      If the guard header is already present in the file, install is a
//!      no-op and we return `already_installed: true`.
//!
//! Dotfile targets:
//!   - bash → `~/.bashrc`
//!   - zsh  → `~/.zshrc`
//!   - fish → `~/.config/fish/config.fish`   (parent dir auto-created)
//!
//! The scripts themselves are embedded at compile-time via `include_str!` so
//! that the command is self-contained and testable without Tauri's asset
//! resolver. The path in resources/ is canonical and CI ships them with the
//! bundle via `tauri.conf.json#bundle.resources` too, for the (future) case
//! where we want to `source` the file rather than inline it.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Guard block markers — these are the idempotency sentinel. Do not rename;
/// existing installs depend on exact-match detection.
pub const GUARD_START: &str = "# >>> quanta shell integration >>>";
pub const GUARD_END: &str = "# <<< quanta shell integration <<<";

/// Embedded scripts. Updated in lockstep with
/// `packages/host-tauri/resources/shell-integration/*.{sh,zsh,fish}`.
const BASH_SCRIPT: &str = include_str!("../../resources/shell-integration/bash.sh");
const ZSH_SCRIPT: &str = include_str!("../../resources/shell-integration/zsh.zsh");
const FISH_SCRIPT: &str = include_str!("../../resources/shell-integration/fish.fish");

/// Recognized shells. The TS layer uses the lowercase discriminant directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Shell {
    Bash,
    Zsh,
    Fish,
}

impl Shell {
    pub fn script(self) -> &'static str {
        match self {
            Shell::Bash => BASH_SCRIPT,
            Shell::Zsh => ZSH_SCRIPT,
            Shell::Fish => FISH_SCRIPT,
        }
    }

    /// Dotfile path relative to `$HOME`. fish lives under `.config/fish/` — we
    /// return that as a single relative path.
    pub fn dotfile_relative(self) -> &'static str {
        match self {
            Shell::Bash => ".bashrc",
            Shell::Zsh => ".zshrc",
            Shell::Fish => ".config/fish/config.fish",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct InstallArgs {
    pub shell: Shell,
    /// When `false`, the command returns a preview only — no file is mutated.
    /// Must be set to `true` in a SECOND invocation to actually append the
    /// block. This two-step dance is the "typed-to-confirm" UX promised by
    /// the wizard (opening the wizard ≠ installing).
    #[serde(default)]
    pub confirm: bool,
    /// Optional override for the target dotfile. Primarily for tests — when
    /// absent we derive from `$HOME` and `Shell::dotfile_relative`.
    #[serde(default)]
    pub target_path: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct InstallReply {
    /// Absolute path to the dotfile we would (or did) modify.
    pub target_path: String,
    /// The exact block we append (includes the guard header + footer).
    pub snippet: String,
    /// True iff a guard block was already present before this call.
    pub already_installed: bool,
    /// True when this call actually mutated the file. Always `false` in
    /// preview mode (`confirm: false`) and when `already_installed` was true.
    pub mutated: bool,
    /// Number of lines in the (post-mutation) file. Useful for the UI to
    /// display "appended 42 lines to ~/.zshrc" feedback.
    pub line_count: usize,
}

/// Error type serializable as a string (Tauri maps `Result<_, String>` to a
/// rejected invoke promise).
pub type InstallResult = Result<InstallReply, String>;

/// Resolve `$HOME` via `std::env`. Split out so tests can stub via
/// `target_path`.
fn home_dir_from_env() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn resolve_target(args: &InstallArgs) -> Result<PathBuf, String> {
    if let Some(p) = &args.target_path {
        return Ok(PathBuf::from(p));
    }
    let home = home_dir_from_env().ok_or_else(|| "shell-integration: $HOME is not set".to_string())?;
    Ok(home.join(args.shell.dotfile_relative()))
}

/// Build the full guard block (header, script, footer) for a given shell.
pub fn build_snippet(shell: Shell) -> String {
    // Leading newline so that appending to a file that already ends without
    // a trailing newline produces clean output.
    let mut s = String::with_capacity(shell.script().len() + 128);
    s.push('\n');
    s.push_str(GUARD_START);
    s.push('\n');
    s.push_str(shell.script());
    // Ensure the embedded script ends with a newline before the footer —
    // `include_str!` preserves the file's trailing newline but be defensive.
    if !s.ends_with('\n') {
        s.push('\n');
    }
    s.push_str(GUARD_END);
    s.push('\n');
    s
}

/// True if the file already contains our guard header. We match on the header
/// alone (not header+footer) so a partially-corrupted install still registers
/// as "present" and the wizard no-ops rather than appending a duplicate.
fn already_installed(path: &Path) -> Result<bool, String> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(contents.contains(GUARD_START)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(format!("shell-integration: read {:?} failed: {err}", path)),
    }
}

/// Public install entry point. Shared between the Tauri command and unit tests.
pub fn install(args: InstallArgs) -> InstallResult {
    let target = resolve_target(&args)?;
    let snippet = build_snippet(args.shell);
    let present = already_installed(&target)?;

    // Preview path — never mutate, regardless of current installation state.
    if !args.confirm {
        let line_count = match fs::read_to_string(&target) {
            Ok(c) => c.lines().count(),
            Err(_) => 0,
        };
        return Ok(InstallReply {
            target_path: path_to_string(&target)?,
            snippet,
            already_installed: present,
            mutated: false,
            line_count,
        });
    }

    // Already installed — no-op. Report line count and present=true so the UI
    // can surface "already installed" instead of a mutation toast.
    if present {
        let line_count = fs::read_to_string(&target).map(|c| c.lines().count()).unwrap_or(0);
        return Ok(InstallReply {
            target_path: path_to_string(&target)?,
            snippet,
            already_installed: true,
            mutated: false,
            line_count,
        });
    }

    // Mutation path. Ensure parent directory exists (fish's ~/.config/fish/
    // case) before opening the file for append.
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("shell-integration: mkdir {:?} failed: {e}", parent))?;
    }

    // Read → append → write atomically. We use read+write instead of an
    // append-mode open because some shells (especially ones with set -e)
    // misbehave if the file has mixed newline endings; a read lets us
    // normalize the trailing newline.
    let existing = match fs::read_to_string(&target) {
        Ok(c) => c,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(format!("shell-integration: read {:?} failed: {err}", target)),
    };

    let mut combined = existing;
    if !combined.is_empty() && !combined.ends_with('\n') {
        combined.push('\n');
    }
    combined.push_str(&snippet);

    fs::write(&target, &combined)
        .map_err(|e| format!("shell-integration: write {:?} failed: {e}", target))?;

    Ok(InstallReply {
        target_path: path_to_string(&target)?,
        snippet,
        already_installed: false,
        mutated: true,
        line_count: combined.lines().count(),
    })
}

fn path_to_string(p: &Path) -> Result<String, String> {
    p.to_str()
        .map(|s| s.to_owned())
        .ok_or_else(|| format!("shell-integration: non-utf8 path {:?}", p))
}

/* -------------------- Tauri command -------------------- */

#[tauri::command]
pub async fn quanta_install_shell_integration(args: InstallArgs) -> InstallResult {
    tracing::info!(
        shell = ?args.shell,
        confirm = args.confirm,
        target = ?args.target_path,
        "install_shell_integration"
    );
    // The work is purely filesystem-bound and already fast; no need to spawn
    // on a worker. Tauri invokes commands on a worker thread already.
    install(args)
}

/* -------------------- tests -------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "quanta-shell-integration-test-{}-{}",
            std::process::id(),
            // add a nanosecond component so parallel tests get distinct dirs
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0),
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn build_snippet_wraps_with_guard_header_and_footer() {
        let s = build_snippet(Shell::Bash);
        assert!(s.contains(GUARD_START), "missing guard start");
        assert!(s.contains(GUARD_END), "missing guard end");
        // The embedded script's own marker line confirms the script is inside
        // the guard block (Quanta's bash script contains "QUANTA_SHELL_INTEGRATION_LOADED").
        assert!(s.contains("QUANTA_SHELL_INTEGRATION_LOADED"));
    }

    #[test]
    fn preview_does_not_mutate_missing_file() {
        let target = tmp_path(".zshrc-preview");
        assert!(!target.exists());
        let reply = install(InstallArgs {
            shell: Shell::Zsh,
            confirm: false,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert!(!reply.mutated, "preview must not mutate");
        assert!(!reply.already_installed);
        assert!(!target.exists(), "preview must not create the file");
        assert!(reply.snippet.contains(GUARD_START));
    }

    #[test]
    fn confirm_writes_snippet_to_file() {
        let target = tmp_path(".bashrc-write");
        let reply = install(InstallArgs {
            shell: Shell::Bash,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert!(reply.mutated);
        assert!(!reply.already_installed);
        let contents = fs::read_to_string(&target).unwrap();
        assert!(contents.contains(GUARD_START));
        assert!(contents.contains(GUARD_END));
        assert!(contents.contains("QUANTA_SHELL_INTEGRATION_LOADED"));
    }

    #[test]
    fn install_is_idempotent_on_second_run() {
        let target = tmp_path(".zshrc-idem");
        let first = install(InstallArgs {
            shell: Shell::Zsh,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert!(first.mutated);
        let contents_after_first = fs::read_to_string(&target).unwrap();

        let second = install(InstallArgs {
            shell: Shell::Zsh,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert!(!second.mutated, "second confirm call must be a no-op");
        assert!(second.already_installed);

        let contents_after_second = fs::read_to_string(&target).unwrap();
        assert_eq!(
            contents_after_first, contents_after_second,
            "file contents must be unchanged on the second run"
        );
    }

    #[test]
    fn preserves_existing_file_content_and_appends_after() {
        let target = tmp_path(".bashrc-preexisting");
        let pre = "# user's own bashrc\nexport FOO=bar\n";
        {
            let mut f = fs::File::create(&target).unwrap();
            f.write_all(pre.as_bytes()).unwrap();
        }
        let reply = install(InstallArgs {
            shell: Shell::Bash,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert!(reply.mutated);
        let contents = fs::read_to_string(&target).unwrap();
        assert!(contents.starts_with(pre), "pre-existing content was clobbered");
        assert!(contents.contains(GUARD_START));
        // Block must come after the user content.
        assert!(
            contents.find(pre).unwrap() < contents.find(GUARD_START).unwrap(),
            "guard block must be appended after existing content"
        );
    }

    #[test]
    fn preview_reports_already_installed_when_block_present() {
        let target = tmp_path(".zshrc-already");
        // First install.
        install(InstallArgs {
            shell: Shell::Zsh,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        // Preview now reports already_installed.
        let preview = install(InstallArgs {
            shell: Shell::Zsh,
            confirm: false,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert!(preview.already_installed);
        assert!(!preview.mutated);
    }

    #[test]
    fn fish_creates_parent_config_directory() {
        // Point the target at a nested path that doesn't exist; install must
        // create ~/.config/fish/ equivalent.
        let root = tmp_path("fish-root").parent().unwrap().to_path_buf();
        let nested = root.join("deep/fish/config.fish");
        assert!(!nested.exists());
        let reply = install(InstallArgs {
            shell: Shell::Fish,
            confirm: true,
            target_path: Some(nested.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert!(reply.mutated);
        assert!(nested.exists());
        let contents = fs::read_to_string(&nested).unwrap();
        assert!(contents.contains("QUANTA_SHELL_INTEGRATION_LOADED"));
    }

    #[test]
    fn every_shell_has_distinct_script() {
        let b = build_snippet(Shell::Bash);
        let z = build_snippet(Shell::Zsh);
        let f = build_snippet(Shell::Fish);
        assert_ne!(b, z);
        assert_ne!(z, f);
        assert_ne!(b, f);
    }

    #[test]
    fn scripts_emit_osc_133_markers() {
        // A/B/C/D must appear literally in every script.
        for script in [BASH_SCRIPT, ZSH_SCRIPT, FISH_SCRIPT] {
            assert!(script.contains("133;A"), "script missing 133;A marker");
            assert!(script.contains("133;B"), "script missing 133;B marker");
            assert!(script.contains("133;C"), "script missing 133;C marker");
            assert!(script.contains("133;D"), "script missing 133;D marker");
        }
    }

    #[test]
    fn scripts_emit_osc_7_and_1337_cwd() {
        // OSC 7 + iTerm2 OSC 1337 CurrentDir in bash + zsh. Fish emits the
        // same pair via __quanta_emit_cwd.
        for script in [BASH_SCRIPT, ZSH_SCRIPT, FISH_SCRIPT] {
            assert!(script.contains("7;file://") || script.contains("7;file:/"));
            assert!(script.contains("1337;CurrentDir="));
        }
    }

    #[test]
    fn scripts_are_idempotent_via_guard_variable() {
        // Each script must check QUANTA_SHELL_INTEGRATION_LOADED before binding.
        for script in [BASH_SCRIPT, ZSH_SCRIPT, FISH_SCRIPT] {
            assert!(
                script.contains("QUANTA_SHELL_INTEGRATION_LOADED"),
                "script missing idempotency guard"
            );
        }
    }
}
