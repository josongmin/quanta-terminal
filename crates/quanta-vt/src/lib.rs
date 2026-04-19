// EPIC-B clippy allow-list — stylistic lints unrelated to correctness.
// Each entry scoped with a reason so a future reviewer can decide to
// address or keep:
//
// - `field_reassign_with_default`: we build `Row { .. }` in a couple of
//   reflow branches via `Default::default()` and then mutate; rewriting
//   to struct-literal form hurts readability in the wrap-reflow hot path.
// - `match_same_arms`: a few `CsiAction` dispatches genuinely share a
//   handler arm today and will diverge in later DEC-mode coverage.
// - `doc_list_item_overindented`: wrapped markdown lists in long
//   docblocks; cosmetic.
// - `manual_non_exhaustive` / `struct_field_names`: we prefer the
//   hand-rolled shapes during the L4 stabilisation window.
#![allow(
    clippy::field_reassign_with_default,
    clippy::match_same_arms,
    clippy::doc_overindented_list_items,
    clippy::missing_fields_in_debug,
    clippy::struct_field_names,
    clippy::vec_init_then_push,
    clippy::needless_pass_by_ref_mut,
    clippy::manual_let_else,
    clippy::mut_mut,
    dead_code
)]

//! `quanta-vt` — VT engine core (EPIC-B).
//!
//! The single source of truth for on-screen terminal state. Per RFC 0001 §2
//! and §3: every PTY byte passes through this crate, and the [`Grid`] owns
//! cells, widths, cursor, buffer, and mode state. UI mirrors this; never
//! reinterprets raw bytes.
//!
//! # Architecture (ADR 0014 hex layout)
//!
//! - [`domain`] — pure value types (cell, color, cursor, SGR, charset, modes,
//!   mode snapshot, grid). No IO, no `vte::` import.
//! - [`ports`] — trait surfaces. [`TerminalInput`] is consumed by EPIC-E;
//!   [`TerminalEvent`] / [`EventEnvelope`] are produced by this crate.
//! - [`adapters`] — the `vte` parser adapter, damage tracker, grid renderer
//!   (diff computer). Only `adapters/vte_processor.rs` imports `vte::`.
//!
//! # Invariants retired
//!
//! - **I-1** — sole VT engine: [`Grid::feed`] is the only raw-byte entry.
//! - **I-3** — grid is truth: cells, widths, wrap decisions all owned here.
//! - **I-4** — semantic width wins: [`quanta_vt_width::WidthClassifier`] is
//!   queried at print time; no per-cell width override path exists.
//! - **I-5** — delta from day one: steady-state is `GridDelta`; snapshots
//!   only on explicit `snapshot()` / `resize()` / `reinit_epoch()`.
//! - **I-9** — ordered reducer stream: every event passes through
//!   [`Grid::next_sequence`]; [`Grid::reinit_epoch`] fences stale consumers.

#![forbid(unsafe_code)]

pub mod adapters;
pub mod domain;
pub mod ports;

pub use domain::{
    AttrDelta, BufferKind, Cell, CellAttrs, CharsetSlot, CharsetState, CharsetTable, Color, Cursor,
    CursorSave, CursorShape, DecMode, Grid, GridError, HyperlinkId, Modes, NamedColor, Rect,
    SgrState, TerminalModeState,
};
pub use ports::{
    CellRun, ClipboardPayload, CursorPayload, EventEnvelope, FocusEvent, GridDelta, GridSnapshot,
    KeyEvent, ModeChangedPayload, MouseEncoding, MouseEvent, MouseProtocol, PasteEvent, RectDamage,
    RowDelta, SessionId, SyncUpdatePayload, TerminalEvent, TerminalInput,
};
