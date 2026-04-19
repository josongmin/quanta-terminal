// Stylistic clippy lints we live with for the L4 stabilisation window.
// Each entry has a reason; see the matching note in `quanta-vt`.
#![allow(clippy::match_same_arms, clippy::doc_overindented_list_items)]

//! `quanta-vt-width` — width, grapheme, and line-break single source of truth.
//!
//! This crate is the **sole** authority for:
//!
//! 1. Grapheme segmentation (user-perceived character boundaries).
//! 2. Display width classification (zero / one / two cells).
//! 3. Wrap eligibility (does `next` fit in the current row, given `prev`?).
//! 4. Continuation-row semantics surface (consumed by `quanta-vt` in EPIC-B).
//!
//! Every other crate and every TypeScript consumer MUST go through this
//! surface. The TS mirror under `packages/ui/src/shared/lib/width/` is
//! byte-for-byte parity-tested against the golden corpora in
//! `tests/fixtures/`. If you add an override, you update both sides in the
//! same PR — the parity test fails otherwise.
//!
//! # Architecture
//!
//! Hexagonal per ADR 0014:
//!
//! - [`domain`] — pure value types (no IO, no allocation beyond SmallString,
//!   no tokio). [`CellWidth`], [`Grapheme`], [`AmbiguousWidthPolicy`],
//!   [`WrapEligibility`].
//! - [`ports`] — the [`WidthClassifier`] trait, so the engine can swap in a
//!   different policy for testing without touching call sites.
//! - [`adapters`] — [`DefaultClassifier`], the production implementation
//!   wrapping `unicode-segmentation` + `unicode-width` + the curated
//!   override table in [`overrides`].
//!
//! # Invariant (RFC 0001 §I-4)
//!
//! Semantic width wins, paint adapts. A renderer MAY NOT override what this
//! crate says. If a glyph's pixel metrics disagree with the semantic cell
//! width, the paint layer is required to pad / kern / scale around it —
//! never silently correct the width.
//!
//! # Failure modes retired (RFC 0001 §22)
//!
//! - `#5` — `한` must be 2 cells on every platform, every policy.
//! - `#6` — ZWJ emoji (`👨‍👩‍👧‍👦`) must be 2 cells regardless of code-point count.
//! - `#7` — `VS16` (U+FE0F) must not flip width mid-stream.

#![forbid(unsafe_code)]

pub mod adapters;
pub mod domain;
pub mod overrides;
pub mod ports;

pub use adapters::DefaultClassifier;
pub use domain::{AmbiguousWidthPolicy, CellWidth, Grapheme, OsKind, WrapEligibility};
pub use ports::WidthClassifier;

/// Pinned Unicode version. Bumps require a parity-test run.
///
/// Read by the corpus generator + parity tests so a stale corpus is a
/// test-time failure, not a review-taste issue.
pub const UNICODE_VERSION: &str = "15.1.0";
