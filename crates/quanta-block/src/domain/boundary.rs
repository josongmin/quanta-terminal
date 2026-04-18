//! Boundary event values and the sink trait used to deliver them.
//!
//! This module is **pure domain**: no parsing, no infrastructure, no `vte`.
//! The concrete stream parser lives in [`crate::adapters::boundary`].
//!
//! Signals modeled:
//! - OSC 133 `A` (prompt start), `B` (command start), `C` (output start),
//!   `D` (command done, optional exit code).
//! - OSC 7 (`file://...` cwd advertisement).
//! - Alt-screen enter / exit transitions.

/// Semantic boundary events emitted by a detector.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BoundaryEvent {
    /// OSC 133 A — prompt is about to be drawn. Block boundary candidate.
    PromptStart,
    /// OSC 133 B — command accepted, execution begins.
    CommandStart,
    /// OSC 133 C — output stream begins.
    OutputStart,
    /// OSC 133 D — command completed. May include an exit code.
    CommandDone { exit_code: Option<i32> },
    /// OSC 7 — shell announced a new cwd.
    CwdAdvertised { cwd: String },
    /// Alt-screen entered: TUI owns the terminal.
    AltScreenEntered,
    /// Alt-screen exited: control returns.
    AltScreenExited,
}

/// Sink for boundary events. A `Vec<BoundaryEvent>` is the primary test sink.
pub trait BoundarySink {
    fn on_event(&mut self, event: BoundaryEvent);
}

impl BoundarySink for Vec<BoundaryEvent> {
    fn on_event(&mut self, event: BoundaryEvent) {
        self.push(event);
    }
}
