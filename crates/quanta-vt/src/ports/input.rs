//! [`TerminalInput`] trait — frozen shape for EPIC-E's input encoder.
//!
//! Per ADR 0017 §4, the encoder reads a [`TerminalModeState`] **snapshot** at
//! the start of each call. This trait takes `&TerminalModeState` by reference
//! so the caller decides snapshot freshness.
//!
//! Concrete `KeyEvent` / `MouseEvent` shapes are reserved here but fleshed
//! out by EPIC-E. We commit to the method signatures so EPIC-B's freeze
//! holds without pre-empting EPIC-E's design.

use serde::{Deserialize, Serialize};

use crate::domain::mode_state::TerminalModeState;

/// Input encoder contract. Implemented by EPIC-E.
///
/// **Rule (ADR 0017 §4)**: every `encode_*` call receives a snapshot; the
/// implementation MUST NOT dereference or clone any live grid state. The
/// snapshot is the sole read surface.
pub trait TerminalInput: Send + Sync {
    /// Encode a key event per negotiated protocol.
    fn encode_key(&self, event: &KeyEvent, modes: &TerminalModeState) -> Vec<u8>;
    /// Encode a mouse event.
    fn encode_mouse(&self, event: &MouseEvent, modes: &TerminalModeState) -> Vec<u8>;
    /// Encode a paste (wrapping in bracketed-paste markers if enabled).
    fn encode_paste(&self, event: &PasteEvent, modes: &TerminalModeState) -> Vec<u8>;
    /// Encode a focus in/out event if `focus_report` is enabled.
    fn encode_focus(&self, event: &FocusEvent, modes: &TerminalModeState) -> Vec<u8>;
}

/// Opaque key event. Fields reserved; EPIC-E expands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyEvent {
    /// Semantic key symbol (opaque string until EPIC-E defines enum).
    pub key: String,
    /// Modifier bitmask.
    pub modifiers: u8,
    /// Optional text (dead-key / IME commit payload).
    pub text: Option<String>,
    /// Is this a key-repeat?
    pub repeat: bool,
}

/// Opaque mouse event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MouseEvent {
    /// Zero-indexed column on the grid.
    pub col: u16,
    /// Zero-indexed row on the grid.
    pub row: u16,
    /// Button (opaque until EPIC-E).
    pub button: u8,
    /// Kind (press / release / motion).
    pub kind: u8,
    /// Modifiers bitmask.
    pub modifiers: u8,
}

/// Opaque paste event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PasteEvent {
    /// Paste data (bytes).
    pub data: Vec<u8>,
}

/// Focus transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FocusEvent {
    /// Terminal gained focus.
    FocusIn,
    /// Terminal lost focus.
    FocusOut,
}

#[cfg(test)]
mod tests {
    use super::*;

    // Dummy impl — compile-check the trait shape.
    struct Dummy;

    impl TerminalInput for Dummy {
        fn encode_key(&self, _: &KeyEvent, _: &TerminalModeState) -> Vec<u8> {
            Vec::new()
        }
        fn encode_mouse(&self, _: &MouseEvent, _: &TerminalModeState) -> Vec<u8> {
            Vec::new()
        }
        fn encode_paste(&self, _: &PasteEvent, _: &TerminalModeState) -> Vec<u8> {
            Vec::new()
        }
        fn encode_focus(&self, _: &FocusEvent, _: &TerminalModeState) -> Vec<u8> {
            Vec::new()
        }
    }

    #[test]
    fn trait_is_object_safe() {
        let d: Box<dyn TerminalInput> = Box::new(Dummy);
        let _ = d.encode_focus(&FocusEvent::FocusIn, &TerminalModeState::default());
    }

    #[test]
    fn key_event_round_trips() {
        let k = KeyEvent {
            key: "Enter".into(),
            modifiers: 0,
            text: None,
            repeat: false,
        };
        let j = serde_json::to_string(&k).unwrap();
        let r: KeyEvent = serde_json::from_str(&j).unwrap();
        assert_eq!(k, r);
    }
}
