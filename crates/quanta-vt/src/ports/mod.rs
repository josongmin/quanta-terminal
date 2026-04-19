//! Ports — outward-facing trait / payload surfaces.
//!
//! Per ADR 0014, ports may not import from [`crate::adapters`]. They hold
//! value types produced by the engine (events, envelopes, payload structs)
//! and traits consumed by external layers (e.g. [`TerminalInput`] is
//! implemented by EPIC-E).

pub mod event;
pub mod input;

pub use event::{
    CellRun, ClipboardPayload, CursorPayload, EventEnvelope, GridDelta, GridSnapshot,
    ModeChangedPayload, RectDamage, RowDelta, SessionId, SyncUpdatePayload, TerminalEvent,
};
pub use input::{FocusEvent, KeyEvent, MouseEvent, PasteEvent, TerminalInput};

// Re-export mode-state helpers used on event payloads.
pub use crate::domain::mode_state::{KittyKeyboardLevel, MouseEncoding, MouseProtocol};
