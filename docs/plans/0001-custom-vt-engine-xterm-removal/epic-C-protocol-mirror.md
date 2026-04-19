# EPIC-C Design — Protocol + Reducer + UI Mirror

- **Status**: Design-ahead (Gear 3). Freezes contracts for EPIC-D (renderer) and EPIC-F (session wiring).
- **Date**: 2026-04-19
- **Related**: RFC 0001 §2 (invariants I-2, I-3, I-5, I-9), §3.2 (protocol truth), §9 (reducer ordering), §13.5-7 (input/IME/delta), §13.11 (side-by-side), ADR 0017 (reducer ordering + mode authority), RFC 0001 Epic Plan — EPIC-C.
- **Blocks**: EPIC-D spec can only ship once this freezes.

One-paragraph read: the engine (EPIC-B) emits a stream of ordered events. This document specifies the wire shape of those events, the run-length span encoding used inside `GridDelta`, the client-side `GridMirror` that applies them, the `ResyncRow` recovery protocol, the resume contract, and the golden JSON fixtures. Everything here is "design-for-freeze"; implementation (EPIC-C-impl) pins to the shapes below without deviation.

---

## 1. Wire protocol payloads

All envelope fields come from ADR 0017 §1 and live in `crates/quanta-proto/src/envelope.rs`. Payload variants live in `crates/quanta-proto/src/events.rs`. Serialization is MessagePack for the wire and JSON for the golden fixtures. Every payload derives at minimum `Debug, Clone, PartialEq, Serialize, Deserialize`. Fields added after freeze MUST be `#[serde(default)]`.

### 1.1 Common envelope (already drafted in ADR 0017)

```rust
/// Wire envelope wrapping every engine-emitted event. ADR 0017 §1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventEnvelope<P> {
    /// Stable session identifier. Never reused.
    pub session_id: SessionId,
    /// Bumps on reconnect, full reseed, buffer init. UI discards deltas with
    /// an older epoch than the currently applied one.
    pub grid_epoch: u64,
    /// Strictly ascending within an epoch. Gaps are a protocol error
    /// (telemetry-counted), contiguity is NOT assumed by the mirror — the
    /// mirror only requires monotonic-increasing.
    pub sequence_no: u64,
    /// Main vs Alt. Used by UI chrome; not used for reducer ordering decisions.
    pub buffer_kind: BufferKind,
    /// Increments on every resize that alters wrap/reflow geometry. Deltas with
    /// older resize_generation than applied are DISCARDED.
    pub resize_generation: u64,
    /// The payload variant (GridSnapshot, GridDelta, CursorMoved, ...).
    pub payload: P,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BufferKind { Main, Alt }
```

Envelope MessagePack size: `session_id (16B UUID) + 4×u64 (32B) + 1B tag + payload`. Budget ~55 B headers before payload.

### 1.2 `GridSnapshot`

Full grid state. Emitted on: initial subscribe, epoch change, resize, divergence-resync, host restart.

```rust
/// Full grid state. Drops all prior mirror state when applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GridSnapshot {
    /// Total rows in the grid (including scrollback-anchor row on main).
    pub rows: u32,
    /// Total columns.
    pub cols: u32,
    /// Row contents, indexed 0..rows. Each RowDelta carries revision_after
    /// and spans covering every column of that row.
    pub row_deltas: Vec<RowDelta>,
    /// Cursor at snapshot time (may be absent if invisible).
    pub cursor: Option<CursorState>,
    /// Mode state at snapshot time. ADR 0017 §4.
    pub mode_state: TerminalModeStateWire,
    /// Opaque ancillary metadata (title, cwd, active hyperlink table digest).
    /// Additive — MUST be serde(default).
    #[serde(default)]
    pub meta: GridMeta,
}
```

Size budget: for 120×40 grid with typical steady content, MessagePack ≈ 28–48 KB worst-case (every cell unique truecolor). Snapshots are rare; budget is not tight.

Evolution: `meta: GridMeta` is the extensibility bucket. New snapshot-level fields go inside `GridMeta`, never at `GridSnapshot` top level, so old clients ignore them cleanly.

### 1.3 `GridDelta`

Incremental row-level update. Steady-state event.

```rust
/// Steady-state row-level delta. Carries the rows whose content changed
/// since the last applied event. Scroll regions are rectangles (see
/// ScrollDelta below) separately from row content changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GridDelta {
    /// Row deltas ordered by row ascending. Each entry MUST pass the
    /// revision_before check against the mirror's row_revisions[row].
    pub rows: Vec<RowDelta>,
    /// Rectangular scroll operations applied BEFORE the row deltas above.
    /// Empty in the common typing case; populated for TUI scroll regions.
    #[serde(default)]
    pub scrolls: Vec<ScrollDelta>,
}

/// Rectangular scroll — applied to a row range within a column range.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScrollDelta {
    /// Inclusive top row.
    pub top: u32,
    /// Inclusive bottom row.
    pub bottom: u32,
    /// Positive = scroll up (rows move toward top), negative = scroll down.
    pub lines: i32,
    /// Column range, defaults to full width.
    #[serde(default)]
    pub left: u32,
    #[serde(default)]
    pub right: Option<u32>,
}

/// A single row's replacement content. See §2 for span encoding details.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RowDelta {
    /// Row index.
    pub row: u32,
    /// Mirror's expected row_revisions[row] before applying. If this fails
    /// the mirror MUST request ResyncRow for this row.
    pub revision_before: u32,
    /// Row's new revision after applying. Monotonic; wraps at u32::MAX
    /// (sessions won't live that long, but callers MUST tolerate wrap).
    pub revision_after: u32,
    /// Spans covering the row, left to right, contiguous, with no gaps.
    pub spans: Vec<CellSpan>,
    /// Line continuation flag (soft-wrap). If true, this row visually
    /// continues from row-1 without a hard newline.
    #[serde(default)]
    pub continuation: bool,
    /// Hyperlink table fragment referenced by any span in this row's
    /// hyperlink_id. Empty when no span references a long link.
    #[serde(default)]
    pub hyperlink_refs: Vec<HyperlinkRef>,
}
```

Size: typical shell-output delta is 1–3 rows × 2–6 spans × ~20 B/span ≈ 80–400 B. Worst-case full-row rewrite in 120-col alt-screen ≈ 1–4 KB. Target steady-state budget (RFC §13.12): ≤ 200 KB/s on `cargo build`.

Evolution: `continuation`, `hyperlink_refs` are already `serde(default)`. New row-level flags go here as optional. New scroll-region shapes go as additional `ScrollDelta` fields (not new variants — variants are breaking).

### 1.4 `CursorMoved`

```rust
/// Cursor-only event. Decoupled from GridDelta so blink / idle-move
/// doesn't trigger row-dirty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorMoved {
    pub cursor: CursorState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorState {
    pub row: u32,
    pub col: u32,
    /// If false, cursor is logically invisible (DECSET 25 off).
    pub visible: bool,
    pub shape: CursorShape,
    /// Blink enable; renderer owns timing.
    pub blinking: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorShape { Block, Underline, Bar }
```

Size: ≈ 15 B. Most-frequent event; budget-critical. Evolution: new fields on `CursorState` only as `serde(default)` wrappers if introduced.

### 1.5 `ModeChanged`

Single mode flip. Multiple flips collapse into a batch only if emitted in one `ModeChanged` event (engine decides).

```rust
/// One or more mode-state transitions. Batched to reduce envelope overhead
/// when several modes flip simultaneously (e.g., DECSET 1049 flips
/// alt-screen, mouse, cursor-save together).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModeChanged {
    pub changes: Vec<ModeChange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ModeChange {
    Decckm(bool),
    BracketedPaste(bool),
    FocusReporting(bool),
    MouseTracking(MouseTrackingMode),
    MouseEncoding(MouseEncoding),
    ModifyOtherKeys(u8),     // 0 / 1 / 2
    KittyKeyboard(u8),       // level 0..5
    AltScreen(bool),
    SynchronizedUpdate(bool),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseTrackingMode { Off, X10, ButtonEvent, AnyEvent }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseEncoding { Default, Utf8, Sgr, UrlXterm }
```

Size: 3–20 B per change × batch length. Evolution: add new `ModeChange` variant (this is a breaking change; old clients get deserialize-failure → engine MUST gate behind epoch bump).

**DECISION**: `ModeChange` uses internally-tagged enum variants so future additions are visible to old clients as "unknown variant" and can be error-logged. **ESCAPE**: if a third-party program introduces a mode the engine learns after v1, we bump `grid_epoch` on negotiation and reseed.

### 1.6 `TitleChanged`

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TitleChanged {
    pub title: String,
    pub scope: TitleScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleScope { Window, Icon, Both }
```

Size: ~title length + 10 B.

### 1.7 `BellRequested`

```rust
/// Bell (BEL / DECSET 1042). UI decides visual/audio policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BellRequested {
    pub kind: BellKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BellKind { Audible, Visual, UrgencyHint }
```

Size: 3 B.

### 1.8 `HyperlinkAdded` / `HyperlinkRemoved`

OSC 8 hyperlinks are addressed by id inside spans (see §2). When a long hyperlink target is first referenced, the engine emits `HyperlinkAdded`. When the reference count drops to zero (scrollback eviction), `HyperlinkRemoved` is emitted so the mirror can drop the entry.

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HyperlinkAdded {
    /// Stable id within session+epoch. Referenced from CellSpan.hyperlink_id.
    pub id: u32,
    /// Target URL (OSC 8 `uri` payload).
    pub uri: String,
    /// Optional OSC 8 `params` (e.g., `id=foo`).
    #[serde(default)]
    pub params: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HyperlinkRemoved {
    pub id: u32,
}
```

Size: ~uri length + 8 B. Rare.

### 1.9 `ClipboardRequest`

OSC 52 set/get. Policy-gated per ADR 0016. The engine only relays; UI decides allow/deny.

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClipboardRequest {
    pub selection: ClipboardSelection,
    pub op: ClipboardOp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardSelection { Clipboard, Primary, Secondary, Select }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ClipboardOp {
    Set { base64_data: String },
    Query,
}
```

Size: ~data length + 20 B.

### 1.10 `SynchronizedUpdate`

DECSET 2026 begin/end. UI defers repaint until `End` arrives.

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SynchronizedUpdate {
    pub phase: SyncPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncPhase { Begin, End }
```

Size: 3 B.

### 1.11 Umbrella `TerminalEventPayload`

Bound to wire by the envelope. Tag layout:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TerminalEventPayload {
    GridSnapshot(GridSnapshot),
    GridDelta(GridDelta),
    CursorMoved(CursorMoved),
    ModeChanged(ModeChanged),
    TitleChanged(TitleChanged),
    BellRequested(BellRequested),
    HyperlinkAdded(HyperlinkAdded),
    HyperlinkRemoved(HyperlinkRemoved),
    ClipboardRequest(ClipboardRequest),
    SynchronizedUpdate(SynchronizedUpdate),
}
```

**DECISION**: internally-tagged (`"kind"`) so unknown variants produce a clean parse error on old clients; that error is the signal for the engine to renegotiate or bump epoch. **ESCAPE**: if the unknown-variant error rate spikes in telemetry, we fall back to untagged with explicit version header.

---

## 2. GridDelta span encoding

Spans cover a row left-to-right contiguously. Each span holds `cols` of identical SGR/grapheme-repeat content when repeat-compressible, else a single grapheme with width metadata.

```rust
/// A run of cells sharing SGR attrs, emitted left-to-right, no gaps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CellSpan {
    /// Number of columns this span occupies (run length). Accounts for
    /// wide-char halves (one wide char = 2 cols but 1 grapheme).
    pub cols: u16,
    /// Packed SGR state: 8 attrs + 24 fg + 24 bg + 8 reserved. See §2.3.
    pub sgr: u64,
    /// Grapheme clusters in order. A single grapheme may be visually
    /// wide (cols == 2) or zero-width (cols == 0). Row repainters common
    /// case is `cols == N, graphemes == [SPACE]` meaning "N blanks".
    pub graphemes: GraphemeRun,
    /// Optional hyperlink id (OSC 8). 0 means "no link".
    #[serde(default)]
    pub hyperlink_id: u32,
}
```

### 2.1 Grapheme run encoding

Two representations, compactness-driven. Most terminals see short ASCII runs; we inline those. Korean/emoji runs escape to a byte blob.

```rust
/// Inline up to 8 bytes UTF-8 (short ASCII spans, a single emoji cluster).
/// Longer runs escape to `Bytes`, which is serialized as base64 over the
/// wire to stay printable in golden JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum GraphemeRun {
    /// Empty run (span is pure blanks with SGR applied; graphemes = space
    /// inferred). `cols` alone defines the width.
    Blank,
    /// Inline UTF-8, up to 8 bytes.
    Inline { utf8: SmallUtf8 },
    /// Longer payload.
    Bytes { utf8: Vec<u8> },
    /// Repeat of a single grapheme for N codepoints. Keyed by grapheme
    /// string + count. For CJK walls like "---" or "  " with SGR.
    Repeat { grapheme: String, count: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SmallUtf8(pub heapless::String<8>);
```

Wire JSON for common cases:
- Blank: `{"cols": 40, "sgr": "0x...", "graphemes": null}` (serde `Option` sentinel) — actually emitted as `"blank"` tag via `serde(untagged)` fallback.
- Inline: `{"cols": 3, ..., "graphemes": {"utf8": "abc"}}`.
- Bytes (Korean 3 cells): `{"cols": 2, ..., "graphemes": {"utf8": [237,149,156]}}` — `"한"`.
- Repeat: `{"cols": 40, ..., "graphemes": {"grapheme":"─","count":40}}`.

**DECISION — inline 8-byte threshold**: a single ZWJ emoji family (`👨‍👩‍👧‍👦`) is 25 UTF-8 bytes → escapes to `Bytes`. A single Korean jamo or hanja is ≤ 3 B → inline. A Greek acute (`é` as e+U+0301) is 3 B → inline. 8 B covers 95% of single-grapheme cases without forcing the `Bytes` path. **ESCAPE**: if profiling shows `Bytes` dominates (>20% of cells), raise threshold to 16 B.

### 2.2 Hyperlink id vs inline

Hyperlinks (OSC 8) can be long URIs. We never inline the URI in a span. Instead:
- `CellSpan.hyperlink_id: u32` is an opaque id.
- The URI table is propagated via `HyperlinkAdded { id, uri, params }` as a separate payload.
- `RowDelta.hyperlink_refs` is a guaranteed-available set of ids touched by spans in that row; the mirror uses it to verify the URI table is resolved.

**DECISION**: ids are session+epoch scoped (reset on epoch bump). **ESCAPE**: if cross-epoch hyperlink resume matters, add epoch-qualified ids in v2.

### 2.3 SGR packed into u64

Bit layout (MSB-first):

| Bits  | Width | Field             | Notes                                                       |
|-------|-------|-------------------|-------------------------------------------------------------|
| 63..56| 8     | `attrs`           | Bitflags: bold, italic, underline, blink, inverse, strike, faint, dim_underline |
| 55..32| 24    | `fg`              | `0xAARRGGBB` truncated to `0xRRGGBB`; high bit of `fg_meta` below discriminates palette vs truecolor |
| 31..8 | 24    | `bg`              | same shape as `fg`                                          |
| 7..4  | 4     | `fg_kind`         | 0=default, 1=palette8, 2=palette256, 3=truecolor            |
| 3..0  | 4     | `bg_kind`         | same                                                        |

Full attr bit meanings (bits 63..56 MSB→LSB):

| Bit | Name          |
|-----|---------------|
| 7   | bold          |
| 6   | italic        |
| 5   | underline     |
| 4   | blink         |
| 3   | inverse       |
| 2   | strike        |
| 1   | faint         |
| 0   | double-under  |

**DECISION**: 8 reserved attrs bits cover current SGR states including double-underline; underline-color (3-byte RGB) does NOT fit in the u64, so it lives in an extension map (§2.4). **ESCAPE**: if we encounter terminals that need nonstandard attrs (e.g., overline), we move to `u128` or promote to a struct; the wire format flips via epoch bump.

JSON representation is a hex string for readability: `"sgr": "0x8001FF0000FFFFFF33"` (example).

### 2.4 Attr extension map (rare-path)

For truecolor underline and future attrs that don't fit the u64:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpanAttrsExt {
    #[serde(default)]
    pub underline_color: Option<u32>, // 0xRRGGBB
    // future: font slot, weight bucket, etc.
}
```

`CellSpan` gains `#[serde(default)] pub ext: Option<SpanAttrsExt>`. Old clients ignore `ext`; new clients interpret.

### 2.5 Full-row vs span threshold

The engine emits `RowDelta` covering the whole row whenever any span changed; spans not changed are repeated verbatim. There is NO "sparse span" format — a row is always a complete list of contiguous spans summing to `cols`.

**DECISION — row-level always-full**: complexity of sparse spans (gap-fill semantics, mirror diff reconciliation) outweighs the bandwidth save. Row-level always-full means the mirror never has to know the old row to apply a new row, which simplifies `revision_before`/`revision_after` semantics. **ESCAPE**: if `cargo build` steady-state bandwidth exceeds the 200 KB/s budget and row-full is the cause, switch to sparse spans in v2 with a new `GridDelta2` variant.

### 2.6 Wire-shape example of `RowDelta`

```json
{
  "row": 7,
  "revision_before": 42,
  "revision_after": 43,
  "continuation": false,
  "spans": [
    {
      "cols": 2,
      "sgr": "0x0000000000000033",
      "graphemes": { "utf8": [237,149,156] }
    },
    {
      "cols": 1,
      "sgr": "0x0000000000000033",
      "graphemes": { "utf8": " " }
    },
    {
      "cols": 117,
      "sgr": "0x0000000000000000",
      "graphemes": "blank"
    }
  ],
  "hyperlink_refs": []
}
```

---

## 3. Golden JSON templates

All templates committed under `crates/quanta-proto/tests/fixtures/schemas/grid_*.golden.json`. Each template is one example of the envelope carrying one payload variant. The test `tests/grid_schema_snapshots.rs` asserts serialize-roundtrip-equal against these strings.

### 3.1 `grid_snapshot.golden.json`

```json
{
  "session_id": "00000000-0000-4000-8000-000000000001",
  "grid_epoch": 1,
  "sequence_no": 0,
  "buffer_kind": "main",
  "resize_generation": 0,
  "payload": {
    "kind": "grid_snapshot",
    "rows": 2,
    "cols": 4,
    "row_deltas": [
      {
        "row": 0,
        "revision_before": 0,
        "revision_after": 1,
        "continuation": false,
        "spans": [
          { "cols": 4, "sgr": "0x0000000000000000", "graphemes": "blank" }
        ],
        "hyperlink_refs": []
      },
      {
        "row": 1,
        "revision_before": 0,
        "revision_after": 1,
        "continuation": false,
        "spans": [
          { "cols": 4, "sgr": "0x0000000000000000", "graphemes": "blank" }
        ],
        "hyperlink_refs": []
      }
    ],
    "cursor": { "row": 0, "col": 0, "visible": true, "shape": "block", "blinking": true },
    "mode_state": {
      "decckm": false, "bracketed_paste": false, "focus_reporting": false,
      "mouse_tracking": "off", "mouse_encoding": "default",
      "modify_other_keys": 0, "kitty_keyboard": 0,
      "alt_screen": false, "synchronized_update": false
    },
    "meta": { "title": null, "cwd": null, "hyperlink_digest": null }
  }
}
```

### 3.2 `grid_delta_korean_emoji.golden.json`

Row with a Korean ZWJ sequence + family emoji + truecolor SGR.

```json
{
  "session_id": "00000000-0000-4000-8000-000000000001",
  "grid_epoch": 1,
  "sequence_no": 42,
  "buffer_kind": "main",
  "resize_generation": 0,
  "payload": {
    "kind": "grid_delta",
    "scrolls": [],
    "rows": [
      {
        "row": 10,
        "revision_before": 17,
        "revision_after": 18,
        "continuation": false,
        "spans": [
          {
            "cols": 2,
            "sgr": "0x018000FF00FF000033",
            "graphemes": { "utf8": [237,149,156] }
          },
          {
            "cols": 2,
            "sgr": "0x018000FF00FF000033",
            "graphemes": { "utf8": [234,184,128] }
          },
          {
            "cols": 1,
            "sgr": "0x0000000000000000",
            "graphemes": { "utf8": " " }
          },
          {
            "cols": 2,
            "sgr": "0x0000000000000000",
            "graphemes": {
              "utf8": [240,159,145,168,226,128,141,240,159,145,169,226,128,141,240,159,145,167,226,128,141,240,159,145,166]
            }
          },
          {
            "cols": 113,
            "sgr": "0x0000000000000000",
            "graphemes": "blank"
          }
        ],
        "hyperlink_refs": []
      }
    ]
  }
}
```

Here the SGR `0x018000FF00FF000033` breaks down as: attrs=`0x01` (bold), fg=`0x00FF00` (green truecolor), bg=`0xFF0000` (red truecolor), fg_kind=3, bg_kind=3. `"한"` = 3 UTF-8 bytes `ed 95 9c`. `"글"` = 3 bytes `ea b8 80`. Family emoji = 25 B.

### 3.3 `grid_delta_scroll_region.golden.json`

```json
{
  "session_id": "00000000-0000-4000-8000-000000000001",
  "grid_epoch": 1,
  "sequence_no": 100,
  "buffer_kind": "alt",
  "resize_generation": 0,
  "payload": {
    "kind": "grid_delta",
    "scrolls": [
      { "top": 0, "bottom": 23, "lines": 1, "left": 0, "right": null }
    ],
    "rows": [
      {
        "row": 23,
        "revision_before": 200,
        "revision_after": 201,
        "continuation": false,
        "spans": [
          { "cols": 80, "sgr": "0x0000000000000000", "graphemes": "blank" }
        ],
        "hyperlink_refs": []
      }
    ]
  }
}
```

### 3.4 `cursor_moved_alt_boundary.golden.json`

Cursor moved across alt-screen boundary — note the preceding `ModeChanged(alt_screen=true)` must be in the stream, then this `CursorMoved` applies in the alt buffer.

```json
{
  "session_id": "00000000-0000-4000-8000-000000000001",
  "grid_epoch": 1,
  "sequence_no": 55,
  "buffer_kind": "alt",
  "resize_generation": 0,
  "payload": {
    "kind": "cursor_moved",
    "cursor": { "row": 0, "col": 0, "visible": true, "shape": "block", "blinking": false }
  }
}
```

### 3.5 `mode_changed_alt_enter.golden.json`

DECSET 1049 batch: alt-screen on, mouse tracking on, cursor-save happens engine-side.

```json
{
  "session_id": "00000000-0000-4000-8000-000000000001",
  "grid_epoch": 1,
  "sequence_no": 54,
  "buffer_kind": "main",
  "resize_generation": 0,
  "payload": {
    "kind": "mode_changed",
    "changes": [
      { "mode": "alt_screen", "value": true },
      { "mode": "mouse_tracking", "value": "button_event" },
      { "mode": "mouse_encoding", "value": "sgr" }
    ]
  }
}
```

Note `buffer_kind` is `"main"` because the envelope reflects the buffer AT EMIT. The engine ordering invariant (ADR 0017 §2) says `ModeChanged(alt_screen=true)` is sequenced BEFORE any alt-buffer cell delta, and the mirror sees `buffer_kind` flip on the next event.

### 3.6 `title_changed.golden.json`

```json
{
  "session_id": "00000000-0000-4000-8000-000000000001",
  "grid_epoch": 1,
  "sequence_no": 12,
  "buffer_kind": "main",
  "resize_generation": 0,
  "payload": {
    "kind": "title_changed",
    "title": "user@host: ~/projects/quanta-terminal",
    "scope": "both"
  }
}
```

### 3.7 `bell_requested.golden.json`

```json
{
  "session_id": "00000000-0000-4000-8000-000000000001",
  "grid_epoch": 1,
  "sequence_no": 88,
  "buffer_kind": "main",
  "resize_generation": 0,
  "payload": { "kind": "bell_requested", "kind_of_bell": "audible" }
}
```

(Note: inner field name is `kind_of_bell` so it doesn't collide with the tag field.)

### 3.8 `hyperlink_added.golden.json`

```json
{
  "session_id": "00000000-0000-4000-8000-000000000001",
  "grid_epoch": 1,
  "sequence_no": 120,
  "buffer_kind": "main",
  "resize_generation": 0,
  "payload": {
    "kind": "hyperlink_added",
    "id": 1,
    "uri": "https://example.com/very/long/path?q=1",
    "params": "id=ln1"
  }
}
```

### 3.9 `hyperlink_removed.golden.json`

```json
{
  "session_id": "00000000-0000-4000-8000-000000000001",
  "grid_epoch": 1,
  "sequence_no": 9001,
  "buffer_kind": "main",
  "resize_generation": 0,
  "payload": { "kind": "hyperlink_removed", "id": 1 }
}
```

### 3.10 `clipboard_request.golden.json`

```json
{
  "session_id": "00000000-0000-4000-8000-000000000001",
  "grid_epoch": 1,
  "sequence_no": 33,
  "buffer_kind": "main",
  "resize_generation": 0,
  "payload": {
    "kind": "clipboard_request",
    "selection": "clipboard",
    "op": { "op": "set", "base64_data": "SGVsbG8sIHdvcmxkIQ==" }
  }
}
```

### 3.11 `synchronized_update_begin.golden.json`

```json
{
  "session_id": "00000000-0000-4000-8000-000000000001",
  "grid_epoch": 1,
  "sequence_no": 500,
  "buffer_kind": "alt",
  "resize_generation": 0,
  "payload": { "kind": "synchronized_update", "phase": "begin" }
}
```

(11 templates; the "9+" bar is met.)

---

## 4. GridMirror architecture (UI side)

Lives under `packages/ui/src/shared/lib/grid-mirror/`. File layout:

| File                                         | Purpose                                                                                         |
|----------------------------------------------|-------------------------------------------------------------------------------------------------|
| `GridMirror.ts`                              | Main class. `applySnapshot`, `applyDelta`, `applyCursor`, `applyMode`, `applyMeta`, getters.    |
| `Row.ts`                                     | `Row` type + span→cell expansion helper (used by renderer as read-only view).                   |
| `Cursor.ts`                                  | `Cursor` reducer state + visibility/shape/blink getters.                                        |
| `ModeMirror.ts`                              | Mirror of `TerminalModeState`; read by `ModeSnapshot.ts` (EPIC-E) via shallow clone.            |
| `Meta.ts`                                    | Title, cwd, hyperlink table.                                                                    |
| `Hyperlinks.ts`                              | `HyperlinkTable` — id → URI; refcount via `HyperlinkAdded` / `HyperlinkRemoved`.                |
| `EnvelopeGate.ts`                            | Epoch + sequence + resize-generation gating. Pure function; returns `Apply \| Discard \| Resync`.|
| `ResyncStrategy.ts`                          | Tracks row-mismatch rate; emits `ResyncRow` or escalates to `GridSnapshot` request.             |
| `types.ts`                                   | Shared wire types (mirrors `quanta-proto`).                                                     |
| `__tests__/ordering.test.ts`                 | Stale-epoch, sequence gap, resize-generation tests.                                             |
| `__tests__/resync.test.ts`                   | Row-mismatch → ResyncRow, threshold-escalation to snapshot.                                     |
| `__tests__/apply_delta.test.ts`              | Various span patterns.                                                                          |
| `__tests__/cursor.test.ts`                   | Cursor apply.                                                                                    |
| `__tests__/mode.test.ts`                     | Mode apply + snapshot semantics.                                                                 |
| `__tests__/fault_injection.test.ts`          | Drop-every-Nth-delta, assert resync + final-state-matches-full-replay.                          |

### 4.1 Class API

```ts
export interface GridMirrorOptions {
  /** Emitted when a RowDelta's revision_before mismatches local state. */
  onResyncRowRequested: (req: ResyncRowRequest) => void;
  /** Emitted when resync mismatches exceed K within W seconds. */
  onSnapshotResyncRequested: (req: SnapshotRequest) => void;
  /** Telemetry sink. Counters emitted: stale_epoch_drop, sequence_gap_drop,
   *  resize_generation_drop, revision_mismatch, snapshot_fallback. */
  telemetry: MirrorTelemetry;
  /** Storm threshold. Default: K=5 mismatches within W=10s → snapshot fallback. */
  stormThreshold?: { k: number; windowMs: number };
}

export class GridMirror {
  constructor(opts: GridMirrorOptions);

  applySnapshot(env: EventEnvelope<GridSnapshot>): ApplyResult;
  applyDelta(env: EventEnvelope<GridDelta>): ApplyResult;
  applyCursor(env: EventEnvelope<CursorMoved>): ApplyResult;
  applyMode(env: EventEnvelope<ModeChanged>): ApplyResult;
  applyMeta(env: EventEnvelope<TitleChanged | HyperlinkAdded | HyperlinkRemoved>): ApplyResult;

  /** Catch-all. Dispatches by payload.kind; used by the bridge layer. */
  apply(env: EventEnvelope<TerminalEventPayload>): ApplyResult;

  getRow(row: number): Row | undefined;
  getCursor(): Readonly<Cursor>;
  getMode(): Readonly<TerminalModeState>;
  /** Used by EPIC-E ModeSnapshot; returns a deep-frozen shallow clone. */
  snapshotMode(): Readonly<TerminalModeState>;
  getMeta(): Readonly<GridMeta>;
  getDimensions(): { rows: number; cols: number };
  /**
   * Accessor for the latest applied `sequence_no` within the current epoch.
   * Consumed by EPIC-E `ModeSnapshot` to stamp `EncoderOutput.diagnostics.snapshotEpoch`
   * so encoded bytes are traceable back to the exact reducer state that
   * produced them. Returns 0n before any delta has been applied.
   */
  getAppliedSequence(): bigint;
  /** Complementary accessor for the current grid_epoch. */
  getAppliedEpoch(): bigint;
}

export type ApplyResult =
  | { outcome: "applied" }
  | { outcome: "discarded"; reason: DiscardReason }
  | { outcome: "resync_requested"; row?: number }
  | { outcome: "snapshot_requested" };

export type DiscardReason =
  | "stale_epoch"
  | "stale_resize_generation"
  | "stale_sequence"
  | "unknown_variant";
```

### 4.2 Internal state

```ts
interface GridMirrorState {
  epoch: bigint;               // latest applied grid_epoch
  appliedSequence: bigint;     // latest applied sequence_no within epoch
  resizeGeneration: bigint;    // latest applied resize_generation
  rows: Row[];                 // indexed 0..rowCount
  rowRevisions: Uint32Array;   // rowRevisions[row] == row_revisions in RFC §13.7
  cursor: Cursor;              // not frozen — internal; externally exposed via getter
  mode: TerminalModeState;     // ADR 0017 §4 snapshot mirror
  meta: GridMeta;
  hyperlinks: HyperlinkTable;
  rowCount: number;
  colCount: number;
  /** Sliding window of recent mismatch timestamps for storm detection. */
  mismatchLog: number[];
}
```

### 4.3 Apply algorithm

Every incoming envelope runs through `EnvelopeGate.decide(env, state)`:

```
fn decide(env, state) -> Decision:
  1. If env.grid_epoch < state.epoch:
       telemetry.stale_epoch_drop += 1
       return Discard("stale_epoch")
  2. If env.grid_epoch > state.epoch:
       (epoch advanced — only GridSnapshot is accepted; anything else is discarded
        until a snapshot reseeds the mirror)
       if payload.kind != "grid_snapshot":
         return Discard("stale_epoch")
       else:
         return Accept(Reseed)
  3. Same epoch: check sequence_no
     if env.sequence_no <= state.appliedSequence AND payload.kind != "grid_snapshot":
       telemetry.sequence_gap_drop += 1
       return Discard("stale_sequence")
  4. If payload.kind == "grid_delta" AND env.resize_generation < state.resizeGeneration:
       telemetry.resize_generation_drop += 1
       return Discard("stale_resize_generation")
  5. Accept
```

For `grid_delta`: for each `RowDelta`:
```
if rowDelta.revision_before != state.rowRevisions[rowDelta.row]:
  telemetry.revision_mismatch += 1
  state.mismatchLog.push(now())
  trim mismatchLog to last windowMs
  if mismatchLog.length >= k:
    emit SnapshotRequest(session_id, current epoch)
    return ResyncRequested  // whole mirror waits for fresh snapshot
  else:
    emit ResyncRowRequest { session_id, grid_epoch, resize_generation, row }
    // continue applying OTHER rows in this delta; the mirror tolerates
    // per-row resync requests overlapping with continued application
else:
  state.rows[rowDelta.row] = expandSpans(rowDelta.spans)
  state.rowRevisions[rowDelta.row] = rowDelta.revision_after

state.appliedSequence = max(state.appliedSequence, env.sequence_no)
```

**DECISION — apply-rest-on-mismatch**: when one row mismatches we keep applying the remaining rows in the same `GridDelta`, so partial visual staleness is minimized. **ESCAPE**: if this produces visible tearing, switch to all-or-nothing per-delta (discard whole delta on first mismatch) and always ask for a full ResyncRow batch.

For `cursor_moved`, `mode_changed`, `title_changed`, `bell_requested`, `hyperlink_added/removed`, `clipboard_request`, `synchronized_update`: apply directly after envelope gate.

For `grid_snapshot`: reseed state wholesale, set `epoch = env.grid_epoch`, `resizeGeneration = env.resize_generation`, `appliedSequence = env.sequence_no`, clear `mismatchLog`.

### 4.4 Resync policy

- Per-row: up to `k-1` row-level `ResyncRowRequest`s within `windowMs` are allowed, each resolved by a scoped `GridSnapshot` response (see §5).
- On the k-th mismatch: mirror emits `SnapshotRequest { session_id, epoch, reason: "row_mismatch_storm" }`. Until the snapshot arrives, the mirror is in `awaiting_snapshot` mode where every delta is discarded with telemetry bump.

**DECISION — K=5, W=10s**: matches ADR 0017 telemetry "storm = >3/min" threshold with a tighter per-window cutoff for per-session response. **ESCAPE**: tune on dogfood; K/W are parameters in `GridMirrorOptions`.

### 4.5 Synchronized update handling

When `SynchronizedUpdate { phase: Begin }` arrives, the mirror enters `synced` mode. Deltas are applied to internal state as normal, but the mirror's `onChange` observer (used by the renderer, EPIC-D) is suppressed. On `End`, observers fire with the accumulated dirty set. If a synchronized window is aborted by epoch change or timeout (`DECSET 2026` reference implementation aborts after 150ms), the mirror fires `onChange` regardless.

---

## 5. ResyncRow protocol

Host-side: `crates/quanta-core/src/adapters/registry.rs` routes `ResyncRowRequest` to the owning session's engine which produces a scoped response.

### 5.1 Request

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResyncRowRequest {
    pub session_id: SessionId,
    pub grid_epoch: u64,
    pub resize_generation: u64,
    pub row: u32,
}
```

Wire message name: `resync_row_request`. Sent UI→host via the same RPC channel used for other control messages.

### 5.2 Response

Two variants:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ResyncRowResponse {
    /// Scoped snapshot — exactly one RowDelta with revision_before = 0 so the
    /// mirror unconditionally accepts it as authoritative.
    Ok {
        grid_epoch: u64,
        resize_generation: u64,
        sequence_no: u64,
        row_delta: RowDelta,
    },
    /// Epoch or generation no longer matches; UI must request full snapshot.
    ReplayFailed {
        reason: ReplayFailedReason,
        current_epoch: u64,
        current_resize_generation: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplayFailedReason {
    EpochChanged,
    ResizeGenerationChanged,
    RowOutOfRange,
    SessionGone,
}
```

Wire message name: `resync_row_response`.

### 5.3 Mirror handling of response

- `Ok`: mirror applies the `RowDelta` as if `revision_before` always matched, updates `rowRevisions[row] = row_delta.revision_after`. Mismatch log entry for this row is removed.
- `ReplayFailed`: mirror emits `SnapshotRequest` immediately.

### 5.4 Host side (engine ownership)

The engine snapshots row `row` at the current state:
- Validates epoch/generation/row-bounds.
- Assembles a `RowDelta` with `revision_before = 0` and `revision_after = current_row_revision`.
- Returns the response.

This is cheap — row snapshot is O(cols) memory copy + span compression; no grid-wide scan.

---

## 6. Resume semantics

### 6.1 Hello message additions

UI→host on reconnect includes a `resume_cursors` map:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloResumeCursor {
    pub session_id: SessionId,
    pub last_applied_epoch: u64,
    pub last_applied_sequence: u64,
    pub last_applied_resize_generation: u64,
}

// Hello.resume_cursors: Vec<HelloResumeCursor>
```

### 6.2 Host decision

Host (in the session actor / fanout) inspects per-session engine state:

```
for cursor in hello.resume_cursors:
  engine = registry.get(cursor.session_id)?
  if engine.current_epoch == cursor.last_applied_epoch
     AND engine.current_resize_generation == cursor.last_applied_resize_generation:
    // Same epoch — stream events after last_applied_sequence.
    emit subscribe_response { mode: "replay_from", from_seq: cursor.last_applied_sequence + 1 }
    stream buffered + live events
  else:
    // Epoch or geometry changed — reseed.
    emit subscribe_response { mode: "reseed" }
    emit GridSnapshot with new epoch
    stream live events
```

### 6.3 UI mirror behavior on resume

- If the host returns `replay_from`: mirror keeps existing state; applies events as they stream.
- If the host returns `reseed`: mirror clears ALL pre-snapshot state (rows, cursor, mode, hyperlinks, meta) before applying the snapshot. This is enforced by `applySnapshot` when `env.grid_epoch != state.epoch`.

### 6.4 Security on resume

Session id in resume_cursors must match a live session the host is authoritative for (per existing session authority contract — not changed by this epic). Unknown session_id → ignored silently with telemetry bump.

---

## 7. Tests enumerated

### 7.1 Rust (`crates/quanta-proto/tests/`)

- **`grid_schema_snapshots.rs`** — load each `grid_*.golden.json` (11 templates in §3), deserialize into `EventEnvelope<TerminalEventPayload>`, serialize back to JSON, assert byte-equal. Catches any `#[serde]` drift.
- **`schema_evolution.rs`** — cases:
  1. Add a new additive field to `GridMeta`; deserialize old JSON (without the field); assert `field == default`.
  2. Serialize new struct with the field; deserialize into old struct (feature-flagged via conditional `cfg(test)` type); assert other fields intact.
  3. Assert `ModeChange::Unknown` path: invalid variant produces a parse error (not silent drop).
- **`msgpack_roundtrip.rs`** — for every golden, `serde_json -> structure -> rmp_serde -> structure -> serde_json` cycle preserves shape.

### 7.2 TypeScript (`packages/ui/src/shared/lib/grid-mirror/__tests__/`)

- **`ordering.test.ts`**
  - stale epoch (`env.grid_epoch < state.epoch`) → discarded.
  - stale sequence (`env.sequence_no <= state.appliedSequence`) → discarded for non-snapshot payloads.
  - stale resize_generation on `grid_delta` → discarded.
  - out-of-order `grid_snapshot` accepted regardless of sequence.

- **`resync.test.ts`**
  - single row revision mismatch → `onResyncRowRequested` fires with correct row.
  - `ResyncRowResponse::Ok` applied; row updated.
  - `ResyncRowResponse::ReplayFailed { reason: "epoch_changed" }` → `onSnapshotResyncRequested` fires.
  - K=5 mismatches within W=10s → `onSnapshotResyncRequested` fires; subsequent deltas discarded until snapshot.
  - K-1 mismatches within W=10s → no snapshot request; next delta's applying succeeds.

- **`apply_delta.test.ts`**
  - blank-span row (full-row clear).
  - inline UTF-8 span (ASCII).
  - repeat grapheme span (`─` × 120).
  - Korean 2-col grapheme span.
  - ZWJ family emoji 2-col span.
  - truecolor fg/bg via SGR u64 unpacking.
  - hyperlink_id span + preceding `HyperlinkAdded` resolves URI.

- **`cursor.test.ts`**
  - CursorMoved applies; getCursor returns new position.
  - invisible cursor flag propagates.
  - shape + blinking flags propagate.

- **`mode.test.ts`**
  - ModeChanged batch applies all changes atomically.
  - getMode reflects updated fields.
  - snapshotMode() returns a deep-frozen deep clone (attempt to mutate throws).
  - alt_screen=true prior to first alt-buffer delta: mode visible BEFORE row deltas applied (ordering).

- **`fault_injection.test.ts`**
  - Generate a 1000-delta stream programmatically. Drop every 10th. Feed into mirror. Assert:
    - Revision mismatches detected at dropped rows.
    - ResyncRowRequests emitted.
    - After simulating ResyncRowResponse::Ok for each, final state matches full-replay without drops.
    - Telemetry counters match expected (100 drops → at most 100 resyncs; storm threshold not hit if K=5, W=10s with well-spaced drops).

- **`synchronized_update.test.ts`**
  - Begin suppresses onChange.
  - End releases accumulated dirty set.
  - Abort-on-epoch-change releases immediately.

- **`schema_parity.test.ts`** (vitest)
  - Feed every Rust golden JSON into TS deserializer; assert shape parity (no unknown keys, all enum variants recognized).

---

## 8. Contract freeze checklist

- [ ] Wire protocol struct shapes (11 types in §1).
- [ ] `CellSpan` column-run encoding format (§2.0).
- [ ] `GraphemeRun` inline vs bytes vs repeat vs blank (§2.1).
- [ ] `SpanAttrsExt` extension map for truecolor underline etc. (§2.4).
- [ ] SGR u64 bit layout (§2.3).
- [ ] `GridMirror.apply(envelope)` API + per-variant methods (§4.1).
- [ ] `EnvelopeGate.decide` algorithm (§4.3).
- [ ] `ResyncRowRequest` / `ResyncRowResponse` shapes (§5).
- [ ] Hello-resume-cursors resume contract (§6).
- [ ] Golden JSON schemas (11 templates in §3; committed under `crates/quanta-proto/tests/fixtures/schemas/`).
- [ ] Telemetry counter names (`stale_epoch_drop`, `sequence_gap_drop`, `resize_generation_drop`, `revision_mismatch`, `snapshot_fallback`) — used by EPIC-J.

---

## 9. Implementation-agent TODOs (deferred)

Items explicitly deferred by this design document; EPIC-C implementation agent must resolve before exit:

1. **Exact MessagePack field-ordering optimization** — serde default gives lexicographic by field name; for hot-path `CellSpan` we may want positional. Benchmark and decide.
2. **`GridMeta.hyperlink_digest`** — concrete hash function choice (xxhash / blake3) and digest width. Decide when EPIC-F wires up scrollback persistence so replay determinism cross-checks.
3. **Storm threshold K/W tuning** — default proposed K=5, W=10s. Re-evaluate after first dogfood telemetry week.
4. **`ScrollDelta.right: Option<u32>`** vs always-present — keep option for now; impl can collapse to always-present if all engine emit paths fill it.
5. **MemoryBackend parity tests** (Epic D scope) — design assumes the `GridMirror` is renderer-agnostic; EPIC-D proves this with the `MemoryBackend` contract.
6. **OSC 8 refcount race** — when hyperlink refcount drops to 0 mid-stream (scrollback eviction) and a new span in the same delta re-references the id, engine MUST emit `HyperlinkAdded` before the referencing `RowDelta`. EPIC-B impl agent confirms.
7. **`ResyncRowResponse` flow control** — if UI emits 100 parallel ResyncRow requests (pathological), host-side must coalesce. Design punts: rely on existing RPC backpressure.
8. **Envelope MessagePack compact form** — ADR 0017 flags potential varint encoding if 25 B/envelope is too heavy. Benchmark before deciding.

---

## 10. Definition of Done (DoD)

Every item below is a binary, testable predicate enforced by CI. Failure of any single item blocks EPIC-C exit.

### 10.1 Wire-format coverage

- **DoD-C-01** — Every payload variant of `TerminalEventPayload` (the 10 `kind` values enumerated in §1.11) has a committed golden JSON under `crates/quanta-proto/tests/fixtures/schemas/grid_*.golden.json`. File count ≥ 10; the 11 templates from §3 satisfy the bar with `synchronized_update_end.golden.json` added for Begin↔End pairing.
- **DoD-C-02** — `crates/quanta-proto/tests/grid_schema_snapshots.rs` loads each golden, deserializes into `EventEnvelope<TerminalEventPayload>`, re-serializes to canonical JSON (sorted keys, stable trailing newline), and asserts **byte-equal** to the committed file. Missing template or wrongly-serialized payload fails the test.
- **DoD-C-03** — `crates/quanta-proto/tests/msgpack_roundtrip.rs` round-trips every golden through `serde_json → struct → rmp_serde → struct → serde_json` and asserts shape parity. Proves JSON goldens are faithful to MessagePack wire.
- **DoD-C-04** — `#[serde(default)]` is present on every additive field of every payload struct: `GridSnapshot.meta`, `GridDelta.scrolls`, `ScrollDelta.left`, `ScrollDelta.right`, `RowDelta.continuation`, `RowDelta.hyperlink_refs`, `CellSpan.hyperlink_id`, `CellSpan.ext`, `HyperlinkAdded.params`. Enforced by `crates/quanta-proto/tests/schema_evolution.rs`.
- **DoD-C-05** — Schema-evolution test: deserializing an **old-shape** JSON (with a field subsequently removed from the golden by temporary `cfg(test)` shadow type) into the **new-shape** struct succeeds with `default` applied to missing additive fields. No `MissingField` error.
- **DoD-C-06** — Schema-evolution test, reverse direction: serializing a **new-shape** struct (with an extra `cfg(test)` additive field) and deserializing into the **old-shape** struct **drops the unknown field** without error. Uses `serde(deny_unknown_fields = false)` — asserted via a dedicated test that constructs a JSON with an extra key and confirms deserialization succeeds.
- **DoD-C-07** — Unknown `ModeChange` variant produces a **typed parse error** (`serde::de::Error::unknown_variant`), NOT a silent drop. Test asserts the exact error kind.

### 10.2 Mirror ordering invariants

- **DoD-C-08** — `GridMirror` applies envelopes strictly in `(grid_epoch, sequence_no)` lexicographic ascending order per session. Verified by `ordering.test.ts`: feed envelopes in reverse order → only the first (highest) applies, rest are discarded.
- **DoD-C-09** — Stale-epoch envelope (`env.grid_epoch < state.epoch`) is **discarded**; telemetry counter `vt.stale_epoch_events_dropped` increments by exactly 1 per drop. Test asserts counter value.
- **DoD-C-10** — Stale-`resize_generation` `GridDelta` (`env.resize_generation < state.resizeGeneration`) is **discarded**; counter `vt.stale_resize_generation_events_dropped` increments. Test asserts counter.
- **DoD-C-11** — Stale-`sequence_no` envelope for non-snapshot payloads (`env.sequence_no <= state.appliedSequence`) is **discarded**; counter `vt.stale_sequence_events_dropped` increments. Test asserts counter.
- **DoD-C-12** — `GridSnapshot` is accepted regardless of `sequence_no` ordering (it is a reseed). Test: apply delta at seq=100, then apply snapshot at seq=50 → snapshot applies and resets `appliedSequence=50`.
- **DoD-C-13** — Epoch-advance: when `env.grid_epoch > state.epoch` and payload is NOT `GridSnapshot`, mirror discards and emits `SnapshotRequest`. Test asserts `onSnapshotResyncRequested` fires.

### 10.3 Row-revision recovery

- **DoD-C-14** — `RowDelta.revision_before` mismatch → mirror emits `ResyncRowRequest` via `onResyncRowRequested` callback with `{ session_id, grid_epoch, resize_generation, row }`; counter `vt.row_revision_mismatches` increments. Test asserts emitted payload + counter.
- **DoD-C-15** — `ResyncRowResponse::Ok` application updates `state.rows[row]` and `state.rowRevisions[row]` to `row_delta.revision_after`; the corresponding mismatch-log entry for that row is removed. Test asserts post-apply row content and revision.
- **DoD-C-16** — `ResyncRowResponse::ReplayFailed` with any `ReplayFailedReason` → mirror immediately emits `SnapshotRequest` via `onSnapshotResyncRequested`; no further deltas applied until snapshot arrives. Test asserts both the escalation and the lockout-state.
- **DoD-C-17** — Apply-rest-on-mismatch: when one `RowDelta` in a `GridDelta` mismatches, remaining non-mismatched `RowDelta`s still apply (per §4.3 decision). Test: delta with 3 rows, row 1 mismatches → rows 0 and 2 apply, row 1 triggers resync.

### 10.4 Snapshot-fallback storm

- **DoD-C-18** — Storm threshold: K=5 row mismatches within a W=10s sliding window trigger a full `SnapshotRequest`; counter `vt.snapshot_fallback_storm_triggered` increments. Test feeds 5 mismatches within 10s and asserts the escalation. Defaults come from `GridMirrorOptions.stormThreshold`.
- **DoD-C-19** — Threshold respects the window: K-1 mismatches spread across > W seconds do NOT trigger a snapshot; the oldest mismatch timestamp ages out of `mismatchLog`. Test spaces mismatches at 3s intervals → no escalation after 4 events.
- **DoD-C-20** — Separate "storm detector" counter: `vt.snapshot_fallback_events_per_minute` gauge tracks rolling rate; ≥ 3/min flags a P1 telemetry signal per ADR 0017 §5.

### 10.5 Mirror public API

- **DoD-C-21** — `GridMirror.getAppliedSequence(): bigint` returns the latest applied `sequence_no` within the current epoch. Before any apply: `0n`. After snapshot at seq=50: `50n`. After applying delta at seq=51: `51n`. Test covers all three states.
- **DoD-C-22** — `GridMirror.getAppliedEpoch(): bigint` returns the current `grid_epoch`. Before any apply: `0n`. After snapshot at epoch=3: `3n`. Test covers both states.
- **DoD-C-23** — `GridMirror.snapshotMode()` returns a **deep-frozen** deep clone of `TerminalModeState`. Test: `Object.isFrozen()` returns `true` at every depth; attempts to mutate throw in strict mode.

### 10.6 Schema parity (host-common ↔ quanta-proto)

- **DoD-C-24** — `packages/host-common/src/__tests__/schema-parity.test.ts` enumerates every `TerminalEventPayload` variant name from the Rust-emitted schema digest fixture (generated by `cargo xtask emit-schema-digest`) and asserts the TS `EventKind` union in `packages/host-common/src/events.ts` has an identical set. Test fails if either side adds/removes without the other.
- **DoD-C-25** — Enum-variant parity extended to: `BufferKind`, `CursorShape`, `TitleScope`, `BellKind`, `ClipboardSelection`, `ClipboardOp::{Set, Query}`, `MouseTrackingMode`, `MouseEncoding`, `SyncPhase`, `ReplayFailedReason`. Test iterates the list; new enums MUST be added to the list when introduced.
- **DoD-C-26** — Field-name parity: for each of the 10 payload structs, every top-level field name appears in the TS zod schema (or interface) under the matching camelCase form (`revision_before → revisionBefore`). Test uses the schema digest + TS type-level introspection via `tsc --emitDeclarationOnly` + AST walk.

### 10.7 Wire-size budgets

- **DoD-C-27** — Wire-size budget: 80×24 `GridSnapshot` (blanks throughout, default SGR, no cursor, empty meta) MessagePack-serialized ≤ **12 KB**. Asserted by `crates/quanta-proto/tests/wire_size_budget.rs`. Regression: increase in envelope shape that pushes over 12 KB fails CI.
- **DoD-C-28** — Wire-size budget: steady-state `GridDelta` representing a single-row update (e.g., prompt redraw, 1 row × 3 spans) MessagePack-serialized ≤ **800 B**. Test feeds the canonical "prompt redraw" fixture and asserts size.
- **DoD-C-29** — Wire-size budget: burst `GridDelta` representing 40-row repaint (full alt-screen rewrite in an 80-col grid) MessagePack-serialized ≤ **8 KB**. Test feeds the canonical "tmux pane refresh" fixture and asserts size.

### 10.8 Synchronized update

- **DoD-C-30** — `SynchronizedUpdate { phase: Begin }` enters `synced` mode; deltas are applied internally but `GridMirror.onChange` observer is **suppressed**. Test registers an observer, feeds Begin + 50 deltas, asserts 0 observer fires.
- **DoD-C-31** — `SynchronizedUpdate { phase: End }` fires `onChange` **exactly once** with the accumulated dirty row set from the window. Test asserts single fire + dirty-set union equal to the union of `row`s in the 50 deltas.
- **DoD-C-32** — 150ms synchronized-update timeout: if `End` does not arrive within 150ms of `Begin`, the mirror force-ends the synced window and fires `onChange` with the accumulated dirty set; counter `vt.synchronized_update_timeouts` increments. Test uses fake timers.
- **DoD-C-33** — Synchronized-update abort on epoch change: receiving a new-epoch `GridSnapshot` during a synced window aborts the window cleanly (no lost dirty state — snapshot wipes it). Test asserts mirror state equal to snapshot-only state.

### 10.9 Fault injection

- **DoD-C-34** — Drop-every-Nth delta fault injection: `fault_injection.test.ts` generates a 1000-envelope stream, drops every 10th delta before handing to mirror, triggers `ResyncRowRequest` on mismatches, applies `ResyncRowResponse::Ok` replies, and asserts final mirror state matches a clean full-replay. ≥ 100 resyncs expected, 0 snapshot fallbacks (since requests are well-spaced).
- **DoD-C-35** — Reorder fault injection: randomly permute a window of 10 deltas. Mirror discards out-of-order non-snapshot payloads; final state matches a clean-stream replay minus the out-of-order ones (which get resynced). Test asserts zero lost rows after resync completes.

### 10.10 Coverage targets

- **DoD-C-36** — Line coverage ≥ **90%** on `packages/ui/src/shared/lib/grid-mirror/GridMirror.ts` and the adjacent `EnvelopeGate.ts`, `ResyncStrategy.ts`, `ModeMirror.ts`, `Hyperlinks.ts`. Enforced by `vitest --coverage` with a `--coverage-threshold 90` flag in CI.
- **DoD-C-37** — Line coverage ≥ **90%** on `crates/quanta-proto/src/events.rs` and `crates/quanta-proto/src/envelope.rs`. Enforced by `cargo llvm-cov --fail-under-lines 90 -p quanta-proto`.

### 10.11 Hyperlink lifecycle

- **DoD-C-38** — `HyperlinkAdded { id, uri, params }` prior to a referencing `RowDelta` resolves the URI via `HyperlinkTable.lookup(id)`. Test feeds the pair in order and asserts `getRow(row).cells[col].hyperlink == { id, uri, params }`.
- **DoD-C-39** — `HyperlinkRemoved { id }` decrements the refcount; when refcount reaches 0, entry is evicted. Cells still referencing the id by cached reference (scrollback not yet re-rendered) fall back to `{ id, uri: null }` safely without throwing. Test asserts fallback shape.
- **DoD-C-40** — OSC-8 refcount race (§9 TODO #6): `HyperlinkRemoved` immediately followed by `HyperlinkAdded` reusing the same `id` in a new `RowDelta` works correctly. Test sequences Removed → Added → RowDelta and asserts new URI resolves.

### 10.12 Telemetry emission

- **DoD-C-41** — Every counter enumerated in §4.1 (`MirrorTelemetry`) is emitted at least once by a corresponding test scenario: `stale_epoch_drop`, `sequence_gap_drop`, `resize_generation_drop`, `revision_mismatch`, `snapshot_fallback`, `synchronized_update_timeouts`. Covered by an aggregation test that asserts the counter names match the list.

**Total: 41 testable DoD items** (≥ 25 bar met).

---

## 11. Quality Gates

Gates are CI-enforceable. `failure-behavior` is the exact signal shown to the PR author.

| # | Gate | Enforced by | Failure behavior |
|---|------|-------------|------------------|
| QG-C-1 | **Rust proto schema tests** (`grid_schema_snapshots.rs`, `schema_evolution.rs`, `msgpack_roundtrip.rs`) | `cargo test -p quanta-proto` in CI `quanta-proto` job | Red check on PR; diff output from serde_json::to_string_pretty vs committed golden. Log lines annotated with `[DoD-C-02]` / `[DoD-C-05]`. |
| QG-C-2 | **GridMirror vitest suite** (`ordering.test.ts`, `resync.test.ts`, `apply_delta.test.ts`, `cursor.test.ts`, `mode.test.ts`, `synchronized_update.test.ts`) | `pnpm --filter @quanta/ui test -- grid-mirror` | Red check; vitest stacktrace. Output pipes to `reports/grid-mirror.xml` JUnit consumable by GH Actions. |
| QG-C-3 | **Schema-parity vitest** (`schema-parity.test.ts`) | `pnpm --filter @quanta/host-common test -- schema-parity` | Red check; explicit diff listing missing/extra variants in either direction. Must be resolved before merge (rename-protection). |
| QG-C-4 | **Fault-injection integration test** (`fault_injection.test.ts`) | Part of `pnpm --filter @quanta/ui test`, extended run flag | Red check; prints the seed used so the failure is reproducible locally. Each run uses a fixed seed to avoid flakes. |
| QG-C-5 | **Wire-size budget test** (`wire_size_budget.rs`) | `cargo test -p quanta-proto wire_size_budget` | Red check with per-fixture byte budget vs measured. CI comment summarizes the delta for PR review. |
| QG-C-6 | **Coverage threshold** | `vitest --coverage` + `cargo llvm-cov --fail-under-lines 90` | Red check; coverage report posted as PR comment with file-level drilldown. |
| QG-C-7 | **Schema-digest determinism** | `cargo xtask emit-schema-digest --check` | Red check if committed digest differs from freshly emitted; CI prints the diff so author can regenerate. |
| QG-C-8 | **Telemetry counter presence** | Grep rule in EPIC-K `tools/check-telemetry-counters/` | Red check if a counter declared in ADR 0017 §5 is missing from the `quanta-metrics` registry. |
| QG-C-9 | **No UI-side ANSI parsing** | EPIC-K grep `tools/check-ui-no-ansi/` | Red check if `\x1b` / `\\u001b` / ANSI parse utility imports appear outside `crates/quanta-vt/` or test fixtures. |
| QG-C-10 | **`SynchronizedUpdate` timer behavior** | `synchronized_update.test.ts` with `vi.useFakeTimers()` | Red check; test asserts the 150ms timeout fires exactly once and suppresses the second force-end. |

All 10 gates must be green for EPIC-C merge. No waivers; a gate failure triggers a re-spin of the PR (not a manual override).

---

## 12. End-to-end scenarios

Each scenario lists step-by-step actor / action / assertion. Scenarios are implemented as vitest + `tests/integration/` hybrid tests; file locations are given alongside.

### 12.1 E2E-C1 — Full resume

**Goal**: Resume after disconnect; engine replays events; final mirror state matches fresh run. Proves §6 resume contract.

**Fixture**: `tests/integration/tests/resume_fresh_vs_reconnect.rs` drives two mirrors against the same engine-emitted event log.

**Steps**:
1. **Setup**: Spawn engine, open session, feed 500 synthetic CSI frames producing a grid state with cursor at row=7, col=12, mode `bracketedPaste=true`, `altScreen=false`.
2. **Mirror A (fresh)**: Subscribes from `grid_epoch=1, sequence_no=0`. Applies all envelopes through the final one.
3. **Snapshot A**: Capture `getRow(r)` for each r, `getCursor()`, `getMode()`, `getMeta()`, `getAppliedSequence()`, `getAppliedEpoch()`.
4. **Mirror B (reconnect)**: Applies the first 250 envelopes, then "disconnects" (stop feeding). Re-subscribes with `HelloResumeCursor { last_applied_epoch: 1, last_applied_sequence: 249, last_applied_resize_generation: 0 }`.
5. **Host decision**: Since engine epoch/resize still match, host returns `subscribe_response { mode: "replay_from", from_seq: 250 }`. Streams envelopes 250..499.
6. **Snapshot B**: Capture the same outputs.

**Assertions**:
- `snapshot A == snapshot B` for every public getter.
- `B.getAppliedSequence() == 499n == A.getAppliedSequence()`.
- `B.getAppliedEpoch() == 1n`.
- Telemetry counter `vt.stale_epoch_events_dropped == 0`, `vt.row_revision_mismatches == 0`.

---

### 12.2 E2E-C2 — Epoch change on reconnect

**Goal**: Mirror discards pre-reconnect state, rebuilds from fresh snapshot on epoch bump.

**Fixture**: `tests/integration/tests/resume_epoch_change.rs`.

**Steps**:
1. Mirror A applies 300 envelopes with `grid_epoch=1`; `getRow(5)` has content "abc def".
2. Host disconnects and reboots engine; new epoch=2. Session id unchanged.
3. Mirror A reconnects with `HelloResumeCursor { last_applied_epoch: 1, last_applied_sequence: 299, ... }`.
4. Host decision: `engine.current_epoch (2) != cursor.last_applied_epoch (1)` → returns `subscribe_response { mode: "reseed" }` + emits `GridSnapshot` with epoch=2, fresh content (row 5 = "xyz").
5. **Intermediate**: a stale `GridDelta { epoch: 1, sequence_no: 300 }` message (still in the mirror's internal queue from the disconnect period) is delivered AFTER the snapshot.

**Assertions**:
- After snapshot applies: `getAppliedEpoch() == 2n`, `getRow(5) == "xyz"`.
- Stale delta discarded: `vt.stale_epoch_events_dropped == 1`.
- Mirror never shows "abc def" again — `getRow(5)` remains "xyz".

---

### 12.3 E2E-C3 — Mid-stream resize

**Goal**: Pre-resize deltas discarded after `resize_generation` bump.

**Fixture**: `packages/ui/src/shared/lib/grid-mirror/__tests__/resize_generation.e2e.test.ts`.

**Steps**:
1. Mirror applies envelopes through `grid_epoch=1, sequence_no=100, resize_generation=0`. Grid is 80×24.
2. Engine processes a SIGWINCH; new envelope is a `GridSnapshot` at `grid_epoch=1, sequence_no=101, resize_generation=1`. Grid is 120×40.
3. **Out-of-order**: a delayed `GridDelta { grid_epoch: 1, sequence_no: 102, resize_generation: 0 }` arrives (same epoch, old generation) AFTER the snapshot.

**Assertions**:
- Snapshot applies; `getDimensions() == { rows: 40, cols: 120 }`.
- Delayed delta discarded: `vt.stale_resize_generation_events_dropped == 1`. `getRow(n)` unchanged.
- After a fresh `GridDelta { grid_epoch: 1, sequence_no: 103, resize_generation: 1 }`, state updates normally.

---

### 12.4 E2E-C4 — Synchronized-update window

**Goal**: Single render notification for a 50-delta batch inside a DECSET 2026 window.

**Fixture**: `packages/ui/src/shared/lib/grid-mirror/__tests__/synchronized_update.e2e.test.ts`.

**Steps**:
1. Mirror registers an `onChange` observer (spy).
2. Apply `SynchronizedUpdate { phase: Begin }` at seq=1000.
3. Apply 50 `GridDelta` envelopes at seq=1001..1050, each touching a different row.
4. Apply `SynchronizedUpdate { phase: End }` at seq=1051.

**Assertions**:
- Observer called **exactly once**, after End.
- Observer argument contains `dirtyRows` equal to the union of all 50 `RowDelta.row` values.
- Each of the 50 rows is reflected in `getRow(row)` after End.
- `getAppliedSequence() == 1051n`.

---

### 12.5 E2E-C5 — Synchronized-update timeout

**Goal**: 160ms elapse without End → mirror force-ends; observer fires with accumulated dirty set.

**Fixture**: `packages/ui/src/shared/lib/grid-mirror/__tests__/synchronized_update_timeout.e2e.test.ts`. Uses `vi.useFakeTimers()`.

**Steps**:
1. Register observer spy.
2. Apply `SynchronizedUpdate { phase: Begin }` at seq=2000.
3. Apply 10 `GridDelta` envelopes at seq=2001..2010.
4. Advance fake time by 160ms (≥ 150ms threshold).
5. (No `End` sent.)

**Assertions**:
- After time advance, observer called exactly once.
- Counter `vt.synchronized_update_timeouts == 1`.
- Post-force-end, receiving a late `End` is a no-op and does NOT fire observer again.

---

### 12.6 E2E-C6 — Row-revision divergence

**Goal**: Mirror detects bad `revision_before`, requests `ResyncRow`, applies scoped response.

**Fixture**: `packages/ui/src/shared/lib/grid-mirror/__tests__/resync_row.e2e.test.ts`.

**Steps**:
1. Mirror applies baseline deltas through seq=500; `state.rowRevisions[7] == 42`.
2. Inject a crafted `GridDelta` at seq=501 whose `RowDelta { row: 7, revision_before: 99, revision_after: 100 }` — revision mismatch.
3. Capture `ResyncRowRequest` emission via `onResyncRowRequested` spy.
4. Simulate host-side handler: respond with `ResyncRowResponse::Ok { grid_epoch: 1, resize_generation: 0, sequence_no: 502, row_delta: RowDelta { row: 7, revision_before: 0, revision_after: 43, spans: [...correct content...], ... } }`.

**Assertions**:
- After step 3: `onResyncRowRequested` called once with `{ session_id, grid_epoch: 1, resize_generation: 0, row: 7 }`.
- Other rows in the same delta applied normally (apply-rest-on-mismatch).
- After step 4: `getRow(7)` = correct content, `state.rowRevisions[7] == 43`, mismatch log entry cleared.
- Telemetry: `vt.row_revision_mismatches == 1`.

---

### 12.7 E2E-C7 — Storm threshold

**Goal**: 5 mismatches within a 10s window → full snapshot request.

**Fixture**: `packages/ui/src/shared/lib/grid-mirror/__tests__/storm_threshold.e2e.test.ts`. Uses fake timers.

**Steps**:
1. Configure `GridMirrorOptions.stormThreshold = { k: 5, windowMs: 10_000 }`.
2. Inject mismatches at t=0s, t=2s, t=4s, t=6s — 4 mismatches.
3. Assert: no `onSnapshotResyncRequested` fired. Counter `vt.snapshot_fallback_storm_triggered == 0`.
4. Inject 5th mismatch at t=8s.

**Assertions**:
- After step 4: `onSnapshotResyncRequested` fires exactly once with `{ session_id, epoch: current, reason: "row_mismatch_storm" }`.
- Counter `vt.snapshot_fallback_storm_triggered == 1`.
- Next 10 `GridDelta` envelopes (before snapshot arrives) discarded with `vt.stale_sequence_events_dropped` incrementing.
- When `GridSnapshot` arrives: mirror resumes normal operation; `mismatchLog` cleared.

---

### 12.8 E2E-C8 — Hyperlink lifecycle

**Goal**: OSC 8 lifecycle: open → reference → close → orphan-safe fallback.

**Fixture**: `packages/ui/src/shared/lib/grid-mirror/__tests__/hyperlink_lifecycle.e2e.test.ts`.

**Steps**:
1. Apply `HyperlinkAdded { id: 1, uri: "https://example.com", params: null }`.
2. Apply `GridDelta` whose row 5 contains a `CellSpan { hyperlink_id: 1, ... }`. `RowDelta.hyperlink_refs = [1]`.
3. Apply `HyperlinkRemoved { id: 1 }`.
4. Query `getRow(5).cells[col]` for the cell that referenced the hyperlink.

**Assertions**:
- After step 2: `getRow(5).cells[col].hyperlink == { id: 1, uri: "https://example.com", params: null }`.
- After step 3: `HyperlinkTable.lookup(1)` returns `null` (or `{ id: 1, uri: null }` fallback — exact shape per impl agent; test pins one).
- After step 4: cell still references `id: 1` but the resolver returns a safe fallback. **No exception thrown.** No `uri` reconstruction.
- If a new `HyperlinkAdded { id: 1, uri: "https://new.com" }` arrives, subsequent row deltas resolve to the new URI (id reuse works per §9 TODO #6).

---

### 12.9 E2E-C9 — Schema evolution forward-compat

**Goal**: Old TS client gracefully handles new Rust-added field.

**Fixture**: `packages/host-common/src/__tests__/schema-evolution-forward.e2e.test.ts`.

**Steps**:
1. Take the `grid_snapshot.golden.json` fixture.
2. Inject a new key `"future_field": "unknown"` into `payload.meta` (simulating a Rust-side addition the TS hasn't learned yet).
3. Feed through TS deserialization path.

**Assertions**:
- Deserialization succeeds without throwing.
- `unknown` key is dropped (or quarantined into `meta.unknownFields` if that pattern is adopted).
- Counter `vt.unknown_protocol_field_observed` increments — provides a telemetry signal that rollouts are mismatched.

---

### 12.10 E2E-C10 — MessagePack/JSON cross-encoding

**Goal**: The same envelope encoded as MessagePack and as JSON decodes to an identical structure.

**Fixture**: `crates/quanta-proto/tests/msgpack_roundtrip.rs`.

**Steps**:
1. Load each golden JSON.
2. Deserialize into `EventEnvelope<TerminalEventPayload>`.
3. Re-serialize to MessagePack bytes.
4. Deserialize MessagePack bytes back to `EventEnvelope<TerminalEventPayload>`.
5. Re-serialize to JSON.

**Assertions**:
- Step-5 output byte-equal to the committed golden (after canonicalization: sorted keys, trimmed whitespace).
- Intermediate MessagePack size recorded and stored in `target/wire-size-report.json` for DoD-C-27/28/29 verification.

---

**Total: 10 E2E scenarios** (≥ 8 bar met). E2E-C9 covers the "unknown field" forward-compat path and E2E-C10 cements the MessagePack↔JSON faithfulness that DoD-C-03 asserts.

---

## 13. Test coverage targets

Explicit thresholds — enforced by CI.

| Target | Threshold | Enforcement |
|--------|-----------|-------------|
| `packages/ui/src/shared/lib/grid-mirror/GridMirror.ts` (line coverage) | ≥ 90% | `vitest --coverage --coverage-threshold 90` |
| `packages/ui/src/shared/lib/grid-mirror/EnvelopeGate.ts` | ≥ 90% | same |
| `packages/ui/src/shared/lib/grid-mirror/ResyncStrategy.ts` | ≥ 90% | same |
| `packages/ui/src/shared/lib/grid-mirror/ModeMirror.ts` | ≥ 90% | same |
| `packages/ui/src/shared/lib/grid-mirror/Hyperlinks.ts` | ≥ 90% | same |
| `crates/quanta-proto/src/events.rs` | ≥ 90% (lines) | `cargo llvm-cov --fail-under-lines 90 -p quanta-proto` |
| `crates/quanta-proto/src/envelope.rs` | ≥ 90% (lines) | same |
| Branch coverage (aggregate) | ≥ 80% | reported in CI comment; non-blocking but tracked |
| Mutation testing (sample, quarterly) | ≥ 70% mutant kill rate on `GridMirror.ts` | `stryker run`; tracked, not gated |

Coverage reports are uploaded as CI artifacts under `coverage/grid-mirror/` and `coverage/quanta-proto/`. Regression in any line-coverage target is a hard CI failure; branch-coverage and mutation are informational.
