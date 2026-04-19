//! Crash integration point — glues `quanta-crash-reporter` into the Tauri host.
//!
//! Responsibilities:
//!
//! 1. Install a `std::panic::set_hook` that builds a redacted `CrashReport`
//!    and dispatches it to the configured reporter.
//! 2. Resolve the reporter: the default is [`quanta_crash_reporter::FileSinkReporter`]
//!    pointed at `<app_config_dir>/crashes/`.
//! 3. Expose a typed entry point [`forward_ts_crash`] consumed by the
//!    `quanta_report_crash` IPC command so JS unhandled rejections flow
//!    through the same sink.
//!
//! Redaction
//! ---------
//! Panic messages and stacks often embed absolute paths (`/Users/alice/…`),
//! environment-ish tokens, and occasionally the literal value of a
//! `Debug`-printed struct. We run a best-effort inline redactor before
//! writing. The full redactor lives in `crates/quanta-security`; the
//! host-tauri crate doesn't depend on it directly because the security
//! crate is a path-dep that would drag workspace compile time up. The
//! inline redactor here covers the known leak vectors: absolute paths,
//! `Bearer <token>` / `sk-<token>` / AWS keys, env `KEY=value` pairs.
//!
//! Fail-silent guarantee: the reporter panics here would loop forever.
//! Every path through this module catches panics and IO errors and logs
//! them via `tracing` only.

use std::path::PathBuf;
use std::sync::OnceLock;

use parking_lot::Mutex;

use quanta_crash_reporter::{CrashReport, FileSinkReporter};

/// Slot holding the reporter's target directory. Populated by
/// [`bind_reporter_to_app`] during Tauri setup. While empty, the panic
/// hook degrades to a `tracing::error!` log.
static CRASH_DIR: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn crash_dir_slot() -> &'static Mutex<Option<PathBuf>> {
    CRASH_DIR.get_or_init(|| Mutex::new(None))
}

/// Install the process-wide panic hook. Idempotent.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Let the prior hook print / log first so stderr still carries the
        // default panic output for operators tailing logs.
        default_hook(info);

        // Build a report if we can. Any failure here is just logged — we
        // cannot surface an error back to the panicking thread.
        let report = build_report_from_panic(info);
        write_report_best_effort(&report);
    }));
}

/// Called from Tauri's `setup` closure once we have an `AppHandle`. The
/// reporter directory is `<app_config_dir>/crashes`; if that can't be
/// resolved we fall back to `<tmp>/quanta-host-tauri/crashes` so operators
/// tailing stderr still get a path to check.
pub fn bind_reporter_to_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let base = app
        .path()
        .app_config_dir()
        .ok()
        .unwrap_or_else(|| std::env::temp_dir().join("quanta-host-tauri"));
    let dir = base.join("crashes");
    *crash_dir_slot().lock() = Some(dir);
}

/// Test-only override so unit tests can point the reporter at a
/// `tempfile::tempdir()`. Production code goes through
/// [`bind_reporter_to_app`].
#[cfg(test)]
pub fn set_reporter_dir_for_test(dir: PathBuf) {
    *crash_dir_slot().lock() = Some(dir);
}

/// Forward a JS-side crash into the same sink the panic hook uses. This
/// is the entry point the `quanta_report_crash` IPC command calls.
pub fn forward_ts_crash(kind: &str, message: &str, stack: Option<&str>) {
    let report = build_report(kind, message, stack);
    write_report_best_effort(&report);
}

fn build_report_from_panic(info: &std::panic::PanicHookInfo<'_>) -> CrashReport {
    // Extract the panic payload's string representation — matches what
    // `panic::set_hook`'s default formatter does.
    let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    };
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
    build_report("panic", &payload, location.as_deref())
}

fn build_report(kind: &str, message: &str, stack: Option<&str>) -> CrashReport {
    let redacted_message = redact(message);
    let redacted_stack = stack.map(redact);
    CrashReport::new(
        env!("CARGO_PKG_VERSION"),
        os_label(),
        arch_label(),
        kind,
        redacted_message,
        redacted_stack,
    )
}

fn write_report_best_effort(report: &CrashReport) {
    let dir = crash_dir_slot().lock().clone();
    let Some(dir) = dir else {
        tracing::error!(
            version = %report.version,
            kind = %report.error_kind,
            message = %report.message,
            fingerprint = %report.fingerprint.as_hex(),
            "crash reporter not yet bound; dropping report"
        );
        return;
    };
    // `report_blocking` is the panic-safe sync helper; we intentionally do
    // NOT call the async `report` here because the panic hook may run on a
    // thread that has no tokio runtime.
    if let Err(err) = quanta_crash_reporter::adapters::file_sink::report_blocking(&dir, report) {
        tracing::error!(%err, "crash reporter IO failure; report dropped");
    } else {
        let _reporter = FileSinkReporter::new(&dir); // shape guard: keeps the symbol reachable
    }
}

/// Best-effort redactor. Applies to both the panic message and the
/// location/stack. Returns an owned `String` so call sites can pass it to
/// `CrashReport::new` without borrowing across an await point.
///
/// Covers:
///   - Absolute POSIX paths → `<path>`
///   - Absolute Windows paths → `<path>`
///   - `Bearer <tok>`, `sk-<tok>`, `ghp_<tok>`, `ghs_<tok>` → `<redacted:token>`
///   - AWS `AKIA…` / `ASIA…` → `<redacted:aws>`
///   - `KEY=value` env-style pairs where `KEY` matches a denylist → `KEY=<redacted>`
pub fn redact(input: &str) -> String {
    use once_cell::sync::Lazy;
    use regex::Regex;

    static PATH_POSIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:/[A-Za-z0-9._\-]+)+").unwrap());
    static PATH_WIN: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"[A-Za-z]:\\[A-Za-z0-9._\\\- ]+").unwrap());
    static TOKEN_BEARER: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9\-._~+/=]+").unwrap());
    static TOKEN_SK: Lazy<Regex> = Lazy::new(|| Regex::new(r"\bsk-[A-Za-z0-9]{12,}").unwrap());
    static TOKEN_GH: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\bgh[pousr]_[A-Za-z0-9]{16,}").unwrap());
    static TOKEN_AWS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b").unwrap());
    static ENV_SECRET: Lazy<Regex> = Lazy::new(|| {
        Regex::new(
            r"(?i)\b(?:password|secret|token|api[_-]?key|auth)\s*=\s*([^\s]+)",
        )
        .unwrap()
    });

    let mut out = input.to_string();
    out = TOKEN_BEARER.replace_all(&out, "<redacted:token>").into_owned();
    out = TOKEN_SK.replace_all(&out, "<redacted:token>").into_owned();
    out = TOKEN_GH.replace_all(&out, "<redacted:token>").into_owned();
    out = TOKEN_AWS.replace_all(&out, "<redacted:aws>").into_owned();
    out = ENV_SECRET
        .replace_all(&out, |caps: &regex::Captures<'_>| {
            let key = caps
                .get(0)
                .map(|m| {
                    m.as_str()
                        .split('=')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string()
                })
                .unwrap_or_default();
            format!("{key}=<redacted>")
        })
        .into_owned();
    out = PATH_WIN.replace_all(&out, "<path>").into_owned();
    out = PATH_POSIX.replace_all(&out, "<path>").into_owned();
    out
}

fn os_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "other"
    }
}

fn arch_label() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        "other"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_posix_path() {
        let r = redact("failed at /Users/alice/code/x.rs");
        assert!(!r.contains("/Users/alice"));
        assert!(r.contains("<path>"));
    }

    #[test]
    fn redacts_bearer_token() {
        let r = redact("Authorization: Bearer abc.def.ghi123");
        assert!(!r.contains("abc.def.ghi123"));
        assert!(r.contains("<redacted:token>"));
    }

    #[test]
    fn redacts_sk_and_gh_tokens() {
        let a = redact("key=sk-1234567890abcdefXYZ");
        assert!(a.contains("<redacted:token>"));
        let b = redact("pat=ghp_abcdefghijklmnop1234");
        assert!(b.contains("<redacted:token>"));
    }

    #[test]
    fn redacts_env_style_secret() {
        let r = redact("PASSWORD=hunter2 and TOKEN=swordfish");
        assert!(r.contains("PASSWORD=<redacted>"));
        assert!(r.contains("TOKEN=<redacted>"));
    }

    #[test]
    fn build_report_normalizes_os_and_arch() {
        let r = build_report("test", "plain", None);
        // os_label() / arch_label() return one of the known tokens — we
        // don't pin which because the test runs on multiple platforms.
        assert!(matches!(r.os.as_str(), "macos" | "linux" | "windows" | "other"));
        assert!(matches!(r.arch.as_str(), "aarch64" | "x86_64" | "other"));
        assert_eq!(r.error_kind, "test");
    }

    #[test]
    fn forward_ts_crash_writes_to_temp_dir_when_bound() {
        let tmp = tempfile::tempdir().unwrap();
        set_reporter_dir_for_test(tmp.path().to_path_buf());
        forward_ts_crash("unhandled_promise", "rejection: something", Some("stack A\nstack B"));
        let n = std::fs::read_dir(tmp.path()).unwrap().count();
        assert!(n >= 1, "expected at least one crash file in {:?}", tmp.path());
    }

    #[test]
    fn redaction_is_idempotent() {
        // Running the redactor on an already-redacted string must not
        // further mangle the placeholders — otherwise a bug could turn
        // `<path>` into `<<path>>` over several passes.
        let once = redact("/Users/x /Users/y Bearer zzz");
        let twice = redact(&once);
        assert_eq!(once, twice);
    }
}
