//! Filesystem implementation of `MarkerStore`.
//!
//! Writes `<root>/sidecar.shutdown-marker` with the current pid. The presence
//! of the marker at startup means the previous run shut down cleanly.

use std::fs;
use std::path::{Path, PathBuf};

use crate::domain::RecoveryOutcome;
use crate::ports::{MarkerStore, MarkerStoreError};

const MARKER_NAME: &str = "sidecar.shutdown-marker";

#[derive(Debug, Clone)]
pub struct FileMarker {
    path: PathBuf,
}

impl FileMarker {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            path: root.as_ref().join(MARKER_NAME),
        }
    }

    /// Probe at startup: if the marker exists, consume it and report clean start.
    pub fn probe_startup(&self) -> Result<RecoveryOutcome, MarkerStoreError> {
        if self.path.exists() {
            fs::remove_file(&self.path).map_err(MarkerStoreError::from)?;
            Ok(RecoveryOutcome::CleanStart)
        } else {
            Ok(RecoveryOutcome::RecoveredFromCrash)
        }
    }
}

impl MarkerStore for FileMarker {
    fn write(&self) -> Result<(), MarkerStoreError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(MarkerStoreError::from)?;
        }
        fs::write(&self.path, std::process::id().to_string()).map_err(MarkerStoreError::from)?;
        Ok(())
    }

    fn take(&self) -> Result<bool, MarkerStoreError> {
        if self.path.exists() {
            fs::remove_file(&self.path).map_err(MarkerStoreError::from)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_without_marker_reports_crash_recovery() {
        let tmp = tempfile::tempdir().unwrap();
        let m = FileMarker::new(tmp.path());
        let outcome = m.probe_startup().unwrap();
        assert_eq!(outcome, RecoveryOutcome::RecoveredFromCrash);
    }

    #[test]
    fn marker_write_and_probe_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let m = FileMarker::new(tmp.path());
        m.write().unwrap();
        let outcome = m.probe_startup().unwrap();
        assert_eq!(outcome, RecoveryOutcome::CleanStart);
        // Subsequent probe without write now reports crash recovery.
        let outcome = m.probe_startup().unwrap();
        assert_eq!(outcome, RecoveryOutcome::RecoveredFromCrash);
    }

    #[test]
    fn take_reports_presence_then_absence() {
        let tmp = tempfile::tempdir().unwrap();
        let m = FileMarker::new(tmp.path());
        m.write().unwrap();
        assert!(m.take().unwrap());
        assert!(!m.take().unwrap());
    }
}
