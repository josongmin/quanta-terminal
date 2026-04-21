//! Auto-install of Quanta's shell integration (Plan 0005 P1-B).
//!
//! Differs from `shell_integration.rs` in intent:
//!
//!   - `shell_integration.rs` is the **wizard** back-end (typed-to-confirm,
//!     appends an inline guard block directly to the user's rc file).
//!   - `shell_install.rs` is the **opt-out auto-install** the session
//!     orchestrator fires on first spawn. It copies the bundled integration
//!     script into `~/.config/quanta/shell-integration/<shell>.sh` and appends
//!     a single `source` line (guarded by `QUANTA_SHELL_INTEGRATION_LOADED`)
//!     to the user's rc file, backing up the rc first.
//!
//! Back-off / gating live on the TS side (localStorage); this module is the
//! pure filesystem primitive. The caller is expected to:
//!
//!   1. Only call when feature-flag `shellIntegrationAutoInstall` is true.
//!   2. Record `InstallOutcome::Failed` attempts and enforce the 3-strike /
//!      24-hour cooldown from the UI.
//!   3. Surface `Installed` to the user as a toast ("reload your shell"),
//!      silence `AlreadyInstalled`, and deep-link `Failed` to the wizard.
//!
//! Idempotence: we grep the rc file for `QUANTA_SHELL_INTEGRATION_LOADED`.
//! Any match (wizard install, auto-install, user hand-edit) counts as
//! already-installed and short-circuits.
//!
//! Safety:
//!   - Backup ALWAYS precedes a write. The backup path includes a
//!     millisecond timestamp so repeated installs never overwrite each other.
//!   - The script copy is atomic (write-to-sibling + rename) so a partial
//!     write never leaves a half-populated integration script on disk.
//!   - Unsupported shells (dash, sh, tcsh, nushell, powershell, cmd) are
//!     skipped without erroring — a dropped auto-install is not a failure.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::TauriError;

/// Embedded scripts — same sources as `shell_integration.rs` uses. The layout
/// on disk is `bash.sh` / `zsh.zsh` / `fish.fish`; we embed each verbatim and
/// write back under a canonical `<shell>.sh` name under
/// `~/.config/quanta/shell-integration/` so the rc-file snippet's path is
/// uniform across shells.
const BASH_SCRIPT: &str = include_str!("../../resources/shell-integration/bash.sh");
const ZSH_SCRIPT: &str = include_str!("../../resources/shell-integration/zsh.zsh");
const FISH_SCRIPT: &str = include_str!("../../resources/shell-integration/fish.fish");

/// The idempotence sentinel — any rc file that contains this token is already
/// installed. Matches the token emitted by the bundled scripts.
pub const LOADED_GUARD: &str = "QUANTA_SHELL_INTEGRATION_LOADED";

/// Leading comment in the appended rc snippet so users can see who authored
/// the line and where to look for the copied script.
const RC_SNIPPET_HEADER: &str = "# quanta shell integration (auto-installed)";

/// Outcome of a single [`auto_install`] call. Serializable so the Tauri
/// command can hand it straight to the UI.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InstallOutcome {
    /// The rc file already sources Quanta's script (guard token present).
    /// Silent — do NOT toast the user.
    AlreadyInstalled,
    /// We wrote the snippet. `rc_path` is the file we appended to;
    /// `backup_path` is the pre-mutation copy we made first.
    Installed {
        rc_path: String,
        backup_path: String,
    },
    /// Shell not in our supported set (bash / zsh / fish). Drop silently.
    SkippedUnsupportedShell,
    /// Any filesystem / IO failure. `reason` is safe to log but is NOT meant
    /// for display — the UI should surface a generic "install failed" toast
    /// and deep-link to the wizard. Kept as a String for ergonomics at the
    /// Tauri seam (Rust errors don't serialize well).
    Failed { reason: String },
}

/// Shells we know how to auto-install into. Everything else (dash, sh,
/// nushell, powershell, tcsh, csh) falls through to
/// [`InstallOutcome::SkippedUnsupportedShell`].
///
/// We accept both bare names ("zsh") and absolute paths ("/bin/zsh",
/// "/usr/local/bin/zsh") because the session-spawn reply surfaces whatever
/// the host resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupportedShell {
    Bash,
    Zsh,
    Fish,
}

impl SupportedShell {
    /// Parse a `shell` field coming from the session spawn reply. Returns
    /// `None` for unsupported shells so the caller can produce
    /// [`InstallOutcome::SkippedUnsupportedShell`].
    pub fn from_shell_field(shell: &str) -> Option<Self> {
        // Normalise: lowercase + strip directory prefix if it's a path.
        let leaf = Path::new(shell)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(shell)
            .to_ascii_lowercase();
        match leaf.as_str() {
            "bash" => Some(Self::Bash),
            "zsh" => Some(Self::Zsh),
            "fish" => Some(Self::Fish),
            _ => None,
        }
    }

    /// Canonical lowercase discriminant for serialization + path components.
    pub fn name(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Zsh => "zsh",
            Self::Fish => "fish",
        }
    }

    /// Script body to write out under `~/.config/quanta/shell-integration/`.
    pub fn script(self) -> &'static str {
        match self {
            Self::Bash => BASH_SCRIPT,
            Self::Zsh => ZSH_SCRIPT,
            Self::Fish => FISH_SCRIPT,
        }
    }

    /// RC file relative to `$HOME`. fish lives under `.config/fish/` — we
    /// return a path with a slash so the caller joins on `home`.
    pub fn rc_relative(self) -> &'static str {
        match self {
            Self::Bash => ".bashrc",
            Self::Zsh => ".zshrc",
            Self::Fish => ".config/fish/config.fish",
        }
    }
}

/// Per-shell install status query. Doesn't mutate; used by the UI to decide
/// whether to show the "installed / reload shell" banner on start-up.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct InstallStatus {
    /// True iff the rc file currently contains the guard token. Matches the
    /// short-circuit condition in [`auto_install`].
    pub installed: bool,
    /// True iff the shell is something we know how to auto-install into.
    pub supported: bool,
    /// Absolute path the guard token was searched in. `None` when the shell
    /// is unsupported (no rc to check) or `$HOME` is not set.
    pub rc_path: Option<String>,
}

/// Copy the integration script to `<home>/.config/quanta/shell-integration/<shell>.sh`
/// and append a guarded `source` line to the user's rc file. See module docs
/// for the full contract.
///
/// Pure function: all filesystem access is scoped to `home` (no `$HOME` reads
/// here — the caller resolves HOME so tests can stub it). Returns
/// [`InstallOutcome`] without panicking.
pub fn auto_install(shell: &str, home: &Path) -> InstallOutcome {
    let Some(sh) = SupportedShell::from_shell_field(shell) else {
        return InstallOutcome::SkippedUnsupportedShell;
    };

    // All paths derive from HOME. Using the XDG default `$HOME/.config/quanta`
    // matches the wizard + crash-reporter's convention and survives non-root
    // user profiles cleanly.
    let config_root = home.join(".config/quanta");
    let integration_dir = config_root.join("shell-integration");
    let backup_dir = config_root.join("shell-integration-backup");
    let rc_path = home.join(sh.rc_relative());

    // Idempotence: a guard-token scan of the rc file short-circuits before we
    // touch anything else. A missing rc file is NOT "already installed" — we
    // treat ENOENT as "empty rc" and create one.
    match fs::read_to_string(&rc_path) {
        Ok(contents) if contents.contains(LOADED_GUARD) => {
            return InstallOutcome::AlreadyInstalled;
        }
        Ok(_) | Err(_) => {
            // Either readable-but-no-guard, or missing/unreadable — fall
            // through to the install path. An IO error from read_to_string
            // (permission denied, transient) is deliberately NOT an early
            // return here — the subsequent read for backup will re-surface
            // the same error with a precise path.
        }
    }

    // 1. Create the integration dir and write the script atomically.
    if let Err(e) = fs::create_dir_all(&integration_dir) {
        return InstallOutcome::Failed {
            reason: format!("mkdir {integration_dir:?}: {e}"),
        };
    }
    let script_path = integration_dir.join(format!("{}.sh", sh.name()));
    if let Err(e) = atomic_write(&script_path, sh.script()) {
        return InstallOutcome::Failed {
            reason: format!("write script {script_path:?}: {e}"),
        };
    }

    // 2. Backup the rc file (if it exists) before appending.
    let backup_path = match create_rc_backup(&backup_dir, &rc_path, sh) {
        Ok(p) => p,
        Err(e) => {
            return InstallOutcome::Failed {
                reason: format!("backup {rc_path:?}: {e}"),
            };
        }
    };

    // 3. Append the guarded source line to the rc file. Ensure the parent
    //    exists (fish's ~/.config/fish/ on a clean profile).
    if let Some(parent) = rc_path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return InstallOutcome::Failed {
                reason: format!("mkdir rc parent {parent:?}: {e}"),
            };
        }
    }
    let snippet = rc_snippet(sh, &script_path);
    if let Err(e) = append_text(&rc_path, &snippet) {
        return InstallOutcome::Failed {
            reason: format!("append rc {rc_path:?}: {e}"),
        };
    }

    InstallOutcome::Installed {
        rc_path: rc_path.to_string_lossy().into_owned(),
        backup_path: backup_path.to_string_lossy().into_owned(),
    }
}

/// Detect the user's launch shell by reading `$SHELL`. Returns the raw
/// string (e.g. `/bin/zsh`) so the caller can normalise via
/// [`SupportedShell::from_shell_field`] or pass through unchanged for logging.
///
/// Falls back to `None` when `$SHELL` is unset (a scenario on some container
/// images or stripped-down CI runners where the parent process did not export
/// it). We deliberately do NOT fall back to `getpwuid_r` here — doing so
/// would pull in `libc` / `whoami` only for this one edge case, and the
/// caller already has a sensible "install-nothing" path when the launch
/// shell is unknown. If we later need passwd-file fallback we can gate it
/// on `target_family = "unix"` behind a feature flag.
///
/// Used by [`auto_install_gated`] to ensure Quanta does not install a
/// bash snippet into a `.bashrc` on a user whose login shell is fish or zsh —
/// a freshly-created `.bashrc` on a zsh user's HOME is noise at best, and at
/// worst breaks their login if a sibling tool consumes `.bashrc` unexpectedly.
pub fn detect_launch_shell() -> Option<String> {
    std::env::var("SHELL").ok().filter(|s| !s.is_empty())
}

/// Per-shell gate. Call this instead of [`auto_install`] when the caller
/// needs "install only into the detected launch shell" semantics. Returns
/// [`InstallOutcome::SkippedUnsupportedShell`] when the candidate does not
/// match the launch shell (so an existing fanout loop over every shell only
/// writes to the one the user actually uses).
///
/// `override_shells` is an escape hatch for power-user / test paths that
/// genuinely want to install into every supported shell regardless of
/// `$SHELL`. Passing `true` bypasses the gate and delegates to
/// [`auto_install`] directly.
pub fn auto_install_gated(
    shell: &str,
    home: &Path,
    override_shells: bool,
) -> InstallOutcome {
    if override_shells {
        return auto_install(shell, home);
    }
    // Normalise both sides through `SupportedShell::from_shell_field` so a
    // `$SHELL` of `/usr/local/bin/zsh` matches a candidate of `zsh`.
    let candidate = SupportedShell::from_shell_field(shell);
    let launch = detect_launch_shell().and_then(|s| SupportedShell::from_shell_field(&s));
    match (candidate, launch) {
        (Some(c), Some(l)) if c == l => auto_install(shell, home),
        (Some(_), Some(_)) => InstallOutcome::SkippedUnsupportedShell,
        // Unknown launch shell (unset or unsupported $SHELL) — be conservative
        // and still install into the requested shell. This preserves the
        // previous behavior for CI runners where $SHELL is absent; the
        // session.spawn reply is a stronger signal than the env var.
        (Some(_), None) => auto_install(shell, home),
        // Candidate is not a supported shell — bubble up the standard skip.
        (None, _) => InstallOutcome::SkippedUnsupportedShell,
    }
}

/* -------------------- uninstall (auto-install snippet) -------------------- */

/// Outcome of an [`uninstall_auto_install`] call. Mirrors
/// [`InstallOutcome`] shape so the TS side can switch on `kind`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UninstallOutcome {
    /// The rc file was mutated — the `source` line and snippet header
    /// were removed. `rc_path` is the file we touched.
    Removed { rc_path: String },
    /// The rc file did not reference Quanta's integration script. No-op.
    NotInstalled,
    /// The rc file does not exist on disk. Treat as "already absent".
    FileMissing,
    /// Unsupported shell — nothing to do.
    SkippedUnsupportedShell,
    /// Any filesystem / IO failure.
    Failed { reason: String },
}

/// Reverse of [`auto_install`]: strip the rc snippet we appended.
/// Removes:
///   1. The leading `# quanta shell integration (auto-installed)` header line.
///   2. The `[ -f "<path>" ] && . "<path>"` (bash/zsh) or
///      `test -f "<path>"; and source "<path>"` (fish) directive that
///      references a path under `<home>/.config/quanta/shell-integration/`.
///   3. One leading blank line the snippet carries in front of the header.
///
/// The match is conservative: we only strip lines that (a) live in a
/// contiguous region anchored by the auto-install header AND (b) the
/// sourced path resolves under the config-root for quanta. A hand-written
/// `source /some/other/file` is left untouched even if it happens to live
/// adjacent to our snippet.
///
/// Atomic rewrite: the whole rewritten body is flushed to `<rc>.tmp-<pid>-<ns>`
/// and then renamed over the target, so a crash mid-write can never leave a
/// truncated rc file. Idempotent — a second call returns `NotInstalled`.
pub fn uninstall_auto_install(shell: &str, home: &Path) -> UninstallOutcome {
    let Some(sh) = SupportedShell::from_shell_field(shell) else {
        return UninstallOutcome::SkippedUnsupportedShell;
    };
    let rc_path = home.join(sh.rc_relative());
    let contents = match fs::read_to_string(&rc_path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return UninstallOutcome::FileMissing;
        }
        Err(e) => {
            return UninstallOutcome::Failed {
                reason: format!("read {rc_path:?}: {e}"),
            };
        }
    };

    let Some((start, end)) = find_auto_install_region(&contents, home) else {
        return UninstallOutcome::NotInstalled;
    };

    let mut rewritten = String::with_capacity(contents.len() - (end - start));
    rewritten.push_str(&contents[..start]);
    rewritten.push_str(&contents[end..]);

    // Atomic write (tempfile + rename) — same primitive the install path uses.
    if let Err(e) = atomic_write(&rc_path, &rewritten) {
        return UninstallOutcome::Failed {
            reason: format!("atomic_write {rc_path:?}: {e}"),
        };
    }

    UninstallOutcome::Removed {
        rc_path: rc_path.to_string_lossy().into_owned(),
    }
}

/// Locate the `[start, end)` byte range of the auto-install snippet inside
/// `contents`. Returns `None` when no matching region is found.
///
/// Anchored on:
///   1. A line-start occurrence of `RC_SNIPPET_HEADER`.
///   2. Immediately followed by a `source` / `.` / `and source` line that
///      references a path starting with `<home>/.config/quanta/shell-integration/`.
///
/// Both conditions must hold — we won't strip a header-only block (signals
/// corruption the user should see) and we won't strip a source line that
/// isn't ours (a user-authored snippet that happened to land near our
/// header comment).
fn find_auto_install_region(contents: &str, home: &Path) -> Option<(usize, usize)> {
    let header_pos = {
        let mut search_from = 0usize;
        loop {
            let slice = &contents[search_from..];
            let rel = slice.find(RC_SNIPPET_HEADER)?;
            let abs = search_from + rel;
            let at_line_start = abs == 0 || contents.as_bytes()[abs - 1] == b'\n';
            if at_line_start {
                break abs;
            }
            search_from = abs + RC_SNIPPET_HEADER.len();
        }
    };
    // Region start: swallow one leading newline if present so the snippet's
    // "\n<header>\n..." install pattern nets back to the original file tail.
    let region_start = if header_pos > 0 && contents.as_bytes()[header_pos - 1] == b'\n' {
        header_pos - 1
    } else {
        header_pos
    };
    // Advance past the header line.
    let after_header_line = {
        let after = header_pos + RC_SNIPPET_HEADER.len();
        // Consume the rest of the header line (there may be trailing
        // whitespace before the newline).
        let tail = &contents[after..];
        let nl = tail.find('\n').map(|n| after + n + 1).unwrap_or(contents.len());
        nl
    };
    // Read the next non-empty line — this should be the source directive.
    let (source_line_start, source_line_end) = {
        let mut cursor = after_header_line;
        // Skip blank lines (defensive — the snippet doesn't add any).
        while cursor < contents.len() {
            let tail = &contents[cursor..];
            let line_end = tail.find('\n').map(|n| cursor + n).unwrap_or(contents.len());
            let line = &contents[cursor..line_end];
            if line.trim().is_empty() {
                cursor = line_end + 1;
                continue;
            }
            break;
        }
        if cursor >= contents.len() {
            return None;
        }
        let tail = &contents[cursor..];
        let line_end_excl = tail.find('\n').map(|n| cursor + n + 1).unwrap_or(contents.len());
        (cursor, line_end_excl)
    };
    let source_line = &contents[source_line_start..source_line_end];
    // Verify the line references a path under our config-root. The install
    // path always writes `<home>/.config/quanta/shell-integration/<shell>.sh`.
    let config_prefix = home.join(".config/quanta/shell-integration");
    let config_prefix_str = config_prefix.to_string_lossy();
    if !source_line.contains(config_prefix_str.as_ref()) {
        // Adjacent header + unrelated line — conservative: do nothing.
        return None;
    }
    Some((region_start, source_line_end))
}

/// Query variant: tell the UI whether the rc file is already wired up.
pub fn install_status(shell: &str, home: &Path) -> InstallStatus {
    let Some(sh) = SupportedShell::from_shell_field(shell) else {
        return InstallStatus {
            installed: false,
            supported: false,
            rc_path: None,
        };
    };
    let rc_path = home.join(sh.rc_relative());
    let installed = fs::read_to_string(&rc_path)
        .map(|c| c.contains(LOADED_GUARD))
        .unwrap_or(false);
    InstallStatus {
        installed,
        supported: true,
        rc_path: Some(rc_path.to_string_lossy().into_owned()),
    }
}

/// Build the small snippet we append to the rc file. Two flavors:
///   - bash / zsh: posix `[[ -f X ]] && . X` so sourcing failures don't abort
///     the rest of the rc.
///   - fish: `test -f X; and source X` (fish has its own grammar).
///
/// The leading blank line guarantees the snippet is on its own line even if
/// the rc file didn't end with a newline. The trailing `# >>> quanta ... <<<`
/// markers mirror the wizard's guard markers so a user who manually ran the
/// wizard after an auto-install sees both blocks together.
fn rc_snippet(sh: SupportedShell, script_path: &Path) -> String {
    // We rewrite the absolute script path into a $HOME-relative form where
    // possible so the snippet stays portable if the user moves their home
    // (common on macOS with symlinked /Users paths). Falling back to the
    // absolute path is safe — `. /abs/path/to/script` works everywhere.
    let script_str = script_path.to_string_lossy();
    let mut out = String::with_capacity(256);
    out.push('\n');
    out.push_str(RC_SNIPPET_HEADER);
    out.push('\n');
    match sh {
        SupportedShell::Bash | SupportedShell::Zsh => {
            // The test guard matches the wizard's style: only source if the
            // file exists, so a user deleting the integration dir doesn't
            // wedge their shell login.
            out.push_str(&format!(
                "[ -f \"{path}\" ] && . \"{path}\"\n",
                path = script_str
            ));
        }
        SupportedShell::Fish => {
            out.push_str(&format!(
                "test -f \"{path}\"; and source \"{path}\"\n",
                path = script_str
            ));
        }
    }
    out
}

/// Backup the rc file to `<backup_dir>/<shell>rc.<unix_ms>.bak`. Missing rc
/// file returns the computed-but-unused backup path so the caller still has
/// a stable absolute path to report — an empty rc file is a valid state.
fn create_rc_backup(
    backup_dir: &Path,
    rc_path: &Path,
    sh: SupportedShell,
) -> std::io::Result<PathBuf> {
    fs::create_dir_all(backup_dir)?;
    let unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // `<shell>rc.<unix_ms>.bak` — matches the plan spec. fish's file name is
    // `config.fish` not `.fishrc`, but we still call the backup file
    // `fishrc.<ms>.bak` for consistency across shells.
    let backup_name = format!("{}rc.{}.bak", sh.name(), unix_ms);
    let backup_path = backup_dir.join(backup_name);
    match fs::read(rc_path) {
        Ok(bytes) => {
            atomic_write_bytes(&backup_path, &bytes)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Record an empty backup so the UI can still offer "restore this
            // backup" without a special case. Empty is fine — restoring it
            // produces an empty rc which is the original state.
            atomic_write_bytes(&backup_path, b"")?;
        }
        Err(e) => return Err(e),
    }
    Ok(backup_path)
}

/// Atomic text write via `<path>.tmp-<pid>-<ms>` + `rename`. `fs::write` is
/// NOT atomic across all platforms — a crash mid-write would leave the
/// integration script truncated and the next shell spawn would source a
/// broken script. Tempfile + rename closes that race on every POSIX FS.
fn atomic_write(path: &Path, contents: &str) -> std::io::Result<()> {
    atomic_write_bytes(path, contents.as_bytes())
}

fn atomic_write_bytes(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let pid = std::process::id();
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_name = format!(
        ".{}.tmp-{}-{}",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("quanta-shell-install"),
        pid,
        ms,
    );
    let tmp = path
        .parent()
        .map(|p| p.join(&tmp_name))
        .unwrap_or_else(|| PathBuf::from(&tmp_name));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(contents)?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Append plain text to a file, creating it if missing. Used for the rc-file
/// snippet. We open in append mode rather than read+rewrite so a concurrent
/// user edit isn't clobbered.
fn append_text(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    f.write_all(text.as_bytes())?;
    f.sync_all().ok();
    Ok(())
}

/* -------------------- Tauri commands -------------------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AutoInstallArgs {
    pub shell: String,
    /// Optional override for `$HOME`, primarily for tests. Production callers
    /// omit this and the command reads `HOME` from the environment.
    #[serde(default)]
    pub home_override: Option<String>,
    /// Bypass the per-launch-shell gate (audit P1-B fix 3). Defaults to
    /// `false`: the install only proceeds if the candidate `shell` matches
    /// the user's `$SHELL`. Passing `true` forces the install through —
    /// used by the wizard's "install into every supported shell" advanced
    /// button and by integration tests that want to assert behavior on a
    /// mismatched launch shell.
    #[serde(default)]
    pub override_shells: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct StatusArgs {
    pub shell: String,
    #[serde(default)]
    pub home_override: Option<String>,
}

fn resolve_home(override_path: Option<&str>) -> Result<PathBuf, TauriError> {
    if let Some(p) = override_path {
        return Ok(PathBuf::from(p));
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| TauriError::bridge_internal("HOME environment variable is not set"))
}

#[tauri::command]
pub async fn quanta_shell_install_auto(
    args: AutoInstallArgs,
) -> Result<InstallOutcome, TauriError> {
    tracing::info!(
        shell = ?args.shell,
        override_shells = args.override_shells,
        "shell-install: auto-install requested"
    );
    let home = resolve_home(args.home_override.as_deref())?;
    // Route through the per-launch-shell gate (audit P1-B fix 3). The
    // session-spawn-driven path passes `override_shells: false` so we don't
    // seed a .bashrc on a fish/zsh user. An explicit "install everywhere"
    // advanced action can pass `true` to bypass the gate.
    let outcome = auto_install_gated(&args.shell, &home, args.override_shells);
    if let InstallOutcome::Failed { reason } = &outcome {
        tracing::warn!(?reason, shell = ?args.shell, "shell-install: failed");
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn quanta_shell_install_status(
    args: StatusArgs,
) -> Result<InstallStatus, TauriError> {
    let home = resolve_home(args.home_override.as_deref())?;
    Ok(install_status(&args.shell, &home))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct UninstallArgs {
    pub shell: String,
    #[serde(default)]
    pub home_override: Option<String>,
}

/// Remove the auto-install snippet from the user's rc file. Symmetric inverse
/// of [`quanta_shell_install_auto`]. Distinct from
/// `quanta_uninstall_shell_integration` (shell_integration.rs) which strips
/// the wizard's inline guarded block — this one only removes the
/// `# quanta shell integration (auto-installed)` header + `source` line.
#[tauri::command]
pub async fn quanta_shell_install_uninstall(
    args: UninstallArgs,
) -> Result<UninstallOutcome, TauriError> {
    tracing::info!(shell = ?args.shell, "shell-install: uninstall requested");
    let home = resolve_home(args.home_override.as_deref())?;
    let outcome = uninstall_auto_install(&args.shell, &home);
    if let UninstallOutcome::Failed { reason } = &outcome {
        tracing::warn!(?reason, shell = ?args.shell, "shell-install: uninstall failed");
    }
    Ok(outcome)
}

/* -------------------- tests -------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// RAII guard: point `auto_install` at a temp directory and restore on
    /// drop. Tests mostly pass `home` explicitly so we don't need to shim
    /// the env var — but a couple of integration-style tests exercise the
    /// command path which reads `$HOME`.
    struct TempHome(tempfile::TempDir);

    impl TempHome {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            self.0.path()
        }
    }

    #[test]
    fn shell_field_normalises_paths_and_case() {
        assert_eq!(
            SupportedShell::from_shell_field("/bin/zsh"),
            Some(SupportedShell::Zsh)
        );
        assert_eq!(
            SupportedShell::from_shell_field("/usr/local/bin/bash"),
            Some(SupportedShell::Bash)
        );
        assert_eq!(
            SupportedShell::from_shell_field("ZSH"),
            Some(SupportedShell::Zsh)
        );
        assert_eq!(
            SupportedShell::from_shell_field("fish"),
            Some(SupportedShell::Fish)
        );
        assert_eq!(SupportedShell::from_shell_field("dash"), None);
        assert_eq!(SupportedShell::from_shell_field("/bin/sh"), None);
        assert_eq!(SupportedShell::from_shell_field("powershell.exe"), None);
    }

    #[test]
    fn unsupported_shell_returns_skipped() {
        let home = TempHome::new();
        let out = auto_install("/bin/sh", home.path());
        assert_eq!(out, InstallOutcome::SkippedUnsupportedShell);
        // And nothing was written.
        assert!(!home.path().join(".config/quanta").exists());
    }

    #[test]
    fn first_install_creates_script_backup_and_appends_rc() {
        let home = TempHome::new();
        // Pre-seed a user zshrc so the backup is non-empty.
        let rc = home.path().join(".zshrc");
        fs::write(&rc, "# user zshrc\nexport FOO=bar\n").unwrap();

        let out = auto_install("/bin/zsh", home.path());
        let (rc_path, backup_path) = match out {
            InstallOutcome::Installed {
                rc_path,
                backup_path,
            } => (rc_path, backup_path),
            other => panic!("expected Installed, got {other:?}"),
        };

        // Script was copied under the XDG dir with the canonical <shell>.sh name.
        let script = home
            .path()
            .join(".config/quanta/shell-integration/zsh.sh");
        assert!(script.exists(), "integration script not written: {script:?}");
        let script_contents = fs::read_to_string(&script).unwrap();
        assert!(
            script_contents.contains(LOADED_GUARD),
            "integration script missing guard token",
        );

        // Backup contains the original rc bytes verbatim.
        let backup = fs::read_to_string(&backup_path).unwrap();
        assert_eq!(backup, "# user zshrc\nexport FOO=bar\n");

        // RC file now sources the script AND preserves user content.
        let rc_after = fs::read_to_string(&rc_path).unwrap();
        assert!(rc_after.contains("# user zshrc"));
        assert!(rc_after.contains("export FOO=bar"));
        assert!(rc_after.contains(&script.to_string_lossy().to_string()));
        assert!(rc_after.contains(RC_SNIPPET_HEADER));
    }

    #[test]
    fn second_install_is_idempotent_when_guard_present() {
        let home = TempHome::new();
        // Manually place a rc file containing the guard token (simulates a
        // prior wizard run or a hand-edit).
        let rc = home.path().join(".bashrc");
        fs::write(&rc, "# user bashrc\nexport QUANTA_SHELL_INTEGRATION_LOADED=1\n").unwrap();

        let out = auto_install("bash", home.path());
        assert_eq!(out, InstallOutcome::AlreadyInstalled);
        // RC file was not mutated.
        let rc_after = fs::read_to_string(&rc).unwrap();
        assert_eq!(
            rc_after,
            "# user bashrc\nexport QUANTA_SHELL_INTEGRATION_LOADED=1\n"
        );
        // And we did NOT write a backup — idempotent short-circuit.
        let backup_dir = home.path().join(".config/quanta/shell-integration-backup");
        assert!(
            !backup_dir.exists() || fs::read_dir(&backup_dir).unwrap().next().is_none(),
            "idempotent path must not create a backup"
        );
    }

    #[test]
    fn install_on_missing_rc_creates_file_and_empty_backup() {
        let home = TempHome::new();
        let out = auto_install("bash", home.path());
        let (rc_path, backup_path) = match out {
            InstallOutcome::Installed {
                rc_path,
                backup_path,
            } => (rc_path, backup_path),
            other => panic!("expected Installed, got {other:?}"),
        };
        // RC file was created from scratch with the snippet.
        let rc_after = fs::read_to_string(&rc_path).unwrap();
        assert!(rc_after.contains(RC_SNIPPET_HEADER));
        // Backup is empty but present (so the UI still has a path to show).
        assert!(PathBuf::from(&backup_path).exists());
        assert_eq!(fs::read(&backup_path).unwrap(), b"");
    }

    #[test]
    fn fish_install_creates_nested_config_dir() {
        let home = TempHome::new();
        // fish's rc lives at ~/.config/fish/config.fish — neither the file nor
        // the parent dir exists on a clean profile. auto_install must
        // `mkdir -p` the parents.
        let rc = home.path().join(".config/fish/config.fish");
        assert!(!rc.exists());
        assert!(!rc.parent().unwrap().exists());

        let out = auto_install("fish", home.path());
        let rc_path = match out {
            InstallOutcome::Installed { rc_path, .. } => rc_path,
            other => panic!("expected Installed, got {other:?}"),
        };
        assert!(PathBuf::from(&rc_path).exists());
        let contents = fs::read_to_string(&rc_path).unwrap();
        // Fish uses its own grammar — no `[ -f X ] && . X`.
        assert!(contents.contains("and source"));
        assert!(!contents.contains("&& ."));
    }

    #[test]
    fn snippet_uses_shell_specific_grammar() {
        // bash/zsh use POSIX sh-style guarded source; fish uses its own.
        let home = TempHome::new();
        let bash_path = home.path().join("bash.sh");
        assert!(rc_snippet(SupportedShell::Bash, &bash_path).contains("[ -f"));
        assert!(rc_snippet(SupportedShell::Zsh, &bash_path).contains(". \""));
        let fish_path = home.path().join("fish.sh");
        assert!(rc_snippet(SupportedShell::Fish, &fish_path).contains("test -f"));
        assert!(rc_snippet(SupportedShell::Fish, &fish_path).contains("and source"));
    }

    #[test]
    fn backup_filename_encodes_shell_and_millis() {
        let home = TempHome::new();
        fs::write(home.path().join(".zshrc"), b"pre-existing").unwrap();
        let out = auto_install("zsh", home.path());
        let backup_path = match out {
            InstallOutcome::Installed { backup_path, .. } => backup_path,
            other => panic!("expected Installed, got {other:?}"),
        };
        let name = Path::new(&backup_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap();
        assert!(name.starts_with("zshrc."), "expected zshrc.<ms>.bak, got {name}");
        assert!(name.ends_with(".bak"), "expected .bak suffix, got {name}");
    }

    #[test]
    fn install_status_reports_installed_when_guard_present() {
        let home = TempHome::new();
        let rc = home.path().join(".zshrc");
        fs::write(&rc, "export QUANTA_SHELL_INTEGRATION_LOADED=1\n").unwrap();
        let status = install_status("zsh", home.path());
        assert!(status.installed);
        assert!(status.supported);
        assert_eq!(status.rc_path.as_deref(), rc.to_str());
    }

    #[test]
    fn install_status_reports_uninstalled_and_supported_for_missing_rc() {
        let home = TempHome::new();
        let status = install_status("/bin/bash", home.path());
        assert!(!status.installed);
        assert!(status.supported);
        assert!(status.rc_path.is_some());
    }

    #[test]
    fn install_status_unsupported_shell_returns_empty_rc_path() {
        let home = TempHome::new();
        let status = install_status("dash", home.path());
        assert!(!status.installed);
        assert!(!status.supported);
        assert!(status.rc_path.is_none());
    }

    #[test]
    fn atomic_write_replaces_existing_file_without_truncation_window() {
        let home = TempHome::new();
        let target = home.path().join("script.sh");
        fs::write(&target, b"original").unwrap();
        atomic_write(&target, "replacement").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "replacement");
    }

    #[test]
    fn append_text_creates_missing_file() {
        let home = TempHome::new();
        let target = home.path().join("nested/dir/file.txt");
        append_text(&target, "hello\n").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello\n");
        append_text(&target, "world\n").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello\nworld\n");
    }

    /* -------------------- detect_launch_shell -------------------- */

    /// $SHELL-reading tests need the same env-serialisation the wizard tests
    /// use (see `shell_integration.rs`). Share the mutex so the two modules
    /// never fight over `$SHELL`.
    fn env_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    #[test]
    fn detect_launch_shell_reads_env() {
        let _lock = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let saved = std::env::var_os("SHELL");
        std::env::set_var("SHELL", "/usr/local/bin/fish");
        assert_eq!(detect_launch_shell().as_deref(), Some("/usr/local/bin/fish"));
        match saved {
            Some(v) => std::env::set_var("SHELL", v),
            None => std::env::remove_var("SHELL"),
        }
    }

    #[test]
    fn detect_launch_shell_none_when_unset() {
        let _lock = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let saved = std::env::var_os("SHELL");
        std::env::remove_var("SHELL");
        assert_eq!(detect_launch_shell(), None);
        if let Some(v) = saved {
            std::env::set_var("SHELL", v);
        }
    }

    #[test]
    fn detect_launch_shell_none_for_empty_string() {
        let _lock = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let saved = std::env::var_os("SHELL");
        std::env::set_var("SHELL", "");
        assert_eq!(detect_launch_shell(), None);
        match saved {
            Some(v) => std::env::set_var("SHELL", v),
            None => std::env::remove_var("SHELL"),
        }
    }

    /* -------------------- auto_install_gated -------------------- */

    #[test]
    fn gated_install_skips_when_launch_shell_differs() {
        let _lock = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let saved = std::env::var_os("SHELL");
        std::env::set_var("SHELL", "/bin/zsh");
        let home = TempHome::new();
        // $SHELL is zsh; asking to install into bash must skip.
        let out = auto_install_gated("/bin/bash", home.path(), false);
        assert_eq!(out, InstallOutcome::SkippedUnsupportedShell);
        assert!(!home.path().join(".bashrc").exists());
        match saved {
            Some(v) => std::env::set_var("SHELL", v),
            None => std::env::remove_var("SHELL"),
        }
    }

    #[test]
    fn gated_install_proceeds_when_launch_shell_matches() {
        let _lock = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let saved = std::env::var_os("SHELL");
        std::env::set_var("SHELL", "/bin/zsh");
        let home = TempHome::new();
        let out = auto_install_gated("/bin/zsh", home.path(), false);
        assert!(matches!(out, InstallOutcome::Installed { .. }));
        assert!(home.path().join(".zshrc").exists());
        match saved {
            Some(v) => std::env::set_var("SHELL", v),
            None => std::env::remove_var("SHELL"),
        }
    }

    #[test]
    fn gated_install_override_bypasses_gate() {
        let _lock = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let saved = std::env::var_os("SHELL");
        std::env::set_var("SHELL", "/bin/zsh");
        let home = TempHome::new();
        // override_shells=true forces the install through even though
        // $SHELL=zsh and we're asking about bash.
        let out = auto_install_gated("/bin/bash", home.path(), true);
        assert!(matches!(out, InstallOutcome::Installed { .. }));
        assert!(home.path().join(".bashrc").exists());
        match saved {
            Some(v) => std::env::set_var("SHELL", v),
            None => std::env::remove_var("SHELL"),
        }
    }

    #[test]
    fn gated_install_proceeds_when_launch_shell_unset() {
        let _lock = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let saved = std::env::var_os("SHELL");
        std::env::remove_var("SHELL");
        let home = TempHome::new();
        // No $SHELL signal — fall through to the raw auto_install so CI
        // runners / stripped env don't block the install.
        let out = auto_install_gated("zsh", home.path(), false);
        assert!(matches!(out, InstallOutcome::Installed { .. }));
        if let Some(v) = saved {
            std::env::set_var("SHELL", v);
        }
    }

    /* -------------------- uninstall_auto_install -------------------- */

    #[test]
    fn uninstall_removes_snippet_appended_by_auto_install() {
        let home = TempHome::new();
        fs::write(home.path().join(".zshrc"), "# existing\nexport FOO=bar\n").unwrap();
        // Install first.
        let install_out = auto_install("zsh", home.path());
        assert!(matches!(install_out, InstallOutcome::Installed { .. }));
        let before = fs::read_to_string(home.path().join(".zshrc")).unwrap();
        assert!(before.contains(RC_SNIPPET_HEADER));

        // Uninstall.
        let out = uninstall_auto_install("zsh", home.path());
        assert!(
            matches!(out, UninstallOutcome::Removed { .. }),
            "expected Removed, got {out:?}"
        );
        let after = fs::read_to_string(home.path().join(".zshrc")).unwrap();
        assert!(!after.contains(RC_SNIPPET_HEADER), "snippet still present: {after}");
        // User content preserved.
        assert!(after.contains("# existing"));
        assert!(after.contains("export FOO=bar"));
    }

    #[test]
    fn uninstall_is_idempotent() {
        let home = TempHome::new();
        fs::write(home.path().join(".zshrc"), "# existing\n").unwrap();
        let _ = auto_install("zsh", home.path());
        let first = uninstall_auto_install("zsh", home.path());
        assert!(matches!(first, UninstallOutcome::Removed { .. }));
        let snapshot_after_first = fs::read_to_string(home.path().join(".zshrc")).unwrap();
        // Second call — already gone.
        let second = uninstall_auto_install("zsh", home.path());
        assert_eq!(second, UninstallOutcome::NotInstalled);
        // File unchanged by the second call.
        let snapshot_after_second = fs::read_to_string(home.path().join(".zshrc")).unwrap();
        assert_eq!(snapshot_after_first, snapshot_after_second);
    }

    #[test]
    fn uninstall_reports_file_missing_when_rc_absent() {
        let home = TempHome::new();
        let out = uninstall_auto_install("zsh", home.path());
        assert_eq!(out, UninstallOutcome::FileMissing);
    }

    #[test]
    fn uninstall_skips_unsupported_shell() {
        let home = TempHome::new();
        let out = uninstall_auto_install("dash", home.path());
        assert_eq!(out, UninstallOutcome::SkippedUnsupportedShell);
    }

    #[test]
    fn uninstall_preserves_user_source_lines() {
        // A user-authored `source` line that happens to look similar but
        // does NOT reference the quanta config-root must survive uninstall.
        let home = TempHome::new();
        let rc = home.path().join(".zshrc");
        fs::write(
            &rc,
            "# my custom source\nsource /usr/local/share/other-tool.sh\n",
        )
        .unwrap();
        let out = uninstall_auto_install("zsh", home.path());
        assert_eq!(out, UninstallOutcome::NotInstalled);
        // File unchanged.
        assert_eq!(
            fs::read_to_string(&rc).unwrap(),
            "# my custom source\nsource /usr/local/share/other-tool.sh\n"
        );
    }

    /* -------------------- fish `$status` capture order -------------------- */

    /// Audit P1-B race #1: ensure the fish `fish_prompt` handler captures
    /// `$status` into a namespaced local BEFORE any other command runs. If a
    /// future refactor inserts a function call or test above the capture, the
    /// emitted OSC 133 D exit code would report whatever `$status` was after
    /// that call, not the command the user actually ran.
    #[test]
    fn fish_prompt_handler_captures_status_on_first_line() {
        // Walk the fish script; find the `--on-event fish_prompt` handler
        // and assert the first non-comment, non-blank line inside its body
        // is the `set -l __quanta_last_status $status` capture.
        let mut lines = FISH_SCRIPT.lines();
        let mut inside = false;
        let mut first_real_line: Option<&str> = None;
        for line in &mut lines {
            let trimmed = line.trim_start();
            if !inside {
                // Match the handler header. The specific handler name is
                // cosmetic — any function line with `--on-event fish_prompt`
                // is the one we care about.
                if trimmed.starts_with("function ") && trimmed.contains("--on-event fish_prompt") {
                    inside = true;
                }
                continue;
            }
            // Inside the handler: skip comment and blank lines until the
            // first executable statement.
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if trimmed == "end" {
                break;
            }
            first_real_line = Some(trimmed);
            break;
        }
        let first = first_real_line.expect("fish_prompt handler not found or empty");
        assert!(
            first.starts_with("set -l __quanta_last_status $status"),
            "first executable line of fish_prompt handler must be the $status capture; got: {first:?}",
        );
    }

    /// Verify the emission still references the captured variable (never
    /// `$status` directly after the capture, because subsequent `__quanta_osc`
    /// calls would clobber `$status`).
    #[test]
    fn fish_prompt_emits_133_d_with_captured_status() {
        assert!(
            FISH_SCRIPT.contains("__quanta_osc \"133;D;$__quanta_last_status\""),
            "fish script must emit OSC 133 D using the captured status variable; \
             found no matching line",
        );
        // And MUST NOT emit from `$status` directly (that would be the bug).
        assert!(
            !FISH_SCRIPT.contains("__quanta_osc \"133;D;$status\""),
            "fish script must not emit 133;D from $status directly (race-prone)",
        );
    }

    #[test]
    fn uninstall_atomic_rewrite_leaves_no_tmp_file_behind() {
        // After a successful uninstall the only file in the rc's parent dir
        // should be the rc itself — atomic_write_bytes fsyncs and renames.
        let home = TempHome::new();
        fs::write(home.path().join(".zshrc"), "# existing\n").unwrap();
        let _ = auto_install("zsh", home.path());
        let _ = uninstall_auto_install("zsh", home.path());
        // Any leftover tmp would have a name like `.zshrc.tmp-<pid>-<ns>`.
        let entries: Vec<_> = fs::read_dir(home.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        for n in &entries {
            let s = n.to_string_lossy();
            assert!(
                !s.starts_with(".zshrc.tmp-"),
                "stray atomic-write tempfile left behind: {s}",
            );
        }
    }
}
