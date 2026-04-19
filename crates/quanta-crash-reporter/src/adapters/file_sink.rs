//! File-sink reporter. Writes each report as a JSON file under the
//! configured directory. Filename is `{fingerprint_hex}-{ulid}.json` so
//! identical-shape crashes are easy to group via prefix and each call is
//! unique (prevents collisions when a user hits the same crash twice in
//! rapid succession).
//!
//! Failure handling: any IO error is returned as `CrashReporterError::Io`;
//! the host wraps `report` in a fail-silent guard because a crash path
//! that errors on its own log is worse than a silent drop.

use std::path::PathBuf;

use async_trait::async_trait;
use ulid::Ulid;

use crate::domain::CrashReport;
use crate::ports::{CrashReporter, CrashReporterError};

#[derive(Debug)]
pub struct FileSinkReporter {
    dir: PathBuf,
}

impl FileSinkReporter {
    /// Construct with the directory crashes will be written to. The
    /// directory is created on first write — callers do not need to
    /// pre-create it.
    #[must_use]
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Directory the reporter writes into. Exposed for tests and so the
    /// host can surface it in diagnostic UI ("crash logs at …").
    #[must_use]
    pub fn dir(&self) -> &std::path::Path {
        &self.dir
    }
}

#[async_trait]
impl CrashReporter for FileSinkReporter {
    async fn report(&self, event: CrashReport) -> Result<(), CrashReporterError> {
        let payload = serde_json::to_vec_pretty(&event)
            .map_err(|e| CrashReporterError::Encode(e.to_string()))?;
        let fingerprint_hex = event.fingerprint.as_hex();
        let filename = format!("{}-{}.json", fingerprint_hex, Ulid::new());
        let dir = self.dir.clone();

        // `tokio::task::spawn_blocking` would require a live runtime; the
        // hook may run from the Rust panic context where tokio's not
        // around. Do the IO synchronously — async_trait gives us the
        // right signature without forcing a runtime dependency.
        tokio::task::block_in_place(|| {
            std::fs::create_dir_all(&dir).map_err(|e| CrashReporterError::Io(e.to_string()))?;
            let path = dir.join(filename);
            std::fs::write(&path, &payload).map_err(|e| CrashReporterError::Io(e.to_string()))
        })
    }
}

/// Synchronous helper used by the panic hook so we can report crashes
/// without a tokio runtime available. Shares the serialization path with
/// the async impl so the on-disk format is identical.
///
/// # Errors
///
/// Returns [`CrashReporterError`] if serialization or filesystem IO fails.
pub fn report_blocking(
    dir: &std::path::Path,
    event: &CrashReport,
) -> Result<(), CrashReporterError> {
    let payload =
        serde_json::to_vec_pretty(event).map_err(|e| CrashReporterError::Encode(e.to_string()))?;
    let fingerprint_hex = event.fingerprint.as_hex();
    let filename = format!("{}-{}.json", fingerprint_hex, Ulid::new());
    std::fs::create_dir_all(dir).map_err(|e| CrashReporterError::Io(e.to_string()))?;
    let path = dir.join(filename);
    std::fs::write(&path, &payload).map_err(|e| CrashReporterError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::CrashReport;

    #[test]
    fn report_blocking_writes_file_with_fingerprint_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let evt = CrashReport::new("0.1.0", "linux", "x86_64", "panic", "kaboom", None);
        let fp = evt.fingerprint.as_hex();
        report_blocking(tmp.path(), &evt).unwrap();
        let files: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .collect();
        assert_eq!(files.len(), 1);
        let name = files[0].file_name().into_string().unwrap();
        assert!(
            name.starts_with(&fp),
            "filename {name} must start with fingerprint {fp}"
        );
        let content = std::fs::read_to_string(files[0].path()).unwrap();
        assert!(content.contains("kaboom"));
        assert!(content.contains("\"fingerprint\""));
    }

    #[test]
    fn report_blocking_creates_dir_if_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("does/not/exist/yet");
        let evt = CrashReport::new("0.1.0", "linux", "x86_64", "panic", "x", None);
        report_blocking(&nested, &evt).unwrap();
        assert!(nested.is_dir());
    }

    #[test]
    fn report_blocking_two_identical_crashes_produce_two_files() {
        // Identical fingerprint + ULID uniqueness → two files, both
        // prefixed with the same fingerprint. Regression guard so a
        // future refactor that keys by fingerprint alone doesn't
        // accidentally lose data.
        let tmp = tempfile::tempdir().unwrap();
        let a = CrashReport::new("0.1.0", "linux", "x86_64", "panic", "dup", None);
        let b = a.clone();
        report_blocking(tmp.path(), &a).unwrap();
        report_blocking(tmp.path(), &b).unwrap();
        let n = std::fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(n, 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn async_report_writes_file() {
        let tmp = tempfile::tempdir().unwrap();
        let reporter = FileSinkReporter::new(tmp.path());
        let evt = CrashReport::new("0.1.0", "macos", "aarch64", "panic", "async", None);
        reporter.report(evt).await.unwrap();
        let n = std::fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(n, 1);
    }
}
