//! `quanta-crash-reporter` — crash-reporting abstraction per ADR 0014.
//!
//! # Scope
//!
//! Integration POINT, not a SaaS commitment. The audit flagged that we had
//! no Sentry/Bugsnag/Glitchtip wiring and no story for local crash logs
//! either; this crate defines the boundary so a future PR can drop in a
//! Sentry adapter without touching the host. Today we ship two adapters:
//!
//! - `NoopReporter` — the default. Drops reports on the floor; appropriate
//!   for dev / CI / self-hosted users who don't want telemetry.
//! - `FileSinkReporter` — writes a JSON file per crash into a caller-supplied
//!   directory. Useful for local triage and as a durable fallback when a
//!   remote reporter is down.
//!
//! # Architecture
//!
//! Hexagonal (ADR 0014):
//!
//! - `domain/` — pure value types (`CrashReport`, `CrashFingerprint`).
//! - `ports/` — `CrashReporter` trait.
//! - `adapters/` — `NoopReporter`, `FileSinkReporter`.
//!
//! # Redaction
//!
//! The reporter is deliberately the last ring before persistence. It does
//! NOT itself redact — callers must feed it already-redacted `CrashReport`
//! instances. See `packages/host-tauri/src-tauri/src/crash.rs` for the
//! host-side redactor that feeds this crate.

pub mod adapters;
pub mod domain;
pub mod ports;

pub use adapters::{FileSinkReporter, NoopReporter};
pub use domain::{CrashFingerprint, CrashReport};
pub use ports::{CrashReporter, CrashReporterError};
