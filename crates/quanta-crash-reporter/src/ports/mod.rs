//! Crash-reporter ports.
//!
//! The trait is intentionally minimal so adapters for Sentry, Bugsnag,
//! Glitchtip, and self-hosted endpoints can all implement it without
//! compromising the integration point.

use async_trait::async_trait;

use crate::domain::CrashReport;

/// Errors surfaced by crash-reporter adapters. Adapters SHOULD never
/// propagate a panic or I/O failure; the host wraps `report` in a
/// fail-silent guard because a crash reporter that panics during
/// reporting loops forever. This error type exists for logging, not for
/// recovery.
#[derive(Debug, thiserror::Error)]
pub enum CrashReporterError {
    #[error("io error: {0}")]
    Io(String),
    #[error("serialization error: {0}")]
    Encode(String),
    #[error("reporter unavailable: {0}")]
    Unavailable(String),
}

/// Submit a crash report. Trait objects must be `Send + Sync` so the
/// host can call `report` from the panic hook's thread.
#[async_trait]
pub trait CrashReporter: Send + Sync + std::fmt::Debug {
    /// Submit a single report. Implementations MUST NOT panic.
    async fn report(&self, event: CrashReport) -> Result<(), CrashReporterError>;
}
