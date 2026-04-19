//! No-op reporter — the default when telemetry is disabled.
//!
//! Returns `Ok(())` unconditionally. Counts calls for tests that need to
//! pin "the reporter was invoked but we don't send anywhere".

use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;

use crate::domain::CrashReport;
use crate::ports::{CrashReporter, CrashReporterError};

/// No-op crash reporter.
#[derive(Debug, Default)]
pub struct NoopReporter {
    count: AtomicUsize,
}

impl NoopReporter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of reports submitted so far. Test-only accessor; production
    /// code uses the trait.
    #[must_use]
    pub fn call_count(&self) -> usize {
        self.count.load(Ordering::Relaxed)
    }
}

#[async_trait]
impl CrashReporter for NoopReporter {
    async fn report(&self, _event: CrashReport) -> Result<(), CrashReporterError> {
        self.count.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::CrashReport;

    #[tokio::test]
    async fn noop_records_but_returns_ok() {
        let r = NoopReporter::new();
        let evt = CrashReport::new("0.1.0", "linux", "x86_64", "panic", "boom", None);
        r.report(evt).await.unwrap();
        assert_eq!(r.call_count(), 1);
    }

    #[tokio::test]
    async fn noop_tolerates_multiple_reports() {
        let r = NoopReporter::new();
        for i in 0..3 {
            r.report(CrashReport::new(
                "0.1.0",
                "linux",
                "x86_64",
                "panic",
                format!("boom-{i}"),
                None,
            ))
            .await
            .unwrap();
        }
        assert_eq!(r.call_count(), 3);
    }
}
