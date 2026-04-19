//! Metrics recorder adapters.
//!
//! Two implementations:
//!
//! - [`InMemoryRecorder`] — the production recorder for Phase 1. Holds all
//!   state in local `DashMap`s + `AtomicU64` / `AtomicI64`. No export; the
//!   only read path is [`MetricsRecorder::snapshot`].
//! - [`NoopRecorder`] — a recorder that discards every operation. Useful
//!   for tests that don't care about metrics and for build configs where
//!   the overhead (negligible, but nonzero) isn't wanted.

pub mod in_memory;
pub mod noop;

pub use in_memory::InMemoryRecorder;
pub use noop::NoopRecorder;
