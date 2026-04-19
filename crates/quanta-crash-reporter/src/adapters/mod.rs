//! Adapters for the crash-reporter port.

pub mod file_sink;
mod noop;

pub use file_sink::FileSinkReporter;
pub use noop::NoopReporter;
