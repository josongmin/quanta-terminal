//! The [`Grid`] — terminal semantic truth.
//!
//! Owns cells, widths, cursor, buffer, scrollback, SGR pen, charset state,
//! modes, and damage tracking. Per RFC 0001 §3.1, all terminal semantic
//! state is derived here; everything else mirrors or emits.
//!
//! # Public entry points
//!
//! - [`Grid::new`] — construct.
//! - [`Grid::feed`] — feed PTY bytes; returns accumulated events.
//! - [`Grid::resize`] — change geometry; bumps `resize_generation`.
//! - [`Grid::snapshot`] — full state capture.
//! - [`Grid::row_revision`] / [`Grid::active_buffer`] /
//!   [`Grid::mode_snapshot`] / [`Grid::epoch`] / [`Grid::next_sequence`] —
//!   read-only surface.
//! - [`Grid::reinit_epoch`] — fence pre-reconnect consumers.
//!
//! # Hex layout note
//!
//! `Grid` lives in `domain/` but needs a [`WidthClassifier`] to correctly
//! classify graphemes. The classifier is injected via `Arc<dyn _>` so the
//! call site can swap it; no `adapters/` import from here.

use std::sync::Arc;

use quanta_vt_width::{CellWidth, Grapheme, WidthClassifier, WrapEligibility};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::domain::cell::{Cell, HyperlinkId};
use crate::domain::charset::CharsetState;
use crate::domain::color::Color;
use crate::domain::cursor::{Cursor, CursorSave};
use crate::domain::mode_state::TerminalModeState;
use crate::domain::modes::{DecMode, Modes};
use crate::domain::sgr::SgrState;
use crate::ports::event::{
    CellRun, CursorPayload, GridDelta, GridSnapshot, ModeChangedPayload, RectDamage, RowDelta,
    SyncUpdatePayload, TerminalEvent,
};

/// Which buffer is currently active.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BufferKind {
    /// Main screen buffer (with scrollback).
    #[default]
    Main,
    /// Alternate screen buffer (no scrollback).
    Alt,
}

/// Rectangular region. Inclusive bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub top: u16,
    pub left: u16,
    pub bottom: u16,
    pub right: u16,
}

/// Error surface from public Grid APIs that can fail.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GridError {
    /// Resize with zero rows or zero cols.
    #[error("invalid geometry: rows={rows} cols={cols}")]
    InvalidGeometry { rows: u16, cols: u16 },
}

/// Incremental attribute delta captured by the damage tracker (reserved for
/// future telemetry / fine-grained diffing).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttrDelta {
    pub row: u16,
    pub col: u16,
    pub revision: u64,
}

/// A single row. Cells are dense (exactly `cols` entries). `continuation`
/// marks a soft-wrap successor.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Row {
    pub cells: Vec<Cell>,
    pub continuation: bool,
}

impl Row {
    pub(crate) fn blank(cols: u16) -> Self {
        Self {
            cells: vec![Cell::empty(); cols as usize],
            continuation: false,
        }
    }

    pub(crate) fn resize(&mut self, cols: u16) {
        self.cells.resize(cols as usize, Cell::empty());
    }
}

/// A single "feed-internal" buffer (main or alt). Stored flat so reset /
/// swap is cheap.
#[derive(Debug, Clone)]
pub(crate) struct Buffer {
    pub rows: Vec<Row>,
    pub row_revisions: Vec<u64>,
    pub saved_cursor: Option<CursorSave>,
}

impl Buffer {
    pub(crate) fn new(rows: u16, cols: u16) -> Self {
        let rows_v = (0..rows).map(|_| Row::blank(cols)).collect();
        let revisions = vec![1u64; rows as usize];
        Self {
            rows: rows_v,
            row_revisions: revisions,
            saved_cursor: None,
        }
    }

    pub(crate) fn clear(&mut self, cols: u16) {
        for r in &mut self.rows {
            r.cells.clear();
            r.cells.resize(cols as usize, Cell::empty());
            r.continuation = false;
        }
        for rev in &mut self.row_revisions {
            *rev = rev.saturating_add(1);
        }
    }
}

/// Scroll region (DECSTBM). Inclusive 0-based bounds; default = full grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ScrollRegion {
    pub top: u16,
    /// Inclusive bottom row.
    pub bottom: u16,
}

impl ScrollRegion {
    pub(crate) fn full(rows: u16) -> Self {
        Self {
            top: 0,
            bottom: rows.saturating_sub(1),
        }
    }
}

/// Damage tracker — records which rows were dirtied in the current feed.
#[derive(Debug, Clone, Default)]
pub(crate) struct DamageTracker {
    /// One bit per row in the active buffer. Resized on geometry change.
    pub row_dirty: Vec<bool>,
    /// Scroll-region rect damage accumulated this feed.
    pub rects: Vec<RectDamage>,
    /// Rows appended to scrollback this feed.
    pub scrollback_appended: u32,
}

impl DamageTracker {
    pub(crate) fn new(rows: u16) -> Self {
        Self {
            row_dirty: vec![false; rows as usize],
            rects: Vec::new(),
            scrollback_appended: 0,
        }
    }

    pub(crate) fn mark(&mut self, row: u16) {
        if let Some(slot) = self.row_dirty.get_mut(row as usize) {
            *slot = true;
        }
    }

    pub(crate) fn mark_all(&mut self) {
        for slot in &mut self.row_dirty {
            *slot = true;
        }
    }

    pub(crate) fn resize(&mut self, rows: u16) {
        self.row_dirty.clear();
        self.row_dirty.resize(rows as usize, false);
    }

    pub(crate) fn push_rect(&mut self, rect: RectDamage) {
        self.rects.push(rect);
    }

    pub(crate) fn reset(&mut self) {
        for slot in &mut self.row_dirty {
            *slot = false;
        }
        self.rects.clear();
        self.scrollback_appended = 0;
    }
}

/// The engine.
pub struct Grid {
    rows: u16,
    cols: u16,
    scrollback_cap: usize,
    classifier: Arc<dyn WidthClassifier>,

    main: Buffer,
    alt: Buffer,
    active: BufferKind,

    scrollback: std::collections::VecDeque<Row>,
    scrollback_revisions: std::collections::VecDeque<u64>,

    cursor: Cursor,
    last_emitted_cursor: Cursor,

    sgr: SgrState,
    charset: CharsetState,
    modes: Modes,
    scroll_region: ScrollRegion,

    damage: DamageTracker,

    // Ordering: ADR 0017.
    grid_epoch: u64,
    sequence_no: u64,
    resize_generation: u64,

    // Event buffer for the current feed.
    pending_events: Vec<TerminalEvent>,
    // Mode changes observed this feed (deduped at flush).
    pending_mode_changes: Vec<DecMode>,
    // Pending `CursorMoved` — we'll emit at end of feed if the cursor moved.
    cursor_changed: bool,
    // Pending grapheme accumulator (cross-call state).
    grapheme_acc: GraphemeAccumulator,

    // Hyperlink allocator.
    next_hyperlink_id: u32,

    // Pending OSC 8 URI (opened; pen will hyperlink-stamp until closed).
    open_hyperlink: Option<HyperlinkId>,

    // Initial-snapshot-needed flag (set on reinit_epoch).
    need_snapshot_on_next_feed: bool,

    // Unknown CSI / OSC / SGR telemetry counters (exposed for test).
    pub(crate) unknown_csi_count: u32,
    pub(crate) unknown_osc_count: u32,
    pub(crate) unknown_sgr_count: u32,
}

impl std::fmt::Debug for Grid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Grid")
            .field("rows", &self.rows)
            .field("cols", &self.cols)
            .field("active", &self.active)
            .field("cursor", &self.cursor)
            .field("grid_epoch", &self.grid_epoch)
            .field("sequence_no", &self.sequence_no)
            .field("resize_generation", &self.resize_generation)
            .finish()
    }
}

impl Grid {
    /// Construct a new grid.
    ///
    /// # Panics
    ///
    /// Never panics; invalid geometry clamps to `(1, 1)` with a trace
    /// warning so callers can still inspect the resulting grid.
    #[must_use]
    pub fn new(
        rows: u16,
        cols: u16,
        scrollback_cap: usize,
        classifier: Arc<dyn WidthClassifier>,
    ) -> Self {
        let (rows, cols) = if rows == 0 || cols == 0 {
            tracing::warn!(rows, cols, "Grid::new: zero geometry clamped to (1, 1)");
            (1, 1)
        } else {
            (rows, cols)
        };

        Self {
            rows,
            cols,
            scrollback_cap,
            classifier,
            main: Buffer::new(rows, cols),
            alt: Buffer::new(rows, cols),
            active: BufferKind::Main,
            scrollback: std::collections::VecDeque::new(),
            scrollback_revisions: std::collections::VecDeque::new(),
            cursor: Cursor::default(),
            last_emitted_cursor: Cursor::default(),
            sgr: SgrState::DEFAULT,
            charset: CharsetState::default(),
            modes: Modes::initial(),
            scroll_region: ScrollRegion::full(rows),
            damage: DamageTracker::new(rows),
            grid_epoch: 1,
            sequence_no: 0,
            resize_generation: 1,
            pending_events: Vec::new(),
            pending_mode_changes: Vec::new(),
            cursor_changed: false,
            grapheme_acc: GraphemeAccumulator::default(),
            next_hyperlink_id: 1,
            open_hyperlink: None,
            need_snapshot_on_next_feed: false,
            unknown_csi_count: 0,
            unknown_osc_count: 0,
            unknown_sgr_count: 0,
        }
    }

    /// Current row count.
    #[must_use]
    pub fn rows(&self) -> u16 {
        self.rows
    }

    /// Current column count.
    #[must_use]
    pub fn cols(&self) -> u16 {
        self.cols
    }

    /// Current active buffer.
    #[must_use]
    pub fn active_buffer(&self) -> BufferKind {
        self.active
    }

    /// Current epoch.
    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.grid_epoch
    }

    /// Current resize generation.
    #[must_use]
    pub fn resize_generation(&self) -> u64 {
        self.resize_generation
    }

    /// Allocate the next sequence number. Increments; intended for use by
    /// the caller (EPIC-F) when building an [`EventEnvelope`]. ADR 0017 §1.
    pub fn next_sequence(&mut self) -> u64 {
        self.sequence_no = self.sequence_no.saturating_add(1);
        self.sequence_no
    }

    /// Peek the last-emitted sequence number (without incrementing).
    #[must_use]
    pub fn last_sequence(&self) -> u64 {
        self.sequence_no
    }

    /// Scrollback length (rows currently held in history).
    #[must_use]
    pub fn scrollback_len(&self) -> usize {
        self.scrollback.len()
    }

    /// Scrollback capacity.
    #[must_use]
    pub fn scrollback_cap(&self) -> usize {
        self.scrollback_cap
    }

    /// Per-row revision.
    #[must_use]
    pub fn row_revision(&self, row: u16) -> Option<u64> {
        self.active_buffer_ref()
            .row_revisions
            .get(row as usize)
            .copied()
    }

    /// Mode snapshot for the input encoder. ADR 0017 §4.
    #[must_use]
    pub fn mode_snapshot(&self) -> TerminalModeState {
        TerminalModeState::snapshot_from(&self.modes)
    }

    /// Bump the epoch (reconnect / reinit). Next feed starts with a
    /// `GridSnapshot`. ADR 0017 §3.
    pub fn reinit_epoch(&mut self) {
        self.grid_epoch = self.grid_epoch.saturating_add(1);
        self.sequence_no = 0;
        self.need_snapshot_on_next_feed = true;
    }

    /// Current cursor state (read-only).
    #[must_use]
    pub fn cursor(&self) -> Cursor {
        self.cursor
    }

    /// Full grid snapshot. Used on connect / resume / divergence resync.
    #[must_use]
    pub fn snapshot(&self) -> GridSnapshot {
        let buf = self.active_buffer_ref();
        GridSnapshot {
            rows: self.rows,
            cols: self.cols,
            buffer_kind: self.active,
            cells: buf.rows.iter().map(|r| r.cells.clone()).collect(),
            continuations: buf.rows.iter().map(|r| r.continuation).collect(),
            row_revisions: buf.row_revisions.clone(),
            cursor: self.cursor_payload(),
            modes: self.mode_snapshot(),
        }
    }

    /// Feed PTY bytes and collect emitted events.
    ///
    /// Event order (per epic-B §7.4):
    /// 1. `ModeChanged` (if any)
    /// 2. `Resize` (rare inside feed)
    /// 3. `GridDelta`
    /// 4. `CursorMoved`
    /// 5. OSC-derived (`TitleChanged`, `CwdChanged`, etc.) in byte-stream order
    /// 6. `SynchronizedUpdate`
    /// 7. Unknown-* telemetry
    ///
    /// Alt-screen `ModeChanged` is emitted BEFORE the first cell delta of
    /// the destination buffer (retires failure mode #8).
    /// Drive the grid with a chunk of PTY bytes.
    ///
    /// This thin entry point delegates parsing to
    /// [`crate::adapters::vte_processor`]. Keeping the hex boundary
    /// `domain → ports` intact means the concrete `VteProcessor` is
    /// invoked via a free function in the adapters layer rather than
    /// imported here. Callers should use [`Grid::feed`].
    #[must_use]
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<TerminalEvent> {
        crate::adapters::vte_processor::feed_grid(self, bytes)
    }

    /// Invoked by the `vte_processor` adapter to finalize and collect
    /// events after a feed pass. Kept public-in-crate so the adapter
    /// can compose the full event sequence without re-implementing the
    /// snapshot / ModeChanged / GridDelta / CursorMoved ordering in
    /// domain-unaware code.
    pub(crate) fn finalize_feed(&mut self) -> Vec<TerminalEvent> {
        let mut out = Vec::new();

        if self.need_snapshot_on_next_feed {
            out.push(TerminalEvent::GridSnapshot(self.snapshot()));
            self.need_snapshot_on_next_feed = false;
        }

        self.flush_grapheme();

        // 1) ModeChanged first (including alt-screen).
        if !self.pending_mode_changes.is_empty() {
            let changed = std::mem::take(&mut self.pending_mode_changes);
            out.push(TerminalEvent::ModeChanged(ModeChangedPayload {
                state: self.mode_snapshot(),
                changed,
            }));
        }

        // 2) GridDelta
        let delta = self.build_delta();
        if !delta.row_deltas.is_empty()
            || !delta.rect_damage.is_empty()
            || delta.scrollback_appended > 0
        {
            out.push(TerminalEvent::GridDelta(delta));
        }

        // 3) CursorMoved
        if self.cursor_changed && self.cursor != self.last_emitted_cursor {
            out.push(TerminalEvent::CursorMoved(self.cursor_payload()));
            self.last_emitted_cursor = self.cursor;
        }

        // 4) OSC + misc — taken from pending_events in stream order.
        let pending = std::mem::take(&mut self.pending_events);
        out.extend(pending);

        out
    }

    /// Reset per-feed scratch state. Invoked by the adapter at the
    /// start of each feed pass.
    pub(crate) fn reset_feed_scratch(&mut self) {
        self.damage.reset();
        self.pending_mode_changes.clear();
        self.cursor_changed = false;
    }

    /// Resize the grid. Bumps `resize_generation`; emits Resize + snapshot.
    ///
    /// # Errors
    ///
    /// Returns [`GridError::InvalidGeometry`] if either dimension is zero.
    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<Vec<TerminalEvent>, GridError> {
        if rows == 0 || cols == 0 {
            return Err(GridError::InvalidGeometry { rows, cols });
        }
        if rows == self.rows && cols == self.cols {
            return Ok(Vec::new());
        }

        self.flush_grapheme();

        // Main buffer: reflow.
        if matches!(self.active, BufferKind::Main) {
            self.reflow_main(cols);
        } else {
            // Alt buffer: also reflow main silently, but keep alt clip/pad.
            self.reflow_main(cols);
            self.clip_or_pad_buffer(BufferKind::Alt, cols);
        }

        // Row count normalization for both buffers.
        self.normalize_rows(BufferKind::Main, rows, cols);
        self.normalize_rows(BufferKind::Alt, rows, cols);

        self.rows = rows;
        self.cols = cols;
        self.scroll_region = ScrollRegion::full(rows);

        self.damage.resize(rows);
        for rev in &mut self.active_buffer_mut().row_revisions {
            *rev = rev.saturating_add(1);
        }
        self.damage.mark_all();

        self.cursor.clamp(rows, cols);
        self.cursor.pending_wrap = false;

        self.resize_generation = self.resize_generation.saturating_add(1);

        let mut out = Vec::new();
        out.push(TerminalEvent::Resize {
            rows,
            cols,
            resize_generation: self.resize_generation,
        });
        out.push(TerminalEvent::GridSnapshot(self.snapshot()));
        self.damage.reset();
        self.last_emitted_cursor = self.cursor;
        Ok(out)
    }

    // ---------------------------------------------------------------------
    // Grid internal API — consumed by `adapters::vte_processor`.
    // ---------------------------------------------------------------------

    pub(crate) fn sgr_mut(&mut self) -> &mut SgrState {
        &mut self.sgr
    }

    pub(crate) fn sgr_ref(&self) -> &SgrState {
        &self.sgr
    }

    pub(crate) fn charset_mut(&mut self) -> &mut CharsetState {
        &mut self.charset
    }

    pub(crate) fn classifier(&self) -> &Arc<dyn WidthClassifier> {
        &self.classifier
    }

    pub(crate) fn emit(&mut self, event: TerminalEvent) {
        self.pending_events.push(event);
    }

    pub(crate) fn bump_unknown_csi(&mut self) {
        self.unknown_csi_count = self.unknown_csi_count.saturating_add(1);
    }

    pub(crate) fn bump_unknown_osc(&mut self) {
        self.unknown_osc_count = self.unknown_osc_count.saturating_add(1);
    }

    pub(crate) fn bump_unknown_sgr(&mut self, n: u32) {
        self.unknown_sgr_count = self.unknown_sgr_count.saturating_add(n);
    }

    pub(crate) fn active_buffer_ref(&self) -> &Buffer {
        match self.active {
            BufferKind::Main => &self.main,
            BufferKind::Alt => &self.alt,
        }
    }

    pub(crate) fn active_buffer_mut(&mut self) -> &mut Buffer {
        match self.active {
            BufferKind::Main => &mut self.main,
            BufferKind::Alt => &mut self.alt,
        }
    }

    pub(crate) fn bump_row_revision(&mut self, row: u16) {
        if let Some(rev) = self.active_buffer_mut().row_revisions.get_mut(row as usize) {
            *rev = rev.saturating_add(1);
        }
        self.damage.mark(row);
    }

    pub(crate) fn cursor_payload(&self) -> CursorPayload {
        CursorPayload {
            row: self.cursor.row,
            col: self.cursor.col,
            visible: self.cursor.visible,
            shape: self.cursor.shape,
            pending_wrap: self.cursor.pending_wrap,
        }
    }

    pub(crate) fn set_cursor_pos(&mut self, row: u16, col: u16) {
        let r = row.min(self.rows.saturating_sub(1));
        let c = col.min(self.cols.saturating_sub(1));
        if r != self.cursor.row || c != self.cursor.col {
            self.cursor_changed = true;
        }
        self.cursor.row = r;
        self.cursor.col = c;
        self.cursor.pending_wrap = false;
    }

    pub(crate) fn cursor_up(&mut self, n: u16) {
        let n = n.max(1);
        let new_row = self.cursor.row.saturating_sub(n);
        self.set_cursor_pos(new_row, self.cursor.col);
    }

    pub(crate) fn cursor_down(&mut self, n: u16) {
        let n = n.max(1);
        let new_row = (u32::from(self.cursor.row) + u32::from(n))
            .min(u32::from(self.rows.saturating_sub(1))) as u16;
        self.set_cursor_pos(new_row, self.cursor.col);
    }

    pub(crate) fn cursor_right(&mut self, n: u16) {
        let n = n.max(1);
        let new_col = (u32::from(self.cursor.col) + u32::from(n))
            .min(u32::from(self.cols.saturating_sub(1))) as u16;
        self.set_cursor_pos(self.cursor.row, new_col);
    }

    pub(crate) fn cursor_left(&mut self, n: u16) {
        let n = n.max(1);
        let new_col = self.cursor.col.saturating_sub(n);
        self.set_cursor_pos(self.cursor.row, new_col);
    }

    pub(crate) fn carriage_return(&mut self) {
        self.set_cursor_pos(self.cursor.row, 0);
    }

    pub(crate) fn backspace(&mut self) {
        if self.cursor.col > 0 {
            self.set_cursor_pos(self.cursor.row, self.cursor.col - 1);
        } else {
            self.cursor.pending_wrap = false;
        }
    }

    pub(crate) fn horizontal_tab(&mut self) {
        let new_col = ((self.cursor.col / 8) + 1) * 8;
        let clamped = new_col.min(self.cols.saturating_sub(1));
        self.set_cursor_pos(self.cursor.row, clamped);
    }

    pub(crate) fn line_feed(&mut self) {
        let bottom = self.scroll_region.bottom;
        if self.cursor.row == bottom {
            // Scroll up within region.
            self.scroll_up_region(1);
        } else if self.cursor.row < self.rows.saturating_sub(1) {
            self.cursor.row += 1;
            self.cursor_changed = true;
        }
        self.cursor.pending_wrap = false;
    }

    pub(crate) fn reverse_index(&mut self) {
        let top = self.scroll_region.top;
        if self.cursor.row == top {
            self.scroll_down_region(1);
        } else if self.cursor.row > 0 {
            self.cursor.row -= 1;
            self.cursor_changed = true;
        }
        self.cursor.pending_wrap = false;
    }

    pub(crate) fn bell(&mut self) {
        self.emit(TerminalEvent::BellRequested);
    }

    pub(crate) fn scroll_up_region(&mut self, n: u16) {
        let top = self.scroll_region.top as usize;
        let bottom = self.scroll_region.bottom as usize;
        if top > bottom {
            return;
        }
        let cols = self.cols;
        let active = self.active;
        let scrollback_cap = self.scrollback_cap;
        let is_main = matches!(active, BufferKind::Main);
        let top_is_zero = top == 0;

        // Region size = bottom - top + 1
        let n = n.min((bottom - top + 1) as u16) as usize;

        // Append rows scrolled out the top to scrollback IF region == full
        // main viewport. Otherwise rows are just dropped.
        let full_region = is_main && top_is_zero && bottom == self.rows.saturating_sub(1) as usize;

        let buf = match active {
            BufferKind::Main => &mut self.main,
            BufferKind::Alt => &mut self.alt,
        };

        if full_region {
            // Shift out of top; push to scrollback.
            for _ in 0..n {
                if buf.rows.is_empty() {
                    break;
                }
                let row = buf.rows.remove(0);
                let rev = if buf.row_revisions.is_empty() {
                    0
                } else {
                    buf.row_revisions.remove(0)
                };
                self.scrollback.push_back(row);
                self.scrollback_revisions.push_back(rev);
                while self.scrollback.len() > scrollback_cap {
                    self.scrollback.pop_front();
                    self.scrollback_revisions.pop_front();
                }
                self.damage.scrollback_appended = self.damage.scrollback_appended.saturating_add(1);
                buf.rows.push(Row::blank(cols));
                buf.row_revisions.push(1);
            }
        } else {
            // Local region scroll.
            for _ in 0..n {
                buf.rows[top..=bottom].rotate_left(1);
                // Blank the new bottom row.
                if let Some(last) = buf.rows.get_mut(bottom) {
                    *last = Row::blank(cols);
                }
            }
        }
        // Bump revisions for every row in the region.
        for r in top..=bottom {
            if let Some(rev) = self.active_buffer_mut().row_revisions.get_mut(r) {
                *rev = rev.saturating_add(1);
            }
            self.damage.mark(r as u16);
        }
        // Emit rect damage for the region.
        let latest_rev = self
            .active_buffer_ref()
            .row_revisions
            .get(bottom)
            .copied()
            .unwrap_or(0);
        self.damage.push_rect(RectDamage {
            top: top as u16,
            left: 0,
            bottom: bottom as u16,
            right: self.cols.saturating_sub(1),
            revision: latest_rev,
        });
    }

    pub(crate) fn scroll_down_region(&mut self, n: u16) {
        let top = self.scroll_region.top as usize;
        let bottom = self.scroll_region.bottom as usize;
        if top > bottom {
            return;
        }
        let cols = self.cols;
        let n = n.min((bottom - top + 1) as u16) as usize;
        let buf = self.active_buffer_mut();
        for _ in 0..n {
            buf.rows[top..=bottom].rotate_right(1);
            if let Some(first) = buf.rows.get_mut(top) {
                *first = Row::blank(cols);
            }
        }
        for r in top..=bottom {
            if let Some(rev) = self.active_buffer_mut().row_revisions.get_mut(r) {
                *rev = rev.saturating_add(1);
            }
            self.damage.mark(r as u16);
        }
        let latest_rev = self
            .active_buffer_ref()
            .row_revisions
            .get(bottom)
            .copied()
            .unwrap_or(0);
        self.damage.push_rect(RectDamage {
            top: top as u16,
            left: 0,
            bottom: bottom as u16,
            right: self.cols.saturating_sub(1),
            revision: latest_rev,
        });
    }

    pub(crate) fn set_scroll_region(&mut self, top: Option<u16>, bottom: Option<u16>) {
        let top = top.unwrap_or(1).saturating_sub(1);
        let bottom = bottom
            .unwrap_or(self.rows)
            .saturating_sub(1)
            .min(self.rows.saturating_sub(1));
        if top < bottom {
            self.scroll_region = ScrollRegion { top, bottom };
            // Origin mode: cursor returns to scroll region origin.
            let col = if self.modes.is_set(DecMode::Origin) {
                0
            } else {
                self.cursor.col
            };
            let row = if self.modes.is_set(DecMode::Origin) {
                top
            } else {
                0
            };
            self.set_cursor_pos(row, col);
        }
    }

    pub(crate) fn erase_in_display(&mut self, mode: u16) {
        let cols = self.cols;
        let rows = self.rows;
        let cursor_row = self.cursor.row as usize;
        let cursor_col = self.cursor.col as usize;
        let buf = self.active_buffer_mut();
        match mode {
            0 => {
                // Cursor to end of display.
                if let Some(row) = buf.rows.get_mut(cursor_row) {
                    for cell in row.cells.iter_mut().skip(cursor_col) {
                        *cell = Cell::empty();
                    }
                }
                for r in (cursor_row + 1)..(rows as usize) {
                    if let Some(row) = buf.rows.get_mut(r) {
                        for cell in &mut row.cells {
                            *cell = Cell::empty();
                        }
                        row.continuation = false;
                    }
                }
            }
            1 => {
                // Beginning to cursor.
                for r in 0..cursor_row {
                    if let Some(row) = buf.rows.get_mut(r) {
                        for cell in &mut row.cells {
                            *cell = Cell::empty();
                        }
                        row.continuation = false;
                    }
                }
                if let Some(row) = buf.rows.get_mut(cursor_row) {
                    for cell in row.cells.iter_mut().take(cursor_col + 1) {
                        *cell = Cell::empty();
                    }
                }
            }
            2 => {
                // Entire display.
                for row in &mut buf.rows {
                    for cell in &mut row.cells {
                        *cell = Cell::empty();
                    }
                    row.continuation = false;
                }
            }
            3 => {
                // Scrollback erase. Only on main buffer.
                if matches!(self.active, BufferKind::Main) {
                    self.scrollback.clear();
                    self.scrollback_revisions.clear();
                    self.emit(TerminalEvent::ClearScrollback);
                }
                // Ensure cols is referenced in this branch so tooling like
                // `-D warnings` doesn't complain about unused captures in
                // edge cases.
                let _ = cols;
                return;
            }
            _ => return,
        }
        // Bump revisions on all affected rows (coarse: all).
        for rev in &mut self.active_buffer_mut().row_revisions {
            *rev = rev.saturating_add(1);
        }
        self.damage.mark_all();
    }

    pub(crate) fn erase_in_line(&mut self, mode: u16) {
        let cursor_row = self.cursor.row as usize;
        let cursor_col = self.cursor.col as usize;
        let buf = self.active_buffer_mut();
        if let Some(row) = buf.rows.get_mut(cursor_row) {
            match mode {
                0 => {
                    for cell in row.cells.iter_mut().skip(cursor_col) {
                        *cell = Cell::empty();
                    }
                }
                1 => {
                    for cell in row.cells.iter_mut().take(cursor_col + 1) {
                        *cell = Cell::empty();
                    }
                }
                2 => {
                    for cell in &mut row.cells {
                        *cell = Cell::empty();
                    }
                }
                _ => return,
            }
        }
        self.bump_row_revision(self.cursor.row);
    }

    pub(crate) fn save_cursor(&mut self) {
        let save = CursorSave::capture(
            self.cursor,
            self.sgr,
            self.charset,
            self.modes.is_set(DecMode::Origin),
        );
        self.active_buffer_mut().saved_cursor = Some(save);
    }

    pub(crate) fn restore_cursor(&mut self) {
        let rows = self.rows;
        let cols = self.cols;
        if let Some(save) = self.active_buffer_mut().saved_cursor.clone() {
            self.cursor = save.cursor;
            self.cursor.clamp(rows, cols);
            self.sgr = save.sgr;
            self.charset = save.charset;
            self.modes.set(DecMode::Origin, save.origin_mode);
            self.cursor_changed = true;
        }
    }

    pub(crate) fn dec_set(&mut self, code: u16, on: bool) {
        if let Some(mode) = DecMode::from_code(code) {
            let was = self.modes.is_set(mode);
            self.modes.set(mode, on);
            if was != on {
                self.pending_mode_changes.push(mode);
            }
            match mode {
                DecMode::CursorVisible => {
                    self.cursor.visible = on;
                    self.cursor_changed = true;
                }
                DecMode::AltScreenBuffer => {
                    self.swap_alt(
                        on, /*save_cursor=*/ false, /*clear_on_enter=*/ false,
                    );
                }
                DecMode::AltScreenAlt => {
                    self.swap_alt(
                        on, /*save_cursor=*/ false, /*clear_on_enter=*/ !on,
                    );
                }
                DecMode::AltScreenFull => {
                    // 1049: save+enter+clear (on); restore+exit (off).
                    if on {
                        self.save_cursor();
                        self.swap_alt(true, false, true);
                    } else {
                        self.swap_alt(false, false, false);
                        self.restore_cursor();
                    }
                }
                DecMode::SaveCursor => {
                    if on {
                        self.save_cursor();
                    } else {
                        self.restore_cursor();
                    }
                }
                DecMode::SyncUpdate => {
                    self.emit(TerminalEvent::SynchronizedUpdate(if on {
                        SyncUpdatePayload::Begin
                    } else {
                        SyncUpdatePayload::End
                    }));
                }
                _ => {}
            }
        } else {
            self.emit(TerminalEvent::UnknownDecMode { code, set: on });
            self.modes.note_unknown(code);
        }
    }

    fn swap_alt(&mut self, to_alt: bool, _save_cursor: bool, clear_on_enter: bool) {
        let target = if to_alt {
            BufferKind::Alt
        } else {
            BufferKind::Main
        };
        if self.active == target {
            return;
        }
        self.active = target;
        if clear_on_enter {
            let cols = self.cols;
            self.active_buffer_mut().clear(cols);
        }
        self.damage.mark_all();
        self.cursor_changed = true;
    }

    pub(crate) fn cursor_shape_set(&mut self, param: u16) {
        if let Some(shape) = crate::domain::cursor::CursorShape::from_decscusr(param) {
            self.cursor.shape = shape;
            self.cursor_changed = true;
        }
    }

    pub(crate) fn ris_full_reset(&mut self) {
        // Reset pen + charset + modes + cursor; keep buffers intact but
        // bump revisions so consumers refresh. Epoch bumps so the UI
        // resyncs entirely.
        self.sgr = SgrState::DEFAULT;
        self.charset = CharsetState::default();
        self.modes = Modes::initial();
        self.cursor = Cursor::default();
        self.scroll_region = ScrollRegion::full(self.rows);
        self.cursor_changed = true;
        self.reinit_epoch();
    }

    pub(crate) fn next_hyperlink_id(&mut self) -> HyperlinkId {
        let id = HyperlinkId(self.next_hyperlink_id);
        self.next_hyperlink_id = self.next_hyperlink_id.saturating_add(1);
        id
    }

    pub(crate) fn open_hyperlink(&mut self) -> Option<HyperlinkId> {
        self.open_hyperlink
    }

    pub(crate) fn set_open_hyperlink(&mut self, link: Option<HyperlinkId>) {
        self.open_hyperlink = link;
        self.sgr.hyperlink = link;
    }

    /// Push a raw code point from the VTE `print` callback through the
    /// charset and grapheme accumulator and write to the grid when a
    /// cluster completes.
    pub(crate) fn print_char(&mut self, c: char) {
        let c = self.charset.translate(c);
        // If we already have content and this char starts a new cluster,
        // flush and start fresh.
        if let Some((grapheme, width)) = self.grapheme_acc.push(c, self.classifier.as_ref()) {
            self.write_grapheme(grapheme, width);
        }
    }

    /// Flush the pending grapheme (called on every non-print event boundary
    /// + at end-of-feed).
    pub(crate) fn flush_grapheme(&mut self) {
        if let Some((grapheme, width)) = self.grapheme_acc.flush(self.classifier.as_ref()) {
            self.write_grapheme(grapheme, width);
        }
    }

    fn write_grapheme(&mut self, grapheme: Grapheme, width: CellWidth) {
        match width {
            CellWidth::Zero => {
                // Combining mark / ZWJ continuation — attach to the cell
                // at cursor-1, if any.
                if self.cursor.col > 0 {
                    let row = self.cursor.row as usize;
                    let col = (self.cursor.col - 1) as usize;
                    let buf = self.active_buffer_mut();
                    if let Some(r) = buf.rows.get_mut(row) {
                        if let Some(cell) = r.cells.get_mut(col) {
                            let mut new_g = cell.grapheme.as_str().to_owned();
                            new_g.push_str(grapheme.as_str());
                            cell.grapheme = Grapheme::from_str_infallible(&new_g);
                        }
                    }
                    self.bump_row_revision(self.cursor.row);
                }
            }
            CellWidth::One | CellWidth::Two => {
                // Wrap check.
                let needed = width.cells();
                let cols = self.cols;
                let autowrap = self.modes.is_set(DecMode::AutoWrap);
                let wrap =
                    self.classifier
                        .wrap_eligible(CellWidth::One, width, self.cursor.col, cols);
                if matches!(wrap, WrapEligibility::MustWrap) || self.cursor.pending_wrap {
                    if autowrap {
                        let row_idx = self.cursor.row as usize;
                        if let Some(r) = self.active_buffer_mut().rows.get_mut(row_idx) {
                            r.continuation = false;
                        }
                        self.carriage_return();
                        self.line_feed();
                        let row_idx = self.cursor.row as usize;
                        if let Some(r) = self.active_buffer_mut().rows.get_mut(row_idx) {
                            r.continuation = true;
                        }
                    } else {
                        // Clamp to last column without wrapping.
                        self.cursor.col = cols.saturating_sub(1);
                    }
                    self.cursor.pending_wrap = false;
                }

                // Stamp cell.
                let row_idx = self.cursor.row as usize;
                let col_idx = self.cursor.col as usize;
                let width_cells = width.cells();
                let sgr = self.sgr;
                let buf = self.active_buffer_mut();
                if let Some(r) = buf.rows.get_mut(row_idx) {
                    if let Some(cell) = r.cells.get_mut(col_idx) {
                        cell.grapheme = grapheme.clone();
                        cell.width = width;
                        sgr.stamp(cell);
                    }
                    if matches!(width, CellWidth::Two) {
                        if let Some(cont) = r.cells.get_mut(col_idx + 1) {
                            *cont = Cell::wide_continuation();
                            // Stamp colors onto continuation too so the
                            // background paints right.
                            cont.fg = sgr.fg;
                            cont.bg = sgr.bg;
                        }
                    }
                }
                self.bump_row_revision(self.cursor.row);
                let new_col = self.cursor.col.saturating_add(width_cells);
                if new_col >= cols {
                    self.cursor.col = cols.saturating_sub(1);
                    self.cursor.pending_wrap = autowrap;
                } else {
                    self.cursor.col = new_col;
                }
                self.cursor_changed = true;
                let _ = needed;
            }
        }
    }

    fn build_delta(&self) -> GridDelta {
        let mut row_deltas = Vec::new();
        let buf = self.active_buffer_ref();
        for (idx, dirty) in self.damage.row_dirty.iter().enumerate() {
            if !*dirty {
                continue;
            }
            let Some(row) = buf.rows.get(idx) else {
                continue;
            };
            let revision = buf.row_revisions.get(idx).copied().unwrap_or(0);
            let runs = encode_runs(&row.cells);
            row_deltas.push(RowDelta {
                row: idx as u16,
                revision,
                runs,
                continuation: row.continuation,
            });
        }
        GridDelta {
            row_deltas,
            rect_damage: self.damage.rects.clone(),
            scrollback_appended: self.damage.scrollback_appended,
        }
    }

    // ---------------------------------------------------------------------
    // Resize helpers.
    // ---------------------------------------------------------------------

    fn clip_or_pad_buffer(&mut self, kind: BufferKind, cols: u16) {
        let buf = match kind {
            BufferKind::Main => &mut self.main,
            BufferKind::Alt => &mut self.alt,
        };
        for row in &mut buf.rows {
            row.resize(cols);
        }
    }

    fn normalize_rows(&mut self, kind: BufferKind, rows: u16, cols: u16) {
        let buf = match kind {
            BufferKind::Main => &mut self.main,
            BufferKind::Alt => &mut self.alt,
        };
        if buf.rows.len() < rows as usize {
            let to_add = rows as usize - buf.rows.len();
            for _ in 0..to_add {
                buf.rows.push(Row::blank(cols));
                buf.row_revisions.push(1);
            }
        } else if buf.rows.len() > rows as usize {
            buf.rows.truncate(rows as usize);
            buf.row_revisions.truncate(rows as usize);
        }
        for row in &mut buf.rows {
            row.resize(cols);
        }
    }

    fn reflow_main(&mut self, cols_new: u16) {
        if cols_new == self.cols {
            return;
        }
        // Extract logical lines from main buffer.
        let logical_lines = extract_logical_lines(&self.main.rows);
        let (new_rows, _) = rewrap(logical_lines, cols_new, self.classifier.as_ref());
        self.main.rows = new_rows;
        self.main.row_revisions = vec![1u64; self.main.rows.len()];
    }
}

#[derive(Debug, Default, Clone)]
struct GraphemeAccumulator {
    buf: String,
}

impl GraphemeAccumulator {
    /// Push a character, returning `Some(grapheme, width)` if the PREVIOUS
    /// cluster is now confirmed complete. Caller writes that cluster and
    /// retains the new starter in the buffer.
    fn push(
        &mut self,
        c: char,
        classifier: &(dyn WidthClassifier + 'static),
    ) -> Option<(Grapheme, CellWidth)> {
        use unicode_segmentation::UnicodeSegmentation;

        // Append char.
        self.buf.push(c);

        // Fast path: if buf is a single ASCII char, it's one cluster.
        let graphemes: Vec<&str> = self.buf.graphemes(true).collect();
        if graphemes.len() <= 1 {
            return None;
        }

        // First `graphemes.len() - 1` clusters are complete; we flush the
        // first. Keep only the last cluster (current starter).
        let first: String = graphemes[0].to_owned();
        let tail: String = graphemes[1..].concat();
        self.buf = tail;
        let (g, w) = classifier.classify_grapheme(&first);
        Some((g, w))
    }

    /// Forced flush — called at stream boundaries and before every non-print
    /// event. Returns whatever is in the buffer.
    fn flush(
        &mut self,
        classifier: &(dyn WidthClassifier + 'static),
    ) -> Option<(Grapheme, CellWidth)> {
        if self.buf.is_empty() {
            return None;
        }
        let taken = std::mem::take(&mut self.buf);
        let (g, w) = classifier.classify_grapheme(&taken);
        Some((g, w))
    }
}

fn encode_runs(cells: &[Cell]) -> Vec<CellRun> {
    let mut runs: Vec<CellRun> = Vec::new();
    let mut current: Option<(u16, Vec<Cell>, &Cell)> = None;
    for (col, cell) in cells.iter().enumerate() {
        let col = col as u16;
        match &mut current {
            Some((_start, acc, last)) if attrs_match(last, cell) => acc.push(cell.clone()),
            _ => {
                if let Some((start, acc, _)) = current.take() {
                    runs.push(CellRun {
                        start_col: start,
                        cells: acc,
                    });
                }
                current = Some((col, vec![cell.clone()], cell));
            }
        }
    }
    if let Some((start, acc, _)) = current {
        runs.push(CellRun {
            start_col: start,
            cells: acc,
        });
    }
    runs
}

fn attrs_match(a: &Cell, b: &Cell) -> bool {
    a.fg == b.fg && a.bg == b.bg && a.attrs == b.attrs && a.hyperlink == b.hyperlink
}

struct LogicalLine {
    cells: Vec<Cell>,
    ended_with_newline: bool,
}

fn extract_logical_lines(rows: &[Row]) -> Vec<LogicalLine> {
    let mut out = Vec::new();
    let mut current: Vec<Cell> = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        if row.continuation && i > 0 {
            current.extend(trim_trailing_blank(&row.cells));
        } else {
            if !current.is_empty() {
                out.push(LogicalLine {
                    cells: std::mem::take(&mut current),
                    ended_with_newline: true,
                });
            }
            current = trim_trailing_blank(&row.cells);
        }
    }
    if !current.is_empty() {
        out.push(LogicalLine {
            cells: current,
            ended_with_newline: false,
        });
    }
    out
}

fn trim_trailing_blank(cells: &[Cell]) -> Vec<Cell> {
    let mut end = cells.len();
    while end > 0 {
        let c = &cells[end - 1];
        if c.is_blank() && c.fg == Color::Default && c.bg == Color::Default && c.attrs.is_empty() {
            end -= 1;
        } else {
            break;
        }
    }
    cells[..end].to_vec()
}

fn rewrap(
    lines: Vec<LogicalLine>,
    cols_new: u16,
    classifier: &(dyn WidthClassifier + 'static),
) -> (Vec<Row>, Vec<bool>) {
    let mut rows = Vec::new();
    let mut conts = Vec::new();
    if cols_new == 0 {
        return (rows, conts);
    }
    for line in lines {
        let mut col: u16 = 0;
        let mut buf: Vec<Cell> = Vec::new();
        let mut first = true;
        for cell in line.cells {
            // Skip wide-continuations; we regenerate them.
            if cell.is_wide_continuation() {
                continue;
            }
            let w = cell.width;
            let needed = w.cells();
            if col + needed > cols_new && !buf.is_empty() {
                // Close the row.
                while (buf.len() as u16) < cols_new {
                    buf.push(Cell::empty());
                }
                rows.push(Row {
                    cells: buf,
                    continuation: !first,
                });
                conts.push(!first);
                first = false;
                buf = Vec::new();
                col = 0;
            }
            buf.push(cell.clone());
            if matches!(w, CellWidth::Two) {
                buf.push(Cell::wide_continuation());
            }
            col += needed;
            // Also consult classifier to preserve NoBreakHint behavior for
            // zero-width combining marks (silence unused-arg compiler msg).
            let _ = classifier.wrap_eligible(CellWidth::One, w, col, cols_new);
        }
        // Close last row of this logical line.
        while (buf.len() as u16) < cols_new {
            buf.push(Cell::empty());
        }
        // Row carries the per-row continuation flag; `conts` is a parallel
        // projection for callers that only want the flag vec. Keep the two
        // in lockstep.
        let cont = !first && !line.ended_with_newline;
        rows.push(Row {
            cells: buf,
            continuation: cont,
        });
        conts.push(cont);
    }
    (rows, conts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use quanta_vt_width::{AmbiguousWidthPolicy, DefaultClassifier};

    fn make_grid(rows: u16, cols: u16) -> Grid {
        let cls: Arc<dyn WidthClassifier> =
            Arc::new(DefaultClassifier::new(AmbiguousWidthPolicy::Narrow));
        Grid::new(rows, cols, 1000, cls)
    }

    #[test]
    fn new_grid_has_expected_geometry() {
        let g = make_grid(24, 80);
        assert_eq!(g.rows(), 24);
        assert_eq!(g.cols(), 80);
        assert_eq!(g.active_buffer(), BufferKind::Main);
        assert_eq!(g.scrollback_len(), 0);
    }

    #[test]
    fn zero_geometry_clamps_to_one_by_one() {
        let g = make_grid(0, 0);
        assert_eq!(g.rows(), 1);
        assert_eq!(g.cols(), 1);
    }

    #[test]
    fn feed_single_char_places_cell() {
        let mut g = make_grid(3, 10);
        let _ = g.feed(b"a");
        assert_eq!(g.snapshot().cells[0][0].grapheme.as_str(), "a");
        assert_eq!(g.cursor().col, 1);
    }

    #[test]
    fn feed_crlf_advances_to_next_row_col_zero() {
        // LF alone is index-only (no column reset). CRLF clears col.
        let mut g = make_grid(3, 10);
        let _ = g.feed(b"a\r\nb");
        let snap = g.snapshot();
        assert_eq!(snap.cells[0][0].grapheme.as_str(), "a");
        assert_eq!(snap.cells[1][0].grapheme.as_str(), "b");
    }

    #[test]
    fn resize_emits_resize_and_snapshot() {
        let mut g = make_grid(3, 10);
        let out = g.resize(5, 15).expect("valid resize");
        assert!(out
            .iter()
            .any(|e| matches!(e, TerminalEvent::Resize { .. })));
        assert!(out
            .iter()
            .any(|e| matches!(e, TerminalEvent::GridSnapshot(_))));
        assert_eq!(g.rows(), 5);
        assert_eq!(g.cols(), 15);
    }

    #[test]
    fn resize_zero_is_rejected() {
        let mut g = make_grid(3, 10);
        assert!(matches!(
            g.resize(0, 10),
            Err(GridError::InvalidGeometry { .. })
        ));
    }

    #[test]
    fn epoch_starts_at_one_and_bumps() {
        let mut g = make_grid(3, 10);
        assert_eq!(g.epoch(), 1);
        g.reinit_epoch();
        assert_eq!(g.epoch(), 2);
    }

    #[test]
    fn sequence_monotonic() {
        let mut g = make_grid(3, 10);
        let a = g.next_sequence();
        let b = g.next_sequence();
        let c = g.next_sequence();
        assert!(a < b && b < c);
    }

    #[test]
    fn mode_snapshot_reflects_modes() {
        let mut g = make_grid(3, 10);
        let _ = g.feed(b"\x1b[?2004h");
        assert!(g.mode_snapshot().bracketed_paste);
    }
}
