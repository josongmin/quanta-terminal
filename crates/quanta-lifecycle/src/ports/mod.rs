//! Ports — the crash-recovery scaffold persists a shutdown marker via this.

/// Errors returned by a [`MarkerStore`].
#[derive(Debug, thiserror::Error)]
pub enum MarkerStoreError {
    /// Underlying IO error (filesystem, permissions).
    #[error("io error: {0}")]
    Io(String),
}

impl From<std::io::Error> for MarkerStoreError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

/// Marker store for shutdown markers. Sync by design — crash recovery runs at
/// startup before any async runtime is mandatory.
pub trait MarkerStore: std::fmt::Debug + Send + Sync {
    /// Place the clean-shutdown marker. Called at the start of a graceful shutdown.
    fn write(&self) -> Result<(), MarkerStoreError>;

    /// Remove the marker atomically. Returns `true` if one existed.
    fn take(&self) -> Result<bool, MarkerStoreError>;
}
