//! `quanta-ai` — AI suggestion flow + risk classifier (ADR 0012).
//!
//! # Scope
//!
//! Implements the Phase-5 foundation for AI-originated commands:
//!
//! 1. A [`RiskClassifier`] that maps a raw shell command to a tier
//!    ([`RiskTier::Safe`]/[`RiskTier::Caution`]/[`RiskTier::Destructive`]/
//!    [`RiskTier::Blocked`]) plus the set of modifiers that fired. The tier
//!    scheme collapses the ADR-0012 five-level ladder into the four review
//!    buckets the approval UI actually branches on; the mapping is
//!    documented on [`RiskTier`]. The composition rules are exactly those in
//!    ADR 0012 §Pipeline Composition Rule and §Escalation Modifiers.
//!
//! 2. A [`SuggestionProvider`] trait with a deterministic mock adapter used
//!    everywhere a real LLM would plug in. Phase 5 intentionally ships no
//!    network-backed provider — that belongs to Phase 6.
//!
//! # Architecture
//!
//! Hexagonal, per ADR 0014:
//!
//! - `domain/` — pure value types (tiers, flags, classified commands, request
//!   / response envelopes). No IO, no async, no regex.
//! - `ports/` — the two async traits the host binds to.
//! - `adapters/` — `HeuristicClassifier` (the Phase-5 rule table, boring by
//!   design) and `MockProvider` (canned suggestions so every higher layer
//!   can be tested without a network).
//!
//! # Determinism
//!
//! The classifier is a pure function of its input. Same command → same
//! `ClassifiedCommand` — always. The tests in `tests/classifier.rs` pin this
//! with a proptest.
//!
//! The floor-only rule from ADR 0012 is preserved: a parse failure can only
//! escalate a command, never demote it.

pub mod adapters;
pub mod domain;
pub mod ports;

pub use adapters::{
    AnthropicProvider, AnthropicProviderBuilder, ApiKey, HeuristicClassifier, MockProvider,
    DEFAULT_MODEL as ANTHROPIC_DEFAULT_MODEL,
};
pub use domain::{
    ClassifiedCommand, RiskFlags, RiskModifier, RiskTier, SuggestionId, SuggestionRequest,
    SuggestionResponse, RULESET_VERSION,
};
pub use ports::{RiskClassifier, SuggestionProvider, SuggestionProviderError};
