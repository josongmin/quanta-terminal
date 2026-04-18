//! Adapters — Unix-socket transport for control and event planes.

#[cfg(unix)]
mod unix_socket;

#[cfg(unix)]
pub use unix_socket::UnixSocketServer;

#[cfg(not(unix))]
pub use placeholder::UnixSocketServer;

#[cfg(not(unix))]
mod placeholder {
    use std::sync::Arc;

    use crate::ports::ControlHandler;

    /// Non-unix placeholder — Phase 1 targets macOS/Linux only.
    #[derive(Debug)]
    pub struct UnixSocketServer;

    impl UnixSocketServer {
        pub fn new<P: AsRef<std::path::Path>>(_p: P, _h: Arc<dyn ControlHandler>) -> Self {
            Self
        }
        pub async fn serve(self) -> Result<(), crate::ports::ProtocolError> {
            Err(crate::ports::ProtocolError::Io(
                "unix sockets not supported on this platform".into(),
            ))
        }
    }
}
