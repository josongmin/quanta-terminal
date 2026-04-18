//! Adapters — concrete implementations of the PTY ports.

#[cfg(unix)]
pub mod portable;

#[cfg(unix)]
pub use portable::PortablePtyPort;
