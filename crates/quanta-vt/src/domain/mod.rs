//! Domain value types — pure, alloc-bounded, no IO.
//!
//! Per ADR 0014, this module may not import anything from [`crate::adapters`]
//! or any runtime crate (`tokio`, `async_trait`, `vte`, etc.). It depends on
//! [`quanta_vt_width`] for width/grapheme classification.

pub mod cell;
pub mod charset;
pub mod color;
pub mod cursor;
pub mod grid;
pub mod mode_state;
pub mod modes;
pub mod sgr;

pub use cell::{Cell, CellAttrs, HyperlinkId};
pub use charset::{CharsetSlot, CharsetState, CharsetTable};
pub use color::{Color, NamedColor};
pub use cursor::{Cursor, CursorSave, CursorShape};
pub use grid::{AttrDelta, BufferKind, Grid, GridError, Rect};
pub use mode_state::TerminalModeState;
pub use modes::{DecMode, Modes};
pub use sgr::SgrState;
