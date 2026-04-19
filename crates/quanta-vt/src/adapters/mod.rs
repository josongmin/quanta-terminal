//! Adapters — concrete implementations that depend on external crates
//! (notably `vte`). Per ADR 0014, only this module may import `vte::`.

pub mod damage_tracker;
pub mod grid_renderer;
pub mod vte_processor;

pub use damage_tracker::{RowDamage, RowDamageTracker};
pub use grid_renderer::GridRenderer;
pub use vte_processor::VteProcessor;
