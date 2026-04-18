//! Ports — the `SecretDetector` trait.
//!
//! Implementations live in `adapters/`. Callers (e.g. `quanta-session`) should
//! depend on the port and accept any `Arc<dyn SecretDetector>` so test rigs can
//! inject mocks.

use crate::domain::Redaction;

/// Detects secrets across env, command, and output surfaces.
///
/// Methods return `Option`/`Vec` — never panic. Every returned [`Redaction`]
/// carries the ruleset version so downstream consumers can compare against
/// the detector they are currently running (rescan prompts, audit).
pub trait SecretDetector: Send + Sync + std::fmt::Debug {
    /// Scan a single `(key, value)` env pair.
    ///
    /// Returns a [`Redaction`] covering the VALUE byte range if the entry
    /// is considered sensitive, or `None` if clean. Offsets are interpreted
    /// in the value; callers apply them as appropriate for their storage
    /// format.
    fn scan_env_entry(&self, key: &str, value: &str) -> Option<Redaction>;

    /// Scan a raw command string.
    ///
    /// Returns offsets of sensitive spans in byte-order. Offsets index into
    /// `command`, not the display representation. Empty input returns empty.
    fn scan_command(&self, command: &str) -> Vec<Redaction>;

    /// Scan captured output bytes for well-known token patterns.
    ///
    /// Called per output chunk at persistence time (ADR 0006 §Detection
    /// Placement). Must be fast; callers may invoke this on every chunk.
    /// Non-UTF-8 bytes are tolerated — implementations should operate on the
    /// decoded lossy form and map offsets conservatively.
    fn scan_output(&self, bytes: &[u8]) -> Vec<Redaction>;

    /// Ruleset version this detector was built against. Persisted alongside
    /// every redaction the detector produces.
    fn ruleset_version(&self) -> u32;
}
