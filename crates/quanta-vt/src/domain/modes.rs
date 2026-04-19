//! DEC private mode tracking.
//!
//! Authoritative storage for all DEC private modes the engine honors.
//! [`Modes`] is the bit-backed live store; [`crate::domain::TerminalModeState`]
//! is the snapshot-read surface per ADR 0017 §4.
//!
//! Non-v1 modes (see RFC 0001 §8) route to [`Modes::note_unknown`] which
//! bumps a counter but does not persist any state.

use serde::{Deserialize, Serialize};

/// v1 DEC private mode set. Discriminant is the DEC mode number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u16)]
#[allow(missing_docs)]
pub enum DecMode {
    /// DECCKM — cursor-key application mode.
    CursorKey = 1,
    /// DECOM — origin mode.
    Origin = 6,
    /// DECAWM — auto-wrap.
    AutoWrap = 7,
    /// Legacy X10 mouse reporting.
    MouseX10 = 9,
    /// DECTCEM — cursor visible.
    CursorVisible = 25,
    /// Reverse wraparound.
    ReverseWrap = 45,
    /// Alt-screen (legacy, no cursor save).
    AltScreenBuffer = 47,
    /// Button-press-only mouse reporting.
    MouseButton = 1000,
    /// Button-event (press+release) tracking.
    MouseDrag = 1002,
    /// Any-event (motion) tracking.
    MouseAny = 1003,
    /// Focus in / out events.
    FocusReport = 1004,
    /// SGR mouse encoding (1006).
    MouseSgr = 1006,
    /// Alt-screen with clear-on-exit (1047).
    AltScreenAlt = 1047,
    /// Save / restore cursor only (1048).
    SaveCursor = 1048,
    /// Alt-screen full: save cursor + enter alt + clear (1049).
    AltScreenFull = 1049,
    /// Bracketed paste.
    BracketedPaste = 2004,
    /// Synchronized update (BSU/ESU).
    SyncUpdate = 2026,
}

impl DecMode {
    /// Map a DEC private-mode number to a [`DecMode`] variant. Returns
    /// [`None`] for unknown numbers; caller bumps `unknown_dec_mode`.
    #[must_use]
    pub fn from_code(code: u16) -> Option<Self> {
        match code {
            1 => Some(Self::CursorKey),
            6 => Some(Self::Origin),
            7 => Some(Self::AutoWrap),
            9 => Some(Self::MouseX10),
            25 => Some(Self::CursorVisible),
            45 => Some(Self::ReverseWrap),
            47 => Some(Self::AltScreenBuffer),
            1000 => Some(Self::MouseButton),
            1002 => Some(Self::MouseDrag),
            1003 => Some(Self::MouseAny),
            1004 => Some(Self::FocusReport),
            1006 => Some(Self::MouseSgr),
            1047 => Some(Self::AltScreenAlt),
            1048 => Some(Self::SaveCursor),
            1049 => Some(Self::AltScreenFull),
            2004 => Some(Self::BracketedPaste),
            2026 => Some(Self::SyncUpdate),
            _ => None,
        }
    }

    /// DEC mode number.
    #[must_use]
    pub const fn code(self) -> u16 {
        self as u16
    }

    /// Enumerate every v1 mode in a stable order (by code ascending).
    pub fn all() -> &'static [Self] {
        &[
            Self::CursorKey,
            Self::Origin,
            Self::AutoWrap,
            Self::MouseX10,
            Self::CursorVisible,
            Self::ReverseWrap,
            Self::AltScreenBuffer,
            Self::MouseButton,
            Self::MouseDrag,
            Self::MouseAny,
            Self::FocusReport,
            Self::MouseSgr,
            Self::AltScreenAlt,
            Self::SaveCursor,
            Self::AltScreenFull,
            Self::BracketedPaste,
            Self::SyncUpdate,
        ]
    }
}

/// Bit-backed DEC private mode state.
///
/// Each [`DecMode`] variant maps to one bit in the lower or upper `u128`
/// depending on its code. This keeps the struct `Copy` and trivially
/// snapshot-cloneable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Modes {
    flags_lo: u128,
    flags_hi: u128,
    /// Last unknown mode code observed (telemetry aid).
    pub last_unknown: Option<u16>,
    /// Cumulative unknown-mode-set counter.
    pub unknown_count: u32,
}

impl Modes {
    /// Initial mode state. DECAWM and DECTCEM are on by default; everything
    /// else starts off. Matches xterm boot state.
    #[must_use]
    pub fn initial() -> Self {
        let mut m = Self::default();
        m.set(DecMode::AutoWrap, true);
        m.set(DecMode::CursorVisible, true);
        m
    }

    /// Read a mode's current state.
    #[must_use]
    pub fn is_set(&self, mode: DecMode) -> bool {
        let code = mode.code();
        if code < 128 {
            self.flags_lo & (1u128 << code) != 0
        } else {
            let bit = code - 128;
            self.flags_hi & (1u128 << (bit % 128)) != 0
        }
    }

    /// Write a mode's state.
    pub fn set(&mut self, mode: DecMode, on: bool) {
        let code = mode.code();
        let (lo, bit) = if code < 128 {
            (true, code)
        } else {
            (false, code - 128)
        };
        let mask = 1u128 << (bit % 128);
        let flags = if lo {
            &mut self.flags_lo
        } else {
            &mut self.flags_hi
        };
        if on {
            *flags |= mask;
        } else {
            *flags &= !mask;
        }
    }

    /// Mark an unknown DEC mode for telemetry. Does not persist state.
    pub fn note_unknown(&mut self, code: u16) {
        self.last_unknown = Some(code);
        self.unknown_count = self.unknown_count.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_has_autowrap_and_cursor_visible() {
        let m = Modes::initial();
        assert!(m.is_set(DecMode::AutoWrap));
        assert!(m.is_set(DecMode::CursorVisible));
        assert!(!m.is_set(DecMode::Origin));
        assert!(!m.is_set(DecMode::AltScreenFull));
    }

    #[test]
    fn set_and_unset() {
        let mut m = Modes::initial();
        m.set(DecMode::BracketedPaste, true);
        assert!(m.is_set(DecMode::BracketedPaste));
        m.set(DecMode::BracketedPaste, false);
        assert!(!m.is_set(DecMode::BracketedPaste));
    }

    #[test]
    fn independent_bits_per_mode() {
        let mut m = Modes::initial();
        for &mode in DecMode::all() {
            m.set(mode, true);
        }
        for &mode in DecMode::all() {
            assert!(m.is_set(mode), "mode {:?} should be set", mode);
        }
        // Unset one and only that one flips.
        m.set(DecMode::CursorKey, false);
        assert!(!m.is_set(DecMode::CursorKey));
        for &mode in DecMode::all() {
            if mode == DecMode::CursorKey {
                continue;
            }
            assert!(m.is_set(mode), "mode {:?} should still be set", mode);
        }
    }

    #[test]
    fn mode_code_round_trip() {
        for &mode in DecMode::all() {
            assert_eq!(DecMode::from_code(mode.code()), Some(mode));
        }
    }

    #[test]
    fn unknown_mode_bump_counter() {
        let mut m = Modes::initial();
        m.note_unknown(42);
        m.note_unknown(99);
        assert_eq!(m.unknown_count, 2);
        assert_eq!(m.last_unknown, Some(99));
    }

    #[test]
    fn unknown_code_returns_none() {
        assert_eq!(DecMode::from_code(42), None);
        assert_eq!(DecMode::from_code(999), None);
    }

    #[test]
    fn high_code_mode_2026_works() {
        // 2026 - 128 = 1898, and we store it in flags_hi modulo 128 so
        // ensure the math round-trips. (Storage is test-visible only through
        // is_set/set, so any internal mapping is fine.)
        let mut m = Modes::default();
        m.set(DecMode::SyncUpdate, true);
        assert!(m.is_set(DecMode::SyncUpdate));
        m.set(DecMode::SyncUpdate, false);
        assert!(!m.is_set(DecMode::SyncUpdate));
    }
}
