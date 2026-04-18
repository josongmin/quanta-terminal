//! `quanta-security` — Phase-1 secret detection and redaction per ADR 0006.
//!
//! # Scope
//!
//! Per ADR 0006 §Scope redaction applies to the **persisted** and **exported**
//! representations only. The live PTY stream and raw in-memory buffer are user
//! observable truth and are NOT redacted by this crate. Callers are expected
//! to redact at the boundary between streaming and persistence (see
//! `quanta-session` wiring).
//!
//! # Architecture
//!
//! Hexagonal, per ADR 0014:
//!
//! - `domain/` — pure value types (`SecretClass`, `Redaction`, `RedactedString`,
//!   `RedactionRule`) and pure helpers (`redact_env_key`, `redact_command`).
//! - `ports/` — `SecretDetector` trait.
//! - `adapters/` — `DefaultDetector`, the Phase-1 implementation driven by a
//!   versioned data ruleset.
//!
//! # Ruleset Versioning
//!
//! Every `Redaction` carries a `ruleset_version`. Bumping [`RULESET_VERSION`]
//! is a deliberate review surface: it marks a policy change that may require
//! historical rescan of persisted blocks.

pub mod adapters;
pub mod domain;
pub mod ports;

pub use adapters::DefaultDetector;
pub use domain::{
    redact_command, redact_env_key, RedactedString, Redaction, RedactionRule, SecretClass,
    RULESET_VERSION,
};
pub use ports::SecretDetector;
