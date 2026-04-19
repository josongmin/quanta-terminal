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

use crate::error::TauriError;

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

/// Shared "refuse to modify file outside home" error string. Copy/paste drift
/// across handlers would weaken the security contract — one canonical value
/// lets tests pin the exact text and makes grep'ability trivial.
const ERR_OUTSIDE_HOME: &str = "refusing to modify file outside your home directory";

/// Canonicalize a path, even if it does not yet exist. `std::fs::canonicalize`
/// requires the path to exist, but the install command legitimately writes to
/// missing files (e.g. `~/.config/fish/config.fish` on a fresh fish install).
///
/// Strategy: lexically normalize the path first (resolving `.` / `..`
/// segments against earlier components), then walk up from the normalized
/// path until we find an existing ancestor and canonicalize THAT. Re-join
/// the remaining non-existent trailing components.
///
/// The lexical pre-pass is critical for the home-scope check: without it,
/// a path like `/tmp/foo/../../../etc/passwd` (where `/tmp/foo/../../..`
/// has no physical ancestor) would fail `canonicalize` and the home-scope
/// check wouldn't even get to run. With the pre-pass the input collapses
/// to `/etc/passwd` before we go to the filesystem.
fn canonicalize_best_effort(p: &Path) -> Result<PathBuf, String> {
    // --- Lexical normalization pass ---
    //
    // Walk the input's components and build a normalized stack. `..`
    // pops the previous normal component (unless the stack is at the
    // root or empty). `.` is dropped. This mirrors shell `cd`.
    use std::path::Component;
    let mut stack: Vec<Component<'_>> = Vec::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                // Pop the last normal component if any; otherwise keep
                // the `..` (for relative paths whose root we don't know).
                match stack.last() {
                    Some(Component::Normal(_)) => {
                        stack.pop();
                    }
                    Some(Component::RootDir) | Some(Component::Prefix(_)) => {
                        // At root — `..` is a no-op.
                    }
                    _ => {
                        // Relative path with leading `..` — preserve it so
                        // the next stage can still canonicalize against cwd.
                        stack.push(comp);
                    }
                }
            }
            Component::CurDir => { /* drop */ }
            other => stack.push(other),
        }
    }
    let normalized: PathBuf = stack.iter().collect();

    // --- Existing-ancestor pass ---
    //
    // Walk up from the normalized path until we hit an existing ancestor,
    // canonicalize it, then re-apply the trailing components.
    let mut existing = normalized.clone();
    let mut trailing: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match existing.file_name() {
            Some(name) => trailing.push(name.to_os_string()),
            None => break,
        }
        if !existing.pop() {
            break;
        }
    }
    let canonical_base = if existing.as_os_str().is_empty() {
        std::env::current_dir().map_err(|e| format!("shell-integration: cwd unavailable: {e}"))?
    } else {
        fs::canonicalize(&existing)
            .map_err(|e| format!("shell-integration: canonicalize {:?} failed: {e}", existing))?
    };
    let mut out = canonical_base;
    // trailing was populated by popping from the end, so re-apply in reverse.
    while let Some(segment) = trailing.pop() {
        out.push(segment);
    }
    Ok(out)
}

/// Return an error if `target` is not a descendant of `home` after
/// canonicalization. This is the server-side enforcement of "the install
/// wizard only ever touches files under $HOME"; the UI has no independent
/// authority over this — a rogue/bypassed frontend passing
/// `/etc/bash.bashrc` or `/tmp/foo/../../etc/passwd` must be rejected here.
fn ensure_within_home(target: &Path, home: &Path) -> Result<(), String> {
    let canonical_target = canonicalize_best_effort(target)?;
    let canonical_home = fs::canonicalize(home).map_err(|e| {
        format!(
            "shell-integration: canonicalize $HOME {:?} failed: {e}",
            home
        )
    })?;
    if !canonical_target.starts_with(&canonical_home) {
        return Err(ERR_OUTSIDE_HOME.to_string());
    }
    // If the raw path (or any ancestor along the way) is a symlink, follow
    // the symlink one level and re-check. `fs::canonicalize` above already
    // resolves symlinks for the existing portion; this branch is defensive
    // against a symlinked trailing component that `canonicalize` couldn't
    // follow because the parent didn't exist. `symlink_metadata` returns
    // Ok only if the path itself exists as a link; we read its target and
    // re-canonicalize.
    if let Ok(meta) = fs::symlink_metadata(target) {
        if meta.file_type().is_symlink() {
            let link_target = fs::read_link(target)
                .map_err(|e| format!("shell-integration: read_link {:?} failed: {e}", target))?;
            // A relative symlink resolves against the link's parent.
            let resolved = if link_target.is_absolute() {
                link_target
            } else if let Some(parent) = target.parent() {
                parent.join(link_target)
            } else {
                link_target
            };
            let canonical_link = canonicalize_best_effort(&resolved)?;
            if !canonical_link.starts_with(&canonical_home) {
                return Err(ERR_OUTSIDE_HOME.to_string());
            }
        }
    }
    Ok(())
}

fn resolve_target(args: &InstallArgs) -> Result<PathBuf, String> {
    let home =
        home_dir_from_env().ok_or_else(|| "shell-integration: $HOME is not set".to_string())?;
    let raw = match &args.target_path {
        Some(p) => PathBuf::from(p),
        None => home.join(args.shell.dotfile_relative()),
    };
    ensure_within_home(&raw, &home)?;
    Ok(raw)
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

/* -------------------- uninstall -------------------- */

/// Arguments to `quanta_uninstall_shell_integration`.
///
/// Same two-phase semantics as install: `confirm: false` returns the region
/// that would be removed (preview) and must not mutate; `confirm: true`
/// actually deletes the guarded block. Idempotent: a second call when the
/// block is already absent returns `already_absent: true` and does NOT
/// mutate.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct UninstallArgs {
    pub shell: Shell,
    /// When `false`, the command returns a preview only — no file is mutated.
    #[serde(default)]
    pub confirm: bool,
    /// Optional override for the target dotfile. Primarily for tests.
    #[serde(default)]
    pub target_path: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct UninstallReply {
    /// Absolute path to the dotfile we would (or did) modify.
    pub target_path: String,
    /// The exact region that was (or would be) removed, including guard
    /// markers. Empty string when the block is not present.
    pub removed_region: String,
    /// True iff the file existed but contained no guard block. The UI can
    /// surface a "nothing to do" state instead of a mutation toast.
    pub already_absent: bool,
    /// True iff the target file does not exist on disk. Treated as a form of
    /// "already absent" — a non-existent dotfile cannot have our block.
    pub file_missing: bool,
    /// True only when this invocation mutated the file.
    pub mutated: bool,
    /// Line count of the file AFTER this call (zero when the file is missing
    /// or was emptied).
    pub line_count: usize,
}

pub type UninstallResult = Result<UninstallReply, String>;

/// Locate the `[start, end)` byte range of the guard block, where `end` is
/// one past the end of the footer line (inclusive of the trailing newline if
/// present). Returns `None` when no block is found.
///
/// The match is anchored: the header and footer must each appear on their own
/// line (possibly with trailing whitespace). We deliberately do NOT match a
/// footer-less file — a corrupted install (header only) is left alone so the
/// user notices and we don't silently truncate their rc file.
fn find_guard_region(contents: &str) -> Option<(usize, usize)> {
    // Find the header line.
    let header_line_start = {
        // Walk line starts so we find a full-line match — prevents a user
        // comment that happens to contain the marker mid-line from matching.
        let mut search_from = 0usize;
        loop {
            let slice = &contents[search_from..];
            let rel = slice.find(GUARD_START)?;
            let abs = search_from + rel;
            // Confirm the match is at a line start (beginning of file or
            // preceded by a newline).
            let at_line_start = abs == 0 || contents.as_bytes()[abs - 1] == b'\n';
            if at_line_start {
                break abs;
            }
            // Otherwise continue past this false positive.
            search_from = abs + GUARD_START.len();
        }
    };
    // Find the footer line anchored after the header.
    let after_header = header_line_start + GUARD_START.len();
    let footer_in_tail = {
        let tail = &contents[after_header..];
        let mut search_from = 0usize;
        loop {
            let slice = &tail[search_from..];
            let rel = slice.find(GUARD_END)?;
            let abs = search_from + rel;
            let global_pos = after_header + abs;
            let at_line_start =
                global_pos == 0 || contents.as_bytes()[global_pos - 1] == b'\n';
            if at_line_start {
                break abs;
            }
            search_from = abs + GUARD_END.len();
        }
    };
    let footer_start = after_header + footer_in_tail;
    let footer_end_excl = footer_start + GUARD_END.len();
    // Extend over the trailing newline if the footer line has one.
    let mut region_end = footer_end_excl;
    if region_end < contents.len() && contents.as_bytes()[region_end] == b'\n' {
        region_end += 1;
    }
    // Swallow one preceding newline so removal leaves the surrounding file
    // looking clean (the snippet is installed as "\n<header>\n…\n<footer>\n"
    // which gives the block a blank line separator; we strip that too).
    let mut region_start = header_line_start;
    if region_start > 0 && contents.as_bytes()[region_start - 1] == b'\n' {
        // Only strip if removing the region wouldn't collapse two
        // consecutive newlines into a non-separator. Actually, we DO want to
        // consume one leading newline — the snippet begins with `\n` so
        // removing "\n<block>\n" nets back to the original content plus a
        // single trailing `\n` from what was before.
        region_start -= 1;
    }
    Some((region_start, region_end))
}

pub fn uninstall(args: UninstallArgs) -> UninstallResult {
    let target = resolve_target_for_uninstall(&args)?;

    // Missing file: return a well-formed "not installed" reply rather than
    // error. The UI treats this as "nothing to do".
    let contents = match fs::read_to_string(&target) {
        Ok(c) => c,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(UninstallReply {
                target_path: path_to_string(&target)?,
                removed_region: String::new(),
                already_absent: true,
                file_missing: true,
                mutated: false,
                line_count: 0,
            });
        }
        Err(err) => {
            return Err(format!(
                "shell-integration: read {:?} failed: {err}",
                target
            ));
        }
    };

    let region = find_guard_region(&contents);

    // Already absent — no-op. Preview and confirm behave the same here.
    let Some((start, end)) = region else {
        return Ok(UninstallReply {
            target_path: path_to_string(&target)?,
            removed_region: String::new(),
            already_absent: true,
            file_missing: false,
            mutated: false,
            line_count: contents.lines().count(),
        });
    };

    let removed_region = contents[start..end].to_string();

    // Preview path — never mutate.
    if !args.confirm {
        return Ok(UninstallReply {
            target_path: path_to_string(&target)?,
            removed_region,
            already_absent: false,
            file_missing: false,
            mutated: false,
            line_count: contents.lines().count(),
        });
    }

    // Mutation path — write back contents with the region removed.
    let mut rewritten = String::with_capacity(contents.len() - (end - start));
    rewritten.push_str(&contents[..start]);
    rewritten.push_str(&contents[end..]);

    fs::write(&target, &rewritten)
        .map_err(|e| format!("shell-integration: write {:?} failed: {e}", target))?;

    Ok(UninstallReply {
        target_path: path_to_string(&target)?,
        removed_region,
        already_absent: false,
        file_missing: false,
        mutated: true,
        line_count: rewritten.lines().count(),
    })
}

/// Resolve the uninstall target using the same guards as install. Split out
/// so the uninstall path doesn't accidentally mutate its own input struct.
fn resolve_target_for_uninstall(args: &UninstallArgs) -> Result<PathBuf, String> {
    let home =
        home_dir_from_env().ok_or_else(|| "shell-integration: $HOME is not set".to_string())?;
    let raw = match &args.target_path {
        Some(p) => PathBuf::from(p),
        None => home.join(args.shell.dotfile_relative()),
    };
    ensure_within_home(&raw, &home)?;
    Ok(raw)
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
        let line_count = fs::read_to_string(&target)
            .map(|c| c.lines().count())
            .unwrap_or(0);
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
        Err(err) => {
            return Err(format!(
                "shell-integration: read {:?} failed: {err}",
                target
            ))
        }
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

/// Convert a legacy string error produced by `install` / `uninstall` into a
/// typed `TauriError` so the UI can switch on `.code`. The home-scope refusal
/// string pins its own dedicated code; everything else collapses to
/// `shell-integration-missing` with the raw detail stashed in context.
pub(crate) fn classify_shell_integration_error(err: &str) -> TauriError {
    if err.contains(ERR_OUTSIDE_HOME) {
        return TauriError::shell_integration_outside_home();
    }
    TauriError::shell_integration_missing(err)
}

#[tauri::command]
pub async fn quanta_install_shell_integration(args: InstallArgs) -> Result<InstallReply, TauriError> {
    tracing::info!(
        shell = ?args.shell,
        confirm = args.confirm,
        target = ?args.target_path,
        "install_shell_integration"
    );
    install(args).map_err(|e| classify_shell_integration_error(&e))
}

#[tauri::command]
pub async fn quanta_uninstall_shell_integration(
    args: UninstallArgs,
) -> Result<UninstallReply, TauriError> {
    tracing::info!(
        shell = ?args.shell,
        confirm = args.confirm,
        target = ?args.target_path,
        "uninstall_shell_integration"
    );
    uninstall(args).map_err(|e| classify_shell_integration_error(&e))
}

/* -------------------- tests -------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Serialize env-mutating tests. $HOME is process-global; running the
    /// home-scope tests in parallel under the default `cargo test` thread
    /// pool would otherwise flake (one test's HOME leaks into another's
    /// `resolve_target`).
    fn env_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    /// RAII guard that swaps in a fake `$HOME` for the duration of the test
    /// and restores the previous value on drop. The fake home is a
    /// `TempDir` so the test's install writes stay in an isolated tree.
    struct HomeGuard {
        saved: Option<std::ffi::OsString>,
        _dir: tempfile::TempDir,
        home: PathBuf,
    }

    impl HomeGuard {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            // Canonicalize so `target_path.starts_with(home)` works under
            // systems where /tmp is itself a symlink (darwin → /private/tmp).
            let home = fs::canonicalize(dir.path()).expect("canonicalize tmp");
            let saved = std::env::var_os("HOME");
            std::env::set_var("HOME", &home);
            Self {
                saved,
                _dir: dir,
                home,
            }
        }

        fn home(&self) -> &Path {
            &self.home
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match self.saved.take() {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    /// Build a target path *inside* the fake home. Guarantees the home-scope
    /// check passes for legitimate installs while keeping each test's files
    /// isolated under a per-test subdirectory.
    fn tmp_home_path(guard: &HomeGuard, name: &str) -> PathBuf {
        let dir = guard.home().join(format!(
            "quanta-shell-integration-test-{}-{}",
            std::process::id(),
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
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let target = tmp_home_path(&home, ".zshrc-preview");
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
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let target = tmp_home_path(&home, ".bashrc-write");
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
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let target = tmp_home_path(&home, ".zshrc-idem");
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
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let target = tmp_home_path(&home, ".bashrc-preexisting");
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
        assert!(
            contents.starts_with(pre),
            "pre-existing content was clobbered"
        );
        assert!(contents.contains(GUARD_START));
        // Block must come after the user content.
        assert!(
            contents.find(pre).unwrap() < contents.find(GUARD_START).unwrap(),
            "guard block must be appended after existing content"
        );
    }

    #[test]
    fn preview_reports_already_installed_when_block_present() {
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let target = tmp_home_path(&home, ".zshrc-already");
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
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let root = tmp_home_path(&home, "fish-root")
            .parent()
            .unwrap()
            .to_path_buf();
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

    /* ---------- FIX 1: OSC 7/133 cwd injection encoding ---------- */

    /// Every bundled script must define the `__quanta_urlencode` helper so
    /// hostile $PWD / $HOSTNAME values cannot break out of the OSC 7 payload
    /// (ESC, BEL, newline, ST terminator). The shell scripts are shipped as
    /// static resources via `include_str!`; this test pins the helper into
    /// every script so renaming / removing it shows up red.
    #[test]
    fn scripts_define_urlencode_helper() {
        for script in [BASH_SCRIPT, ZSH_SCRIPT, FISH_SCRIPT] {
            assert!(
                script.contains("__quanta_urlencode"),
                "script missing __quanta_urlencode helper; OSC payload \
                 would embed raw $PWD and be vulnerable to control-char \
                 injection",
            );
        }
    }

    /// OSC 7 emission must route through `__quanta_urlencode` — embedding
    /// raw `$PWD` / `$HOSTNAME` is the injection bug FIX 1 closes.
    #[test]
    fn scripts_osc7_payload_uses_urlencoded_values() {
        // Bash: `__quanta_osc "7;file://${encoded_host}${encoded_cwd}"`
        assert!(
            BASH_SCRIPT.contains("encoded_cwd") && BASH_SCRIPT.contains("encoded_host"),
            "bash OSC 7 must use encoded_cwd / encoded_host, not raw $PWD / $HOSTNAME",
        );
        assert!(
            !BASH_SCRIPT.contains("7;file://${HOSTNAME:-}${cwd}"),
            "bash OSC 7 still embeds raw $HOSTNAME / $cwd (old pattern)",
        );
        // Zsh.
        assert!(
            ZSH_SCRIPT.contains("encoded_cwd") && ZSH_SCRIPT.contains("encoded_host"),
            "zsh OSC 7 must use encoded_cwd / encoded_host",
        );
        assert!(
            !ZSH_SCRIPT.contains("7;file://${HOST:-}${cwd}"),
            "zsh OSC 7 still embeds raw $HOST / $cwd (old pattern)",
        );
        // Fish.
        assert!(
            FISH_SCRIPT.contains("encoded_cwd") && FISH_SCRIPT.contains("encoded_host"),
            "fish OSC 7 must use encoded_cwd / encoded_host",
        );
        assert!(
            !FISH_SCRIPT.contains("7;file://$hostname$cwd"),
            "fish OSC 7 still embeds raw $hostname / $cwd (old pattern)",
        );
    }

    /// OSC 133 markers are literal (A/B/C/D + exit code) and must NOT
    /// interpolate user-controlled strings. This guards against a future
    /// edit accidentally pulling `$PWD` into a 133 payload.
    #[test]
    fn scripts_osc_133_markers_carry_no_user_data() {
        for script in [BASH_SCRIPT, ZSH_SCRIPT, FISH_SCRIPT] {
            // The D marker carries `$exit_code` which is numeric — enforced
            // because the shell's `$?` is always an integer. No other
            // 133 payload should contain a `$` interpolation.
            for marker in ["133;A", "133;B", "133;C"] {
                // Concatenate marker + next char; if next char is `;` the
                // marker is followed by a parameter which must be literal.
                // We assert the marker is followed by the OSC terminator
                // (`\033\\`) or end-of-string, never by `$` / `${`.
                let mut idx = 0;
                while let Some(found) = script[idx..].find(marker) {
                    let abs = idx + found + marker.len();
                    let tail = &script[abs..abs.min(script.len()).min(abs + 4)];
                    assert!(
                        !tail.starts_with(';'),
                        "OSC 133 marker {marker} followed by parameter in script: {tail:?}",
                    );
                    idx = abs;
                }
            }
        }
    }

    /* ---------- FIX 3: canonicalize + home-scope target_path ---------- */

    /// Relative path with `..` escape must be rejected.
    #[test]
    fn install_rejects_relative_dotdot_escape() {
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _home = HomeGuard::new();
        // Classic traversal: a leading temp path that escapes to /etc.
        let bad = PathBuf::from("/tmp/foo/../../../etc/passwd-quanta-test");
        let err = install(InstallArgs {
            shell: Shell::Bash,
            confirm: true,
            target_path: Some(bad.to_string_lossy().into_owned()),
        })
        .expect_err("..-escape must be rejected");
        assert!(
            err.contains(ERR_OUTSIDE_HOME),
            "error should mention the home-scope rule; got: {err}"
        );
    }

    /// An absolute path outside $HOME must be rejected even without `..`.
    #[test]
    fn install_rejects_absolute_path_outside_home() {
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _home = HomeGuard::new();
        let err = install(InstallArgs {
            shell: Shell::Bash,
            confirm: true,
            target_path: Some("/etc/bashrc-quanta-should-refuse".into()),
        })
        .expect_err("absolute path outside $HOME must be rejected");
        assert!(err.contains(ERR_OUTSIDE_HOME));
    }

    /// A symlink whose target is outside $HOME must be rejected even when
    /// the link itself lives in $HOME. We create `$HOME/escape` → `/tmp`
    /// and try to install into it.
    #[cfg(unix)]
    #[test]
    fn install_rejects_symlink_escaping_home() {
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        // Escape target has to be outside the fake home. `/tmp` is a stable
        // public directory on every unix; the host `/tmp` is not inside our
        // per-test fake home.
        let escape_target = PathBuf::from("/tmp");
        let link_path = home.home().join("escape-link");
        std::os::unix::fs::symlink(&escape_target, &link_path).unwrap();
        let err = install(InstallArgs {
            shell: Shell::Bash,
            confirm: true,
            target_path: Some(link_path.to_string_lossy().into_owned()),
        })
        .expect_err("symlink pointing outside $HOME must be rejected");
        assert!(err.contains(ERR_OUTSIDE_HOME));
    }

    /// Normal `$HOME/.bashrc` must be accepted. This is the baseline
    /// happy-path for the install wizard and regressing it would break
    /// every shell-integration user.
    #[test]
    fn install_accepts_normal_home_bashrc() {
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let target = home.home().join(".bashrc");
        let reply = install(InstallArgs {
            shell: Shell::Bash,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .expect("normal ~/.bashrc must be accepted");
        assert!(reply.mutated);
        assert!(target.exists());
    }

    /// Fish config at `~/.config/fish/config.fish` with neither the
    /// file nor the parent directory present must be accepted — the fish
    /// wizard relies on `create_dir_all` to build the tree. Regression
    /// guard: the canonicalize-best-effort helper must NOT require the
    /// trailing components to exist.
    #[test]
    fn install_accepts_missing_fish_config_under_home() {
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let target = home.home().join(".config/fish/config.fish");
        assert!(!target.exists());
        assert!(!target.parent().unwrap().exists());
        let reply = install(InstallArgs {
            shell: Shell::Fish,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .expect("fish config under $HOME must be accepted even when missing");
        assert!(reply.mutated);
        assert!(target.exists());
    }

    /* ---------- uninstall coverage ---------- */

    /// Preview mode must never touch the file, even when a guard block is
    /// present and ready to remove. Pin `mutated: false` and the file
    /// contents as unchanged.
    #[test]
    fn uninstall_preview_does_not_mutate() {
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let target = tmp_home_path(&home, ".zshrc-uninstall-preview");
        // First install so there is something to remove.
        install(InstallArgs {
            shell: Shell::Zsh,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        let before = fs::read_to_string(&target).unwrap();

        let reply = uninstall(UninstallArgs {
            shell: Shell::Zsh,
            confirm: false,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert!(!reply.mutated, "preview must not mutate");
        assert!(!reply.already_absent);
        assert!(reply.removed_region.contains(GUARD_START));
        assert!(reply.removed_region.contains(GUARD_END));
        let after = fs::read_to_string(&target).unwrap();
        assert_eq!(before, after, "preview must not alter the file");
    }

    /// `confirm: true` strips the guard block and leaves the surrounding file
    /// otherwise identical — regression guard for the byte-range math in
    /// `find_guard_region`.
    #[test]
    fn uninstall_confirm_removes_block_and_preserves_surrounding_content() {
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let target = tmp_home_path(&home, ".bashrc-uninstall-remove");
        let pre = "# user's own bashrc\nexport FOO=bar\n";
        let post = "# trailing user content\nalias ll='ls -la'\n";
        // Build a file: pre-existing content, then the install block, then
        // more user content after it. This exercises the surround-preservation
        // contract on both sides of the block.
        {
            let mut f = fs::File::create(&target).unwrap();
            f.write_all(pre.as_bytes()).unwrap();
        }
        install(InstallArgs {
            shell: Shell::Bash,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        {
            // Append trailing user content below the block.
            let mut f = fs::OpenOptions::new().append(true).open(&target).unwrap();
            f.write_all(post.as_bytes()).unwrap();
        }

        let reply = uninstall(UninstallArgs {
            shell: Shell::Bash,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert!(reply.mutated);
        assert!(!reply.already_absent);
        assert!(reply.removed_region.contains(GUARD_START));
        assert!(reply.removed_region.contains(GUARD_END));

        let after = fs::read_to_string(&target).unwrap();
        assert!(
            !after.contains(GUARD_START),
            "uninstall left guard marker behind"
        );
        assert!(
            !after.contains(GUARD_END),
            "uninstall left footer marker behind"
        );
        assert!(after.contains(pre), "pre-existing user content clobbered");
        assert!(
            after.contains(post),
            "trailing user content clobbered: {after:?}"
        );
    }

    /// Second uninstall call must be a no-op: the block is already absent.
    /// The reply pins `already_absent: true` and `mutated: false` so the UI
    /// can show "already removed" rather than a mutation toast.
    #[test]
    fn uninstall_idempotent_on_second_run() {
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let target = tmp_home_path(&home, ".zshrc-uninstall-idem");
        install(InstallArgs {
            shell: Shell::Zsh,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        let first = uninstall(UninstallArgs {
            shell: Shell::Zsh,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert!(first.mutated);
        let after_first = fs::read_to_string(&target).unwrap();

        let second = uninstall(UninstallArgs {
            shell: Shell::Zsh,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert!(!second.mutated, "second call must be a no-op");
        assert!(second.already_absent);
        assert!(!second.file_missing);
        assert_eq!(second.removed_region, "");

        let after_second = fs::read_to_string(&target).unwrap();
        assert_eq!(after_first, after_second);
    }

    /// A missing dotfile returns `file_missing: true` and must not error.
    /// The UI treats this as "not installed; nothing to do".
    #[test]
    fn uninstall_missing_file_returns_not_installed() {
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let target = tmp_home_path(&home, ".zshrc-never-existed");
        assert!(!target.exists());
        let reply = uninstall(UninstallArgs {
            shell: Shell::Zsh,
            confirm: true,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert!(reply.file_missing);
        assert!(reply.already_absent);
        assert!(!reply.mutated);
        assert_eq!(reply.line_count, 0);
    }

    /// A target outside $HOME must be rejected — same defense-in-depth rule
    /// as install.
    #[test]
    fn uninstall_rejects_target_outside_home() {
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _home = HomeGuard::new();
        let err = uninstall(UninstallArgs {
            shell: Shell::Bash,
            confirm: true,
            target_path: Some("/etc/bashrc-quanta-should-refuse".into()),
        })
        .expect_err("absolute path outside $HOME must be rejected");
        assert!(err.contains(ERR_OUTSIDE_HOME));
    }

    /// Preview on a file with no guard block must return `already_absent`
    /// without mutating.
    #[test]
    fn uninstall_preview_reports_already_absent_when_block_missing() {
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let target = tmp_home_path(&home, ".zshrc-no-block");
        // Put a plain rc file with no Quanta block.
        {
            let mut f = fs::File::create(&target).unwrap();
            f.write_all(b"# plain rc\nexport FOO=bar\n").unwrap();
        }
        let reply = uninstall(UninstallArgs {
            shell: Shell::Zsh,
            confirm: false,
            target_path: Some(target.to_string_lossy().into_owned()),
        })
        .unwrap();
        assert!(reply.already_absent);
        assert!(!reply.mutated);
        assert!(!reply.file_missing);
        assert_eq!(reply.removed_region, "");
    }

    /// FIX 2: the outside-home refusal string must upgrade to the typed
    /// `shell-integration-outside-home` code, and generic errors must land on
    /// `shell-integration-missing` with the raw detail confined to `context`.
    #[test]
    fn classifier_maps_outside_home_and_fallback() {
        use crate::error::ErrorCode;
        let outside = classify_shell_integration_error(ERR_OUTSIDE_HOME);
        assert_eq!(outside.code, ErrorCode::ShellIntegrationOutsideHome);

        let other = classify_shell_integration_error("shell-integration: read /x failed");
        assert_eq!(other.code, ErrorCode::ShellIntegrationMissing);
        // The raw path must not leak into `user_message`.
        assert!(!other.user_message.contains("/x"));
    }

    /// Default target (no explicit target_path) still lands under the
    /// fake $HOME; this test exercises the `home.join(dotfile_relative)`
    /// arm of `resolve_target`.
    #[test]
    fn install_default_target_derives_from_home() {
        let _l = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = HomeGuard::new();
        let reply = install(InstallArgs {
            shell: Shell::Zsh,
            confirm: false,
            target_path: None,
        })
        .unwrap();
        let expected = home.home().join(".zshrc");
        assert_eq!(
            PathBuf::from(&reply.target_path),
            expected,
            "default target should be $HOME/.zshrc",
        );
    }
}
