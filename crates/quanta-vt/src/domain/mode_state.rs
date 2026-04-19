//! [`TerminalModeState`] — the input-encoder-facing snapshot per ADR 0017 §4.
//!
//! This struct is *the* view the encoder reads to encode a key / mouse /
//! paste event. Per ADR 0017, encoders read a **snapshot**, never live state.
//! Grid produces one via [`TerminalModeState::snapshot_from`] at the start of
//! an encode call; any mode change landing mid-encode is invisible to the
//! encoder and applies only on the next snapshot.

use serde::{Deserialize, Serialize};

use crate::domain::modes::{DecMode, Modes};

/// Mouse reporting protocol tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseProtocol {
    /// No mouse events.
    #[default]
    Off,
    /// Legacy X10 (press only).
    X10,
    /// DECSET 1000 — button press + release.
    Button,
    /// DECSET 1002 — button + motion-while-pressed.
    Drag,
    /// DECSET 1003 — all motion.
    Any,
}

/// Mouse wire encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseEncoding {
    /// Legacy 3-byte `ESC [ M b cx cy` encoding.
    #[default]
    Legacy,
    /// DECSET 1006 — SGR encoding `ESC [ < b;cx;cy M/m`.
    Sgr,
}

/// Kitty keyboard protocol progressive-enhancement level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KittyKeyboardLevel {
    /// Not negotiated; input encoder emits legacy bytes.
    #[default]
    Disabled,
    /// Level 1 — disambiguate escape codes.
    L1,
    /// Level 2 — + report event type.
    L2,
    /// Level 3 — + alternate keys + text as code point.
    L3,
}

/// Snapshot of terminal mode state relevant to input encoding.
///
/// **Produced by** [`TerminalModeState::snapshot_from`] from a live [`Modes`].
/// **Consumed by** the EPIC-E input encoder. The encoder receives a
/// `&TerminalModeState` reference; never looks at the live grid. ADR 0017 §4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TerminalModeState {
    /// DECCKM — cursor keys send application-mode sequences.
    pub cursor_key_app: bool,
    /// DECSET 2004 — bracketed paste.
    pub bracketed_paste: bool,
    /// DECSET 1004 — focus reporting.
    pub focus_report: bool,
    /// Active mouse protocol.
    pub mouse_protocol: MouseProtocol,
    /// Mouse wire encoding.
    pub mouse_encoding: MouseEncoding,
    /// `modifyOtherKeys` level (0 / 1 / 2). Tracked separately from DEC
    /// modes — xterm manages it via `CSI > 4;n m`.
    pub modify_other_keys: u8,
    /// Kitty keyboard progressive-enhancement level.
    pub kitty_keyboard: KittyKeyboardLevel,
    /// DECSET 47/1047/1049 — alt-screen active.
    pub alt_screen: bool,
    /// DECSET 2026 — synchronized update active.
    pub sync_update: bool,
    /// DECAWM — auto-wrap.
    pub auto_wrap: bool,
    /// DECOM — origin mode.
    pub origin: bool,
}

impl TerminalModeState {
    /// Derive a snapshot from live [`Modes`].
    ///
    /// **Rule**: NEVER live-read modes mid-encode; snapshot at the start of
    /// each encoder call and pass `&TerminalModeState`. See ADR 0017 §4.
    #[must_use]
    pub fn snapshot_from(modes: &Modes) -> Self {
        let mouse_protocol = if modes.is_set(DecMode::MouseAny) {
            MouseProtocol::Any
        } else if modes.is_set(DecMode::MouseDrag) {
            MouseProtocol::Drag
        } else if modes.is_set(DecMode::MouseButton) {
            MouseProtocol::Button
        } else if modes.is_set(DecMode::MouseX10) {
            MouseProtocol::X10
        } else {
            MouseProtocol::Off
        };

        let mouse_encoding = if modes.is_set(DecMode::MouseSgr) {
            MouseEncoding::Sgr
        } else {
            MouseEncoding::Legacy
        };

        Self {
            cursor_key_app: modes.is_set(DecMode::CursorKey),
            bracketed_paste: modes.is_set(DecMode::BracketedPaste),
            focus_report: modes.is_set(DecMode::FocusReport),
            mouse_protocol,
            mouse_encoding,
            // `modifyOtherKeys` and kitty-keyboard aren't DEC modes; they flow
            // through their own protocol paths and are set via dedicated
            // Grid APIs (currently stubbed — EPIC-E negotiates).
            modify_other_keys: 0,
            kitty_keyboard: KittyKeyboardLevel::Disabled,
            alt_screen: modes.is_set(DecMode::AltScreenBuffer)
                || modes.is_set(DecMode::AltScreenAlt)
                || modes.is_set(DecMode::AltScreenFull),
            sync_update: modes.is_set(DecMode::SyncUpdate),
            auto_wrap: modes.is_set(DecMode::AutoWrap),
            origin: modes.is_set(DecMode::Origin),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_from_initial() {
        let m = Modes::initial();
        let s = TerminalModeState::snapshot_from(&m);
        assert!(s.auto_wrap);
        assert!(!s.alt_screen);
        assert_eq!(s.mouse_protocol, MouseProtocol::Off);
        assert_eq!(s.mouse_encoding, MouseEncoding::Legacy);
    }

    #[test]
    fn snapshot_tracks_bracketed_paste() {
        let mut m = Modes::initial();
        m.set(DecMode::BracketedPaste, true);
        let s = TerminalModeState::snapshot_from(&m);
        assert!(s.bracketed_paste);
    }

    #[test]
    fn snapshot_tracks_cursor_key_app() {
        let mut m = Modes::initial();
        m.set(DecMode::CursorKey, true);
        let s = TerminalModeState::snapshot_from(&m);
        assert!(s.cursor_key_app);
    }

    #[test]
    fn mouse_any_beats_drag_beats_button() {
        let mut m = Modes::initial();
        m.set(DecMode::MouseButton, true);
        assert_eq!(
            TerminalModeState::snapshot_from(&m).mouse_protocol,
            MouseProtocol::Button,
        );
        m.set(DecMode::MouseDrag, true);
        assert_eq!(
            TerminalModeState::snapshot_from(&m).mouse_protocol,
            MouseProtocol::Drag,
        );
        m.set(DecMode::MouseAny, true);
        assert_eq!(
            TerminalModeState::snapshot_from(&m).mouse_protocol,
            MouseProtocol::Any,
        );
    }

    #[test]
    fn mouse_sgr_encoding_flag() {
        let mut m = Modes::initial();
        m.set(DecMode::MouseSgr, true);
        assert_eq!(
            TerminalModeState::snapshot_from(&m).mouse_encoding,
            MouseEncoding::Sgr,
        );
    }

    #[test]
    fn alt_screen_any_variant_triggers_flag() {
        for mode in [
            DecMode::AltScreenBuffer,
            DecMode::AltScreenAlt,
            DecMode::AltScreenFull,
        ] {
            let mut m = Modes::initial();
            m.set(mode, true);
            assert!(
                TerminalModeState::snapshot_from(&m).alt_screen,
                "alt_screen should be true for mode {:?}",
                mode,
            );
        }
    }

    #[test]
    fn focus_report_flag() {
        let mut m = Modes::initial();
        m.set(DecMode::FocusReport, true);
        assert!(TerminalModeState::snapshot_from(&m).focus_report);
    }

    #[test]
    fn sync_update_flag() {
        let mut m = Modes::initial();
        m.set(DecMode::SyncUpdate, true);
        assert!(TerminalModeState::snapshot_from(&m).sync_update);
    }

    #[test]
    fn origin_flag() {
        let mut m = Modes::initial();
        m.set(DecMode::Origin, true);
        assert!(TerminalModeState::snapshot_from(&m).origin);
    }

    #[test]
    fn auto_wrap_off_on_explicit_reset() {
        let mut m = Modes::initial();
        m.set(DecMode::AutoWrap, false);
        assert!(!TerminalModeState::snapshot_from(&m).auto_wrap);
    }

    #[test]
    fn default_snapshot_all_false() {
        let s = TerminalModeState::default();
        assert!(!s.cursor_key_app);
        assert!(!s.bracketed_paste);
        assert!(!s.alt_screen);
        assert_eq!(s.mouse_protocol, MouseProtocol::Off);
        assert_eq!(s.mouse_encoding, MouseEncoding::Legacy);
        assert_eq!(s.kitty_keyboard, KittyKeyboardLevel::Disabled);
    }

    #[test]
    fn snapshot_is_deep_clone_safe() {
        let m = Modes::initial();
        let snap1 = TerminalModeState::snapshot_from(&m);
        let snap2 = snap1;
        assert_eq!(snap1, snap2);
    }
}
