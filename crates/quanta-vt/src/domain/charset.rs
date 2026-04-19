//! Charset state — G0/G1/G2/G3 designation, GL/GR invocation, single-shift.
//!
//! Only DEC Special Graphics (`ESC ( 0`) is fully table-driven in v1. UK
//! (`ESC ( A`) and French / German / etc. national charsets are recognized
//! but left as identity maps (tracked as deferred in telemetry). ASCII
//! (`ESC ( B`) is the identity.

use serde::{Deserialize, Serialize};

/// Active charset slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CharsetSlot {
    G0,
    G1,
    G2,
    G3,
}

/// Concrete charset designation for a slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CharsetTable {
    /// `ESC ( B` / `ESC ) B` — US ASCII. Identity map.
    #[default]
    Ascii,
    /// `ESC ( 0` — DEC special graphics (box drawing).
    DecSpecialGraphics,
    /// `ESC ( A` — United Kingdom. Currently identity except `#` → `£`;
    /// tracked as deferred.
    Uk,
}

impl CharsetTable {
    /// Translate an ASCII code point through this charset table.
    ///
    /// Non-ASCII (> 0x7F) passes through unchanged — the table operates on
    /// the 7-bit set only. This matches xterm's GL/GR behavior.
    #[must_use]
    pub fn translate(self, c: char) -> char {
        if !c.is_ascii() {
            return c;
        }
        match self {
            Self::Ascii => c,
            Self::DecSpecialGraphics => dec_special_graphics(c),
            Self::Uk => match c {
                '#' => '£',
                other => other,
            },
        }
    }

    /// Parse a charset designator byte (the character after `ESC (` / `ESC )`).
    /// Returns [`None`] for designators we don't recognise; caller bumps a
    /// telemetry counter and leaves the slot as-is.
    #[must_use]
    pub fn from_designator(byte: u8) -> Option<Self> {
        match byte {
            b'B' => Some(Self::Ascii),
            b'0' => Some(Self::DecSpecialGraphics),
            b'A' => Some(Self::Uk),
            _ => None,
        }
    }
}

/// Full charset invocation state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CharsetState {
    /// G0 slot designation.
    pub g0: CharsetTable,
    /// G1 slot designation.
    pub g1: CharsetTable,
    /// G2 slot designation.
    pub g2: CharsetTable,
    /// G3 slot designation.
    pub g3: CharsetTable,
    /// Active GL slot (most input bytes, < 0x80).
    pub gl: CharsetSlot,
    /// Active GR slot (bytes ≥ 0x80). Rare in v1.
    pub gr: CharsetSlot,
    /// Single-shift (SS2 / SS3) — consumed by the next printable char.
    pub single_shift: Option<CharsetSlot>,
}

impl Default for CharsetState {
    fn default() -> Self {
        Self {
            g0: CharsetTable::Ascii,
            g1: CharsetTable::Ascii,
            g2: CharsetTable::Ascii,
            g3: CharsetTable::Ascii,
            gl: CharsetSlot::G0,
            gr: CharsetSlot::G1,
            single_shift: None,
        }
    }
}

impl CharsetState {
    /// Active slot at print time: single-shift wins (and is consumed),
    /// else GL for bytes < 0x80, else GR.
    ///
    /// **Consume behavior**: callers MUST call [`CharsetState::translate`]
    /// exactly once per print; it clears `single_shift` as a side effect.
    pub fn translate(&mut self, c: char) -> char {
        let slot = self.single_shift.take().unwrap_or({
            if (c as u32) < 0x80 {
                self.gl
            } else {
                self.gr
            }
        });
        self.table(slot).translate(c)
    }

    /// Read-only peek of the currently active slot's designation.
    #[must_use]
    pub fn table(&self, slot: CharsetSlot) -> CharsetTable {
        match slot {
            CharsetSlot::G0 => self.g0,
            CharsetSlot::G1 => self.g1,
            CharsetSlot::G2 => self.g2,
            CharsetSlot::G3 => self.g3,
        }
    }

    /// Assign a designation to a slot.
    pub fn set(&mut self, slot: CharsetSlot, table: CharsetTable) {
        match slot {
            CharsetSlot::G0 => self.g0 = table,
            CharsetSlot::G1 => self.g1 = table,
            CharsetSlot::G2 => self.g2 = table,
            CharsetSlot::G3 => self.g3 = table,
        }
    }
}

/// DEC Special Graphics translation table. Covers the standard box-drawing
/// characters in the 0x60..=0x7E range. Everything else is passthrough.
///
/// Reference: xterm ctlseqs §VT100 Alternate Character Set.
fn dec_special_graphics(c: char) -> char {
    match c {
        '`' => '\u{25C6}', // ◆
        'a' => '\u{2592}', // ▒
        'b' => '\u{2409}', // ␉ (HT symbol)
        'c' => '\u{240C}', // ␌ (FF symbol)
        'd' => '\u{240D}', // ␍ (CR symbol)
        'e' => '\u{240A}', // ␊ (LF symbol)
        'f' => '\u{00B0}', // °
        'g' => '\u{00B1}', // ±
        'h' => '\u{2424}', // ␤ (NL symbol)
        'i' => '\u{240B}', // ␋ (VT symbol)
        'j' => '\u{2518}', // ┘
        'k' => '\u{2510}', // ┐
        'l' => '\u{250C}', // ┌
        'm' => '\u{2514}', // └
        'n' => '\u{253C}', // ┼
        'o' => '\u{23BA}', // ⎺ (scan 1)
        'p' => '\u{23BB}', // ⎻ (scan 3)
        'q' => '\u{2500}', // ─
        'r' => '\u{23BC}', // ⎼ (scan 7)
        's' => '\u{23BD}', // ⎽ (scan 9)
        't' => '\u{251C}', // ├
        'u' => '\u{2524}', // ┤
        'v' => '\u{2534}', // ┴
        'w' => '\u{252C}', // ┬
        'x' => '\u{2502}', // │
        'y' => '\u{2264}', // ≤
        'z' => '\u{2265}', // ≥
        '{' => '\u{03C0}', // π
        '|' => '\u{2260}', // ≠
        '}' => '\u{00A3}', // £
        '~' => '\u{00B7}', // ·
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_ascii_identity() {
        let mut s = CharsetState::default();
        assert_eq!(s.translate('A'), 'A');
        assert_eq!(s.translate('~'), '~');
    }

    #[test]
    fn dec_line_drawing_translates() {
        let mut s = CharsetState::default();
        s.g0 = CharsetTable::DecSpecialGraphics;
        assert_eq!(s.translate('q'), '─');
        assert_eq!(s.translate('x'), '│');
        assert_eq!(s.translate('l'), '┌');
    }

    #[test]
    fn uk_swaps_hash() {
        let mut s = CharsetState::default();
        s.g0 = CharsetTable::Uk;
        assert_eq!(s.translate('#'), '£');
        assert_eq!(s.translate('A'), 'A');
    }

    #[test]
    fn single_shift_consumed_on_next_print() {
        let mut s = CharsetState::default();
        s.g2 = CharsetTable::DecSpecialGraphics;
        s.single_shift = Some(CharsetSlot::G2);
        assert_eq!(s.translate('q'), '─');
        // single-shift consumed; next read goes through GL (= G0 ASCII).
        assert_eq!(s.translate('q'), 'q');
    }

    #[test]
    fn non_ascii_passes_through() {
        let mut s = CharsetState::default();
        s.g0 = CharsetTable::DecSpecialGraphics;
        assert_eq!(s.translate('한'), '한');
    }

    #[test]
    fn designator_mapping() {
        assert_eq!(
            CharsetTable::from_designator(b'B'),
            Some(CharsetTable::Ascii)
        );
        assert_eq!(
            CharsetTable::from_designator(b'0'),
            Some(CharsetTable::DecSpecialGraphics),
        );
        assert_eq!(CharsetTable::from_designator(b'A'), Some(CharsetTable::Uk));
        assert_eq!(CharsetTable::from_designator(b'Z'), None);
    }

    #[test]
    fn set_and_read_back_slot() {
        let mut s = CharsetState::default();
        s.set(CharsetSlot::G2, CharsetTable::DecSpecialGraphics);
        assert_eq!(s.table(CharsetSlot::G2), CharsetTable::DecSpecialGraphics);
    }
}
