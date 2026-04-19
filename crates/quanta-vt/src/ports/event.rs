//! `TerminalEvent` + envelope shapes.
//!
//! Per ADR 0017 §1, every engine-emitted event is wrapped in an
//! [`EventEnvelope`] carrying `(session_id, grid_epoch, sequence_no,
//! buffer_kind, resize_generation)`. The envelope is populated by EPIC-F
//! (session actor) at emit time; this crate produces the inner
//! [`TerminalEvent`] and exposes [`crate::Grid::epoch`] /
//! [`crate::Grid::next_sequence`] so the wrapper has the numbers.

use serde::{Deserialize, Serialize};

use crate::domain::cell::{Cell, HyperlinkId};
use crate::domain::cursor::CursorShape;
use crate::domain::grid::BufferKind;
use crate::domain::mode_state::TerminalModeState;
use crate::domain::modes::DecMode;

/// Session identity. Opaque `u128` so this crate doesn't require `uuid` as
/// a dep; EPIC-F wraps a `Uuid::as_u128()` value.
///
/// Using a `u128` rather than a named `Uuid` keeps this crate's
/// dependency surface minimal (per ADR 0014's "narrow domain deps" rule).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct SessionId(pub u128);

/// Ordered envelope carrying the engine-emitted event payload.
///
/// Per ADR 0017 §2:
/// - Applied in `(grid_epoch, sequence_no)` ascending order.
/// - Stale-`grid_epoch` envelopes are **discarded**.
/// - Stale-`resize_generation` deltas are **discarded**.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope<P> {
    /// Session identity.
    pub session_id: SessionId,
    /// Epoch — bumps on reconnect / reinit.
    pub grid_epoch: u64,
    /// Sequence — strictly ascending within an epoch.
    pub sequence_no: u64,
    /// Buffer kind (Main / Alt).
    pub buffer_kind: BufferKind,
    /// Resize generation — bumps on every resize.
    pub resize_generation: u64,
    /// The inner payload.
    pub payload: P,
}

/// Every user-visible event the engine can emit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalEvent {
    /// Full grid snapshot — on [`crate::Grid::snapshot`], [`crate::Grid::resize`],
    /// or [`crate::Grid::reinit_epoch`] only.
    GridSnapshot(GridSnapshot),
    /// Incremental delta — steady-state output.
    GridDelta(GridDelta),
    /// Cursor moved (separate for efficiency).
    CursorMoved(CursorPayload),
    /// Mode change. Carries the *new* snapshot plus the list of modes that
    /// changed, so consumers can diff cheaply.
    ModeChanged(ModeChangedPayload),
    /// OSC 0 / 2 title change.
    TitleChanged(String),
    /// OSC 7 CWD change (URI-decoded).
    CwdChanged(String),
    /// BEL (0x07) received.
    BellRequested,
    /// OSC 8 hyperlink open.
    HyperlinkOpened {
        id: HyperlinkId,
        uri: String,
        params: Option<String>,
    },
    /// OSC 8 hyperlink close.
    HyperlinkClosed { id: HyperlinkId },
    /// OSC 52 clipboard request.
    ClipboardRequest(ClipboardPayload),
    /// OSC passthrough — consumed by EPIC-F (palette, shell integration).
    OscPassthrough { code: u16, data: Vec<u8> },
    /// CSI 3 J — scrollback cleared.
    ClearScrollback,
    /// [`crate::Grid::resize`] result.
    Resize {
        rows: u16,
        cols: u16,
        resize_generation: u64,
    },
    /// DECSET 2026 / DCS sync-update transitions.
    SynchronizedUpdate(SyncUpdatePayload),
    /// Unknown CSI — telemetry.
    UnknownCsi {
        final_byte: u8,
        intermediates: Vec<u8>,
        params: Vec<u16>,
    },
    /// Unknown OSC — telemetry.
    UnknownOsc { code: u16 },
    /// Unknown DEC private mode — telemetry.
    UnknownDecMode { code: u16, set: bool },
}

/// Full grid snapshot payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GridSnapshot {
    /// Row count.
    pub rows: u16,
    /// Column count.
    pub cols: u16,
    /// Which buffer this snapshot is of.
    pub buffer_kind: BufferKind,
    /// Cells, rows-major. Length == `rows`; each inner Vec length == `cols`.
    pub cells: Vec<Vec<Cell>>,
    /// Per-row continuation flags. Length == `rows`.
    pub continuations: Vec<bool>,
    /// Per-row revision counters. Length == `rows`.
    pub row_revisions: Vec<u64>,
    /// Cursor state.
    pub cursor: CursorPayload,
    /// Mode snapshot at the time of capture.
    pub modes: TerminalModeState,
}

/// Incremental grid delta.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct GridDelta {
    /// Rows that changed. Only dirty rows are present.
    pub row_deltas: Vec<RowDelta>,
    /// Scroll-region rect damage.
    pub rect_damage: Vec<RectDamage>,
    /// How many rows were appended to scrollback this feed.
    pub scrollback_appended: u32,
}

/// Per-row cell delta with run-length encoding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RowDelta {
    /// Row index.
    pub row: u16,
    /// New row revision.
    pub revision: u64,
    /// Cell runs (contiguous spans sharing attrs).
    pub runs: Vec<CellRun>,
    /// Continuation flag (true = soft-wrap successor).
    pub continuation: bool,
}

/// Contiguous run of cells.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CellRun {
    /// Leftmost column of the run.
    pub start_col: u16,
    /// Cells in the run.
    pub cells: Vec<Cell>,
}

/// Rectangular damage (scroll regions).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RectDamage {
    /// Inclusive top row.
    pub top: u16,
    /// Inclusive left column.
    pub left: u16,
    /// Inclusive bottom row.
    pub bottom: u16,
    /// Inclusive right column.
    pub right: u16,
    /// Revision at which the rect was dirtied.
    pub revision: u64,
}

/// Cursor event payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorPayload {
    /// Row.
    pub row: u16,
    /// Col.
    pub col: u16,
    /// Visible.
    pub visible: bool,
    /// Shape.
    pub shape: CursorShape,
    /// Pending-wrap.
    pub pending_wrap: bool,
}

/// Mode-change event payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModeChangedPayload {
    /// New mode snapshot (full).
    pub state: TerminalModeState,
    /// The DEC modes that changed in this batch.
    pub changed: Vec<DecMode>,
}

/// OSC 52 clipboard payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ClipboardPayload {
    /// Set clipboard contents.
    Set { selection: u8, data: String },
    /// Query clipboard contents.
    Query { selection: u8 },
}

/// Synchronized-update (DECSET 2026 / DCS BSU/ESU) transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncUpdatePayload {
    /// BSU — begin synchronized update.
    Begin,
    /// ESU — end synchronized update.
    End,
    /// Timeout — budget exceeded, engine force-flushed.
    Timeout,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trips_json() {
        let e = EventEnvelope {
            session_id: SessionId(42),
            grid_epoch: 1,
            sequence_no: 7,
            buffer_kind: BufferKind::Main,
            resize_generation: 3,
            payload: TerminalEvent::BellRequested,
        };
        let j = serde_json::to_string(&e).expect("serialize");
        let round: EventEnvelope<TerminalEvent> = serde_json::from_str(&j).expect("deserialize");
        assert_eq!(e, round);
    }

    #[test]
    fn session_id_hashable() {
        use std::collections::HashSet;
        let mut set = HashSet::new();
        set.insert(SessionId(1));
        assert!(set.contains(&SessionId(1)));
    }

    #[test]
    fn grid_delta_default_empty() {
        let d = GridDelta::default();
        assert!(d.row_deltas.is_empty());
        assert!(d.rect_damage.is_empty());
        assert_eq!(d.scrollback_appended, 0);
    }

    #[test]
    fn all_event_variants_serialize() {
        let events = [
            TerminalEvent::BellRequested,
            TerminalEvent::TitleChanged("t".into()),
            TerminalEvent::CwdChanged("/tmp".into()),
            TerminalEvent::ClearScrollback,
            TerminalEvent::Resize {
                rows: 24,
                cols: 80,
                resize_generation: 1,
            },
            TerminalEvent::SynchronizedUpdate(SyncUpdatePayload::Begin),
            TerminalEvent::UnknownOsc { code: 999 },
            TerminalEvent::UnknownDecMode {
                code: 12,
                set: true,
            },
        ];
        for e in events {
            let j = serde_json::to_string(&e).expect("serialize");
            let _: TerminalEvent = serde_json::from_str(&j).expect("deserialize");
        }
    }
}
