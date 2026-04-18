//! `quanta-diagnostic` — diagnostic parser pipeline.
//!
//! Per [ADR 0007], Phase 1 ships the framework and a fixture corpus under
//! `crates/quanta-diagnostic/fixtures/`. The first wave of shipped parsers
//! (rustc / tsc / Python traceback / Node stack) lands after the walking
//! skeleton stabilizes.
//!
//! This crate therefore contains the domain types and the `ParserAdapter`
//! port today. Concrete parser adapters live under `adapters::<tool>` when
//! they land.

pub mod domain;
pub mod ports;

pub mod adapters {
    //! Adapters — empty in Phase 1.
    //!
    //! The first adapters to land (per ADR 0007 Tier 1) are:
    //!
    //! - `rustc` — rustc / cargo output parser.
    //! - `tsc` — TypeScript compiler parser.
    //! - `python_traceback` — Python traceback parser.
    //! - `node_stack` — Node.js stack-trace parser.
    //!
    //! Each adapter's fixture corpus already lives at
    //! `crates/quanta-diagnostic/fixtures/<parser_id>/` so CI can track
    //! accuracy targets as each parser lands.
}

pub use domain::{Diagnostic, ParserCandidate, Severity};
pub use ports::{ParserAdapter, ParserError, ParserId};
