//! Grid-reducer event payloads — the wire mirror of EPIC-B's
//! `quanta_vt::ports::event::TerminalEvent` family.
//!
//! These payloads are self-contained (no `quanta-vt` dep) because `quanta-proto`
//! sits below `quanta-vt` in the crate graph per ADR 0014. The session actor
//! (EPIC-F) is the seam that lifts VT `TerminalEvent` values into these
//! wire-typed payloads at fan-out time.
//!
//! # Ordering invariants (ADR 0017 §2)
//!
//! Every grid payload rides an [`crate::envelope::Envelope`] that carries a
//! `(grid_epoch, sequence_no == monotonic_seq, resize_generation)` tuple.
//! Mirror consumers **discard**:
//!
//! - envelopes with `grid_epoch < state.epoch`,
//! - [`GridDeltaPayload`] envelopes with `resize_generation < state.resize_generation`,
//! - non-snapshot envelopes with `sequence_no <= state.applied_sequence`.
//!
//! # Forward compatibility
//!
//! Every additive field here carries `#[serde(default)]`. Variants are added
//! only through the `Event` enum; old decoders land in `Event::Unknown`.

use serde::{Deserialize, Serialize};

use crate::envelope::BufferKind;

/// Full grid snapshot. Emitted on: initial subscribe, epoch change, resize,
/// divergence resync, host restart. Applying a snapshot clears prior mirror
/// state.
///
/// Kept intentionally shallow: row contents live inline as [`RowDeltaWire`]
/// entries so the mirror's `applySnapshot` and `applyDelta` paths share
/// expansion logic. See `docs/plans/0001-.../epic-C-protocol-mirror.md` §1.2.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GridSnapshotPayload {
    /// Row count.
    pub rows: u32,
    /// Column count.
    pub cols: u32,
    /// Which buffer this snapshot captures.
    pub buffer_kind: BufferKind,
    /// Complete row contents, 0..rows.
    pub row_deltas: Vec<RowDeltaWire>,
    /// Cursor at snapshot time. `None` when invisible (DECSET 25 off).
    #[serde(default)]
    pub cursor: Option<CursorStateWire>,
    /// Mode-state snapshot. See ADR 0017 §4.
    pub mode_state: TerminalModeStateWire,
    /// Extensibility bucket. Additive-only; new snapshot-level fields go here.
    #[serde(default)]
    pub meta: GridMetaWire,
}

/// Incremental row-level delta. Steady-state event.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GridDeltaPayload {
    /// Row deltas ordered by row ascending. Each entry passes
    /// `revision_before` against the mirror's row-revision array.
    pub row_deltas: Vec<RowDeltaWire>,
    /// Rectangular scroll operations applied BEFORE the row deltas above.
    #[serde(default)]
    pub scrolls: Vec<ScrollDeltaWire>,
    /// How many rows were appended to scrollback this feed (main buffer only).
    #[serde(default)]
    pub scrollback_appended: u32,
}

/// Rectangular scroll — applied to a row/column range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScrollDeltaWire {
    /// Inclusive top row.
    pub top: u32,
    /// Inclusive bottom row.
    pub bottom: u32,
    /// Positive = scroll up (rows move toward top), negative = scroll down.
    pub lines: i32,
    /// Column range left bound (default 0 = full-width).
    #[serde(default)]
    pub left: u32,
    /// Column range right bound. `None` = extend to last column.
    #[serde(default)]
    pub right: Option<u32>,
}

/// Per-row replacement content.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowDeltaWire {
    /// Row index.
    pub row: u32,
    /// Mirror's expected `row_revisions[row]` before applying. Revision
    /// mismatch triggers `ResyncRowRequest`.
    pub revision_before: u32,
    /// Row's new revision after applying. Monotonic; callers tolerate u32 wrap.
    pub revision_after: u32,
    /// Spans covering the row, left→right, contiguous, no gaps.
    pub spans: Vec<CellSpanWire>,
    /// Soft-wrap flag (true = visually continues from row-1 without a hard newline).
    #[serde(default)]
    pub continuation: bool,
    /// Hyperlink ids referenced by any span in this row.
    #[serde(default)]
    pub hyperlink_refs: Vec<u32>,
}

/// A run of cells sharing SGR attrs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CellSpanWire {
    /// Number of columns this span occupies.
    pub cols: u16,
    /// SGR packed into a u64, emitted as a hex string (see plan §2.3).
    pub sgr: String,
    /// Grapheme content encoding.
    pub graphemes: GraphemeRunWire,
    /// Optional OSC 8 hyperlink id; `0` means none.
    #[serde(default)]
    pub hyperlink_id: u32,
    /// Extra attrs that don't fit in the SGR u64 (truecolor underline, etc.).
    #[serde(default)]
    pub ext: Option<SpanAttrsExtWire>,
}

/// Run encoding for grapheme content inside a [`CellSpanWire`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum GraphemeRunWire {
    /// Blank run — span is pure blanks with SGR applied. JSON: the bare
    /// string `"blank"`.
    Blank(BlankTag),
    /// Inline UTF-8 bytes (short runs). JSON: `{"utf8": "abc"}` or
    /// `{"utf8": [237, 149, 156]}`.
    Inline { utf8: Utf8Run },
    /// Single grapheme repeated N columns. JSON:
    /// `{"grapheme": "─", "count": 40}`.
    Repeat { grapheme: String, count: u32 },
}

/// Newtype carrying the literal `"blank"` string marker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlankTag {
    /// The blank marker.
    Blank,
}

/// UTF-8 content of a grapheme run: either a JSON string or a raw byte array.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Utf8Run {
    /// Printable UTF-8 emitted as a JSON string (the common ASCII case).
    Str(String),
    /// Raw bytes emitted as a JSON array (CJK, emoji, ZWJ sequences).
    Bytes(Vec<u8>),
}

/// Attribute extension map for SGR bits that don't fit in the u64.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpanAttrsExtWire {
    /// Truecolor underline as `0xRRGGBB`. `None` = inherit fg.
    #[serde(default)]
    pub underline_color: Option<u32>,
}

/// Cursor-only event payload.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorMovedPayload {
    /// New cursor state.
    pub cursor: CursorStateWire,
}

/// Cursor wire state. Invisible cursors carry `visible: false` and the
/// renderer suppresses the glyph (DECSET 25 off).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorStateWire {
    /// Row (0-indexed, viewport-relative).
    pub row: u32,
    /// Column (0-indexed).
    pub col: u32,
    /// Cursor visible.
    pub visible: bool,
    /// Cursor shape.
    pub shape: CursorShapeWire,
    /// Blink-hint (renderer owns timing).
    pub blinking: bool,
    /// DECAWM pending-wrap one-shot (see ADR 0017 §3).
    #[serde(default)]
    pub pending_wrap: bool,
}

impl Default for CursorStateWire {
    fn default() -> Self {
        Self {
            row: 0,
            col: 0,
            visible: true,
            shape: CursorShapeWire::Block,
            blinking: true,
            pending_wrap: false,
        }
    }
}

/// Renderer-facing cursor shape.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorShapeWire {
    /// Block cursor.
    #[default]
    Block,
    /// Underline cursor.
    Underline,
    /// Bar / beam cursor.
    Bar,
}

/// Mode-change event payload. Multiple flips batched per emit so the mirror
/// sees them atomically.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModeChangedPayload {
    /// Changed flags.
    pub changes: Vec<ModeChangeWire>,
    /// Fresh snapshot of the full mode state after applying.
    pub state: TerminalModeStateWire,
}

/// Single mode transition.
///
/// Internally tagged so future additions are visible to old decoders as
/// "unknown variant" (deserialize error) — that error is the fence for the
/// engine to bump `grid_epoch` on negotiation. See plan §1.5.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ModeChangeWire {
    /// DECCKM — cursor-key application mode.
    Decckm { value: bool },
    /// DECSET 2004 — bracketed paste.
    BracketedPaste { value: bool },
    /// DECSET 1004 — focus reporting.
    FocusReporting { value: bool },
    /// Mouse tracking level.
    MouseTracking { value: MouseTrackingModeWire },
    /// Mouse wire encoding.
    MouseEncoding { value: MouseEncodingWire },
    /// `modifyOtherKeys` level (0 / 1 / 2).
    ModifyOtherKeys { value: u8 },
    /// Kitty keyboard progressive-enhancement level (0..=5).
    KittyKeyboard { value: u8 },
    /// DECSET 47 / 1047 / 1049 — alt-screen active.
    AltScreen { value: bool },
    /// DECSET 2026 — synchronized update active.
    SynchronizedUpdate { value: bool },
}

/// Mirror of `quanta_vt::MouseProtocol` for the wire.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseTrackingModeWire {
    /// No mouse events.
    #[default]
    Off,
    /// Legacy X10 (press only).
    X10,
    /// DECSET 1000 — button press + release.
    ButtonEvent,
    /// DECSET 1003 — all motion.
    AnyEvent,
}

/// Mirror of `quanta_vt::MouseEncoding` for the wire.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseEncodingWire {
    /// Legacy 3-byte encoding.
    #[default]
    Default,
    /// UTF-8 encoding (rare).
    Utf8,
    /// DECSET 1006 — SGR encoding.
    Sgr,
    /// URL xterm variant.
    UrlXterm,
}

/// Mirror of `TerminalModeState` for the wire.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalModeStateWire {
    /// DECCKM.
    #[serde(default)]
    pub decckm: bool,
    /// DECSET 2004.
    #[serde(default)]
    pub bracketed_paste: bool,
    /// DECSET 1004.
    #[serde(default)]
    pub focus_reporting: bool,
    /// Mouse tracking tier.
    #[serde(default)]
    pub mouse_tracking: MouseTrackingModeWire,
    /// Mouse wire encoding.
    #[serde(default)]
    pub mouse_encoding: MouseEncodingWire,
    /// `modifyOtherKeys` level.
    #[serde(default)]
    pub modify_other_keys: u8,
    /// Kitty keyboard level.
    #[serde(default)]
    pub kitty_keyboard: u8,
    /// Alt-screen active.
    #[serde(default)]
    pub alt_screen: bool,
    /// Synchronized-update active.
    #[serde(default)]
    pub synchronized_update: bool,
}

/// Grid-level ancillary metadata. Additive-only.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GridMetaWire {
    /// Current title (OSC 0/2).
    #[serde(default)]
    pub title: Option<String>,
    /// Current CWD (OSC 7 URI-decoded).
    #[serde(default)]
    pub cwd: Option<String>,
    /// Opaque digest over the active hyperlink table (for resume replay
    /// determinism checks; see plan §9 TODO #2).
    #[serde(default)]
    pub hyperlink_digest: Option<String>,
}

/// OSC 0 / 2 title change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TitleChangedPayload {
    /// New title.
    pub title: String,
    /// Which title scope(s) were updated.
    #[serde(default)]
    pub scope: TitleScopeWire,
}

/// OSC title target (icon / window / both).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleScopeWire {
    /// OSC 0 — both window and icon.
    #[default]
    Both,
    /// OSC 1 — icon only.
    Icon,
    /// OSC 2 — window only.
    Window,
}

/// BEL / DECSET 1042 — bell requested. UI decides audible vs visual.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BellRequestedPayload {
    /// Bell flavor. Separate field name so it does not collide with
    /// the outer `Event` enum's `kind` discriminator.
    #[serde(default)]
    pub kind_of_bell: BellKindWire,
}

/// Bell flavor.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BellKindWire {
    /// Audible beep.
    #[default]
    Audible,
    /// Visual flash.
    Visual,
    /// Urgency hint to the window manager.
    UrgencyHint,
}

/// OSC 8 hyperlink announced — the URI goes into a per-session id table.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HyperlinkAddedPayload {
    /// Stable id within `(session, epoch)`. Span cells reference this id.
    pub id: u32,
    /// Target URI.
    pub uri: String,
    /// Optional OSC 8 `params` (e.g., `id=foo`).
    #[serde(default)]
    pub params: Option<String>,
}

/// OSC 8 hyperlink retired. Mirrors drop the id from their table when the
/// refcount reaches zero.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HyperlinkRemovedPayload {
    /// Id being removed.
    pub id: u32,
}

/// OSC 52 clipboard request. Policy-gated per ADR 0016.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClipboardRequestPayload {
    /// Which selection buffer.
    pub selection: ClipboardSelectionWire,
    /// Set (with base64 data) or Query.
    pub op: ClipboardOpWire,
}

/// OSC 52 selection buffer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardSelectionWire {
    /// CLIPBOARD selection.
    #[default]
    Clipboard,
    /// PRIMARY selection (Xorg).
    Primary,
    /// SECONDARY selection.
    Secondary,
    /// Select buffer (rarely used; treat as CLIPBOARD).
    Select,
}

/// OSC 52 op — Set (with base64 data) or Query.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ClipboardOpWire {
    /// Set clipboard contents to the given base64 data.
    Set {
        /// Base64-encoded clipboard bytes (UTF-8 after decode).
        base64_data: String,
    },
    /// Query the current clipboard contents (host-side decision to honor).
    Query,
}

/// DECSET 2026 / DCS BSU/ESU synchronized-update transition.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SynchronizedUpdatePayload {
    /// Begin or End.
    pub phase: SyncPhaseWire,
}

/// Synchronized-update phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncPhaseWire {
    /// Begin synchronized window — mirror suppresses `onChange` until End.
    Begin,
    /// End synchronized window — mirror flushes accumulated dirty set.
    End,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_snapshot_payload_round_trips() {
        let p = GridSnapshotPayload {
            rows: 2,
            cols: 4,
            buffer_kind: BufferKind::Main,
            row_deltas: vec![RowDeltaWire {
                row: 0,
                revision_before: 0,
                revision_after: 1,
                spans: vec![CellSpanWire {
                    cols: 4,
                    sgr: "0x0000000000000000".into(),
                    graphemes: GraphemeRunWire::Blank(BlankTag::Blank),
                    hyperlink_id: 0,
                    ext: None,
                }],
                continuation: false,
                hyperlink_refs: vec![],
            }],
            cursor: Some(CursorStateWire::default()),
            mode_state: TerminalModeStateWire::default(),
            meta: GridMetaWire::default(),
        };
        let j = serde_json::to_string(&p).unwrap();
        let back: GridSnapshotPayload = serde_json::from_str(&j).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn grapheme_run_blank_serializes_as_string() {
        let g = GraphemeRunWire::Blank(BlankTag::Blank);
        let j = serde_json::to_string(&g).unwrap();
        assert_eq!(j, "\"blank\"");
        let back: GraphemeRunWire = serde_json::from_str(&j).unwrap();
        assert_eq!(back, g);
    }

    #[test]
    fn grapheme_run_inline_utf8_string() {
        let g = GraphemeRunWire::Inline {
            utf8: Utf8Run::Str("abc".into()),
        };
        let j = serde_json::to_string(&g).unwrap();
        assert!(j.contains("\"utf8\":\"abc\""));
        let back: GraphemeRunWire = serde_json::from_str(&j).unwrap();
        assert_eq!(back, g);
    }

    #[test]
    fn grapheme_run_inline_bytes_array() {
        let g = GraphemeRunWire::Inline {
            utf8: Utf8Run::Bytes(vec![237, 149, 156]),
        };
        let j = serde_json::to_string(&g).unwrap();
        let back: GraphemeRunWire = serde_json::from_str(&j).unwrap();
        assert_eq!(back, g);
    }

    #[test]
    fn mode_change_wire_round_trip() {
        let m = ModeChangeWire::AltScreen { value: true };
        let j = serde_json::to_string(&m).unwrap();
        assert!(j.contains("\"mode\":\"alt_screen\""));
        let back: ModeChangeWire = serde_json::from_str(&j).unwrap();
        assert_eq!(m, back);
    }

    #[test]
    fn unknown_mode_change_variant_errors() {
        let j = r#"{"mode":"teleport","value":true}"#;
        let r: Result<ModeChangeWire, _> = serde_json::from_str(j);
        assert!(r.is_err(), "unknown mode variant must error, not drop");
    }

    #[test]
    fn clipboard_op_tagged_round_trip() {
        let o = ClipboardOpWire::Set {
            base64_data: "SGVsbG8=".into(),
        };
        let j = serde_json::to_string(&o).unwrap();
        assert!(j.contains("\"op\":\"set\""));
        let back: ClipboardOpWire = serde_json::from_str(&j).unwrap();
        assert_eq!(o, back);
    }

    #[test]
    fn sync_phase_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&SyncPhaseWire::Begin).unwrap(),
            "\"begin\""
        );
        assert_eq!(
            serde_json::to_string(&SyncPhaseWire::End).unwrap(),
            "\"end\""
        );
    }

    #[test]
    fn grid_delta_default_is_empty() {
        let d = GridDeltaPayload::default();
        assert!(d.row_deltas.is_empty());
        assert!(d.scrolls.is_empty());
        assert_eq!(d.scrollback_appended, 0);
    }
}
