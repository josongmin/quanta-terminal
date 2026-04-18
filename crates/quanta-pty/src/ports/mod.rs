//! Ports — async traits the session actor depends on.

use async_trait::async_trait;

use crate::domain::{PtyExit, PtySize, PtySpec};

/// Errors returned by a `PtyPort`.
#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("failed to spawn pty: {0}")]
    Spawn(String),
    #[error("pty io error: {0}")]
    Io(String),
    #[error("pty has been closed")]
    Closed,
    #[error("other pty error: {0}")]
    Other(String),
}

impl From<std::io::Error> for PtyError {
    fn from(e: std::io::Error) -> Self {
        PtyError::Io(e.to_string())
    }
}

/// An open PTY handle. Drop semantics close the PTY.
#[async_trait]
pub trait PtyHandle: Send + Sync + std::fmt::Debug {
    /// Read as many bytes as are available, up to `buf.len()`. Zero return means EOF.
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, PtyError>;

    /// Write all of `data` to the PTY master.
    async fn write_all(&mut self, data: &[u8]) -> Result<(), PtyError>;

    /// Resize the PTY.
    async fn resize(&mut self, size: PtySize) -> Result<(), PtyError>;

    /// Wait for the child to exit.
    async fn wait(&mut self) -> Result<PtyExit, PtyError>;

    /// Best-effort immediate kill. Does not wait.
    async fn kill(&mut self) -> Result<(), PtyError>;

    /// The OS pid of the child process, if known.
    fn pid(&self) -> Option<u32>;
}

/// Port for opening new PTYs.
#[async_trait]
pub trait PtyPort: Send + Sync + std::fmt::Debug {
    /// Spawn a PTY running `spec`. The returned handle owns the master side.
    async fn open(&self, spec: PtySpec) -> Result<Box<dyn PtyHandle>, PtyError>;
}
