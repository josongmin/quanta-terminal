//! Cursor position, shape, visibility, and save/restore (DECSC / DECRC).
//!
//! Cursor save is a snapshot of `(cursor, sgr, charset, origin_mode)`. Main
//! and alt buffers carry independent save stacks so `vim` entering alt,
//! saving, leaving alt, saving again behaves correctly.

use serde::{Deserialize, Serialize};

use crate::domain::charset::CharsetState;
use crate::domain::sgr::SgrState;

/// Cursor position and shape.
///
/// `row` / `col` are zero-indexed. `pending_wrap` is the DECAWM one-shot
/// flag that a write at the last column sets; the next printable char
/// wraps to the next row. This matches xterm semantics and retires RFC
/// 0001 §22 #9 (vim `ZZ` cursor drift).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    /// Row (0 = top of viewport).
    pub row: u16,
    /// Column (0 = left).
    pub col: u16,
    /// Cursor visible (DECTCEM).
    pub visible: bool,
    /// Cursor shape.
    pub shape: CursorShape,
    /// Cursor blink hint (renderer may respect or ignore).
    pub blink: bool,
    /// DECAWM pending wrap: last write consumed column `cols - 1` and a
    /// wide char; next printable flushes to next row.
    pub pending_wrap: bool,
}

impl Default for Cursor {
    fn default() -> Self {
        Self {
            row: 0,
            col: 0,
            visible: true,
            shape: CursorShape::Block,
            blink: true,
            pending_wrap: false,
        }
    }
}

impl Cursor {
    /// Clamp `(row, col)` to `[0, rows) × [0, cols)`. Used on resize and
    /// after any operation that could have placed the cursor out of range.
    pub fn clamp(&mut self, rows: u16, cols: u16) {
        if rows == 0 || cols == 0 {
            // Degenerate geometry — callers validate before calling; this
            // is a belt-and-braces clamp to keep the cursor within the row
            // indices we will index into.
            self.row = 0;
            self.col = 0;
            self.pending_wrap = false;
            return;
        }
        self.row = self.row.min(rows - 1);
        self.col = self.col.min(cols - 1);
    }
}

/// Cursor shape for `CSI n SP q` (DECSCUSR).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorShape {
    /// `CSI 2 SP q` — solid block.
    Block,
    /// `CSI 1 SP q` or `CSI 0 SP q` — blinking block.
    BlockBlink,
    /// `CSI 4 SP q` — solid underline.
    Underline,
    /// `CSI 3 SP q` — blinking underline.
    UnderlineBlink,
    /// `CSI 6 SP q` — solid I-beam.
    Bar,
    /// `CSI 5 SP q` — blinking I-beam.
    BarBlink,
}

impl CursorShape {
    /// Map a DECSCUSR parameter `0..=6` to a [`CursorShape`].
    ///
    /// Returns [`None`] for out-of-range values; caller bumps a telemetry
    /// counter rather than silently clamping.
    #[must_use]
    pub fn from_decscusr(param: u16) -> Option<Self> {
        match param {
            0 | 1 => Some(Self::BlockBlink),
            2 => Some(Self::Block),
            3 => Some(Self::UnderlineBlink),
            4 => Some(Self::Underline),
            5 => Some(Self::BarBlink),
            6 => Some(Self::Bar),
            _ => None,
        }
    }
}

/// Snapshot captured by DECSC / `ESC 7` / DECSET 1048 / DECSET 1049.
///
/// Restoring (DECRC / `ESC 8`) pops the save back into the grid. Main and
/// alt have independent stacks so crossing the alt-screen boundary never
/// leaks a save across.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorSave {
    /// Cursor at save time.
    pub cursor: Cursor,
    /// SGR pen state at save time.
    pub sgr: SgrState,
    /// Charset state at save time.
    pub charset: CharsetState,
    /// DECOM origin-mode flag at save time.
    pub origin_mode: bool,
}

impl CursorSave {
    /// Capture a save from live state.
    #[must_use]
    pub fn capture(
        cursor: Cursor,
        sgr: SgrState,
        charset: CharsetState,
        origin_mode: bool,
    ) -> Self {
        Self {
            cursor,
            sgr,
            charset,
            origin_mode,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_cursor_is_visible_block() {
        let c = Cursor::default();
        assert_eq!(c.row, 0);
        assert_eq!(c.col, 0);
        assert!(c.visible);
        assert_eq!(c.shape, CursorShape::Block);
    }

    #[test]
    fn clamp_beyond_geometry() {
        let mut c = Cursor {
            row: 100,
            col: 200,
            ..Cursor::default()
        };
        c.clamp(24, 80);
        assert_eq!(c.row, 23);
        assert_eq!(c.col, 79);
    }

    #[test]
    fn clamp_noop_within_bounds() {
        let mut c = Cursor {
            row: 5,
            col: 10,
            ..Cursor::default()
        };
        c.clamp(24, 80);
        assert_eq!(c.row, 5);
        assert_eq!(c.col, 10);
    }

    #[test]
    fn clamp_zero_geometry_is_safe() {
        let mut c = Cursor {
            row: 5,
            col: 10,
            ..Cursor::default()
        };
        c.clamp(0, 0);
        assert_eq!(c.row, 0);
        assert_eq!(c.col, 0);
    }

    #[test]
    fn decscusr_param_mapping() {
        assert_eq!(CursorShape::from_decscusr(0), Some(CursorShape::BlockBlink));
        assert_eq!(CursorShape::from_decscusr(1), Some(CursorShape::BlockBlink));
        assert_eq!(CursorShape::from_decscusr(2), Some(CursorShape::Block));
        assert_eq!(
            CursorShape::from_decscusr(3),
            Some(CursorShape::UnderlineBlink)
        );
        assert_eq!(CursorShape::from_decscusr(4), Some(CursorShape::Underline));
        assert_eq!(CursorShape::from_decscusr(5), Some(CursorShape::BarBlink));
        assert_eq!(CursorShape::from_decscusr(6), Some(CursorShape::Bar));
        assert_eq!(CursorShape::from_decscusr(7), None);
    }
}
