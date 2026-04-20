# EPIC-E Design — Grid Integration (cell kinds + event stream + blob cache)

- **Status**: Design-ahead (Gear 3). Freezes the `ImageAnchor` / `ImageContinuation` cell kinds, the `ImageEmitted` / `ImagePlacementUpdated` / `ImageRemoved` event envelope, and the blob-cache on-disk layout.
- **Date**: 2026-04-20
- **Related**: RFC 0003 §7.3 (event envelope), §7.5 (grid model extension), §11 (storage), §13 (alt-screen + reflow), §14 (copy / selection / search / hit-test), EPIC-A (decoded-image hand-off), EPIC-B / C / D (payload providers), RFC 0001 §2 (grid-is-truth invariant), §4 (cell struct), §7 (event ordering), EPIC-B / C of RFC 0001 (Grid + Mirror), ADR 0019 / 0021.
- **Blocks**: EPIC-F (renderer consumes the cells + events frozen here).

One-paragraph read: EPIC-E is where the decoded RGBA becomes a cell. New cell kinds `ImageAnchor` and `ImageContinuation` extend the grid. New events `ImageEmitted` / `ImagePlacementUpdated` / `ImageRemoved` extend the reducer stream under the existing envelope ordering. A blob-cache layer bridges engine disk storage and UI IndexedDB via content-hash. Selection, copy, search, hit-test, reflow, and alt-screen all get image-aware rules that honor RFC 0001's grid invariants — semantic-width still wins, grapheme still wins, but an anchor cell occupies `h × w` cells that are non-text and non-searchable. This is the integration point that turns "we parsed some bytes" into "the user sees a picture anchored to row 12."

---

## 1. Summary

- **Goal**: Extend `quanta-vt::Grid` with image cells, wire `ImageDispatchQueue` → decoder → blob cache → `Grid`, emit the image events on the reducer stream, teach `GridMirror` to absorb the new cell kinds, and update selection/copy/search/hit-test/reflow semantics per RFC 0003 §13-14.
- **Phase**: 3 (per RFC 0003 §17).
- **Duration**: 1.5 weeks.
- **Dependencies**: EPIC-B, EPIC-C, EPIC-D shipped (all three parsers produce `RawImagePayload`). EPIC-A decoder crate stable. RFC 0001 EPIC-B `Grid` + EPIC-C `GridMirror` public APIs available.
- **Owner**: Grid / Protocol squad.

### 1.1 Contracts frozen

- `Cell::Image { anchor, ... }` variant + `ImageContinuation` variant.
- `ImageEmitted` / `ImagePlacementUpdated` / `ImageRemoved` event envelope.
- Blob-cache on-disk layout + IndexedDB schema.
- `ImageId`, `PlacementId`, `BlobRef` types.
- Reflow rules per protocol (`sixel:clip`, `iterm:scale`, `kitty:re-place`).
- Selection/copy/search rules for image cells.
- Scrollback eviction hook (decrement blob refcount on anchor eviction).

### 1.2 Contracts consumed

- `quanta_image_decoder::DecodedImage`.
- RFC 0001 EPIC-B `Grid::row(idx)`, `Grid::put_cell`, `Grid::buffer_kind`, `Grid::resize`.
- RFC 0001 EPIC-C `GridMirror::apply_*` series.
- RFC 0001 EPIC-B scrollback ring eviction callback.

---

## 2. Background

### 2.1 Why new cell kinds

RFC 0001's `Cell` is grapheme+width+attrs. An image doesn't fit that shape — it has no grapheme, no text attrs, and spans multiple cells. We add two variants:

- `ImageAnchor { image_id, placement_id, width_cells, height_cells }` at top-left.
- `ImageContinuation { anchor_row, anchor_col }` at every other cell in the span.

The rest of the grid logic only needs to know "is this cell an image thing?" via a helper predicate; it doesn't need to know the internals.

### 2.2 Why blob storage on disk

- Replay: the event stream stores `blob_ref: content_hash`, not the RGBA. Disk cache resolves.
- Memory: a terminal with 50 images at 800×600 RGBA = 96 MB; keeping them all in process RAM is wasteful.
- Reuse: same image emitted twice (same content hash) → one blob on disk, two events, two placements.

### 2.3 Why IndexedDB on UI

- Replay offline: UI can replay event log without the Rust engine.
- Cache warm: second browser load reuses decoded blobs without re-decoding.
- Storage API: IndexedDB gives us persistence + quota handling.

### 2.4 Why the reflow rules are protocol-specific

Sixel was designed when terminals didn't resize; the natural behavior is clip. iTerm added `preserveAspectRatio` explicitly. Kitty has explicit placement coordinates. Honoring each protocol's intent is better UX than forcing one uniform rule.

---

## 3. Scope

### 3.1 Files

| File | Purpose |
|------|---------|
| `crates/quanta-vt/src/grid/cell.rs` | Updated. Add `Cell::ImageAnchor`, `Cell::ImageContinuation`. |
| `crates/quanta-vt/src/grid/image_ops.rs` | New. `place_image`, `remove_image`, `reflow_image_for_resize`, eviction callback. |
| `crates/quanta-vt/src/grid/scrollback.rs` | Updated. Eviction hook decrements blob refcount. |
| `crates/quanta-vt/src/grid/selection_scope.rs` | Updated. Image cell selection rules. |
| `crates/quanta-vt/src/grid/reflow.rs` | Updated. Per-protocol reflow dispatch. |
| `crates/quanta-vt/src/image_cache.rs` | New. Disk-backed blob cache (content-hash keyed). |
| `crates/quanta-vt/src/image_dispatch.rs` | Updated. Finalize `RawImagePayload → DecodedImage → place_image` pipeline. |
| `crates/quanta-proto/src/events/image.rs` | New. `ImageEmitted`, `ImagePlacementUpdated`, `ImageRemoved` event types + serde. |
| `crates/quanta-proto/src/types.rs` | Updated. `ImageId`, `PlacementId`, `BlobRef`. |
| `packages/ui/src/shared/lib/grid-mirror/GridMirror.ts` | Updated. Absorb image cell kinds; emit image events on `onChange`. |
| `packages/ui/src/shared/lib/grid-mirror/image-cells.ts` | New. Image-aware grid mirror helpers. |
| `packages/ui/src/shared/lib/image-cache/indexeddb.ts` | New. IndexedDB schema + LRU. |
| `packages/ui/src/shared/lib/image-cache/fetch.ts` | New. Tauri-command blob fetch. |
| `packages/ui/src/shared/lib/grid-mirror/__tests__/image-cells.test.ts` | Image cell round-trip tests. |
| `packages/ui/src/shared/lib/image-cache/__tests__/indexeddb.test.ts` | IndexedDB schema tests. |
| `crates/quanta-vt/tests/image_grid_integration.rs` | End-to-end: payload → decode → place → event. |
| `crates/quanta-vt/tests/image_reflow.rs` | Per-protocol reflow scenarios. |
| `crates/quanta-vt/tests/image_scrollback_eviction.rs` | Eviction decrements refcount. |
| `crates/quanta-vt/tests/image_alt_screen.rs` | Alt-enter/exit scoping. |
| `docs/adr/0019-image-event-envelope.md` | Accepted here. |
| `docs/adr/0021-image-anchor-cell-semantics.md` | Accepted here. |

### 3.2 Out of scope

- Rendering (EPIC-F).
- Per-protocol parsing (EPIC-B / C / D).
- Decoding (EPIC-A).
- OSC52 clipboard copy of image bytes — surfaced by EPIC-F.

---

## 4. Design

### 4.1 Cell variants

```rust
// crates/quanta-vt/src/grid/cell.rs

pub enum Cell {
    Text(TextCell),                     // existing
    ImageAnchor {
        image_id: ImageId,
        placement_id: PlacementId,
        width_cells: u16,
        height_cells: u16,
        z_index: i32,
    },
    ImageContinuation {
        anchor_row: u32,
        anchor_col: u16,
    },
    // existing: Empty, RightHalf (wide-char cont), etc.
}
```

Helper:

```rust
impl Cell {
    pub fn is_image(&self) -> bool { matches!(self, Self::ImageAnchor { .. } | Self::ImageContinuation { .. }) }
    pub fn is_anchor(&self) -> bool { matches!(self, Self::ImageAnchor { .. }) }
    pub fn anchor_address(&self) -> Option<(u32, u16)> { /* continuation → anchor address; anchor → self address */ }
}
```

### 4.2 Event envelope

```rust
// crates/quanta-proto/src/events/image.rs

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImageEmitted {
    pub grid_epoch: u64,
    pub sequence_no: u64,
    pub resize_generation: u64,
    pub buffer_kind: BufferKind,

    pub image_id: ImageId,
    pub placement_id: PlacementId,
    pub protocol: Protocol,
    pub mime: Mime,
    pub width_px: u32,
    pub height_px: u32,
    pub width_cells: u16,
    pub height_cells: u16,
    pub anchor: CellAnchor,
    pub blob_ref: BlobRef,
    pub hints: ImageHints,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImagePlacementUpdated {
    pub grid_epoch: u64,
    pub sequence_no: u64,
    pub resize_generation: u64,
    pub buffer_kind: BufferKind,

    pub image_id: ImageId,
    pub placement_id: PlacementId,
    pub anchor: CellAnchor,
    pub z_index: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImageRemoved {
    pub grid_epoch: u64,
    pub sequence_no: u64,
    pub resize_generation: u64,
    pub buffer_kind: BufferKind,

    pub image_id: ImageId,
    pub placement_id: Option<PlacementId>,
    pub reason: RemoveReason,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub enum RemoveReason {
    ExplicitDelete,
    OverwrittenByText,
    ScrollbackEvicted,
    AltBufferExit,
    SessionEnd,
}
```

All three events inherit the envelope contract (`grid_epoch`, `sequence_no`, `resize_generation`) from RFC 0001.

### 4.3 Blob cache

```rust
// crates/quanta-vt/src/image_cache.rs

pub struct BlobCache {
    root: PathBuf,                       // $APP_CONFIG_DIR/images/<session_id>/
    lru: lru::LruCache<[u8; 16], CacheEntry>,
    max_bytes: u64,                      // 256 MB default.
    current_bytes: u64,
}

struct CacheEntry {
    content_hash: [u8; 16],
    size_bytes: u64,
    ref_count: u32,
    on_disk: bool,
}

impl BlobCache {
    pub fn insert(&mut self, hash: [u8; 16], rgba: &[u8], meta: &BlobMeta) -> Result<BlobRef, CacheError>;
    pub fn acquire(&mut self, hash: [u8; 16]) -> Option<BlobHandle>;
    pub fn release(&mut self, hash: [u8; 16]);  // decrement refcount; evict if 0 + cap pressure.
    pub fn read(&self, hash: [u8; 16]) -> Result<Bytes, CacheError>;
}

pub struct BlobRef {
    pub content_hash: [u8; 16],
    pub size_bytes: u64,
    pub session_id: SessionId,
}
```

Disk layout:
```
$APP_CONFIG_DIR/images/<session_id>/
├── <hash>.rgba        # raw RGBA, width*height*4 bytes
├── <hash>.meta.json   # { mime, width_px, height_px, created_at, source_protocol }
└── <hash>.src         # optional: original protocol bytes, for re-decode on cache miss
```

### 4.4 Placement pipeline

```rust
// crates/quanta-vt/src/image_dispatch.rs

impl ImageDispatchWorker {
    pub fn on_raw_payload(&mut self, raw: RawImagePayload) {
        // 1. Cache lookup first (if payload is deterministic, skip decode).
        let hash_hint = raw.hash_hint();
        if let Some(handle) = self.cache.acquire(hash_hint) {
            self.place_from_cache(&raw, handle);
            return;
        }

        // 2. Off-thread decode.
        let limits = self.decoder_limits;
        let raw_clone = raw.clone();
        let tx = self.result_tx.clone();
        self.pool.spawn(move || {
            let decoded = quanta_image_decoder::decode(
                raw_clone.protocol,
                &raw_clone.bytes,
                &raw_clone.params,
                &limits,
            );
            tx.send((raw_clone, decoded)).ok();
        });
    }

    pub fn on_decode_result(&mut self, raw: RawImagePayload, result: Result<DecodedImage, DecodeError>) {
        match result {
            Ok(decoded) => {
                let blob_ref = self.cache.insert(decoded.content_hash, &decoded.rgba, &meta).unwrap_or_else(|_| self.placeholder_ref());
                let anchor = self.compute_anchor(&raw, &decoded);
                self.grid.place_image(&decoded, anchor, &raw.params);
                self.emit_event(ImageEmitted { /* ... */ });
            }
            Err(err) => {
                hooks::count_decode_error(raw.protocol, &err.kind);
                let placeholder = self.placeholder_ref_for_reason(&err);
                let anchor = self.compute_anchor_placeholder(&raw);
                self.grid.place_image_placeholder(anchor, &raw.params);
                self.emit_event(ImageEmitted { /* mime=placeholder */ });
            }
        }
    }
}
```

### 4.5 `Grid::place_image`

```rust
// crates/quanta-vt/src/grid/image_ops.rs

impl Grid {
    pub fn place_image(
        &mut self,
        decoded: &DecodedImage,
        anchor: CellAnchor,
        params: &AdapterParams,
    ) -> Result<ImageId, PlaceError> {
        let (w_cells, h_cells) = compute_cell_span(decoded, params, &self.metrics);
        let anchor_cell = Cell::ImageAnchor {
            image_id: self.next_image_id(),
            placement_id: self.next_placement_id(),
            width_cells: w_cells,
            height_cells: h_cells,
            z_index: params.z_index(),
        };
        self.put_cell(anchor.row, anchor.col, anchor_cell)?;
        for dr in 0..h_cells {
            for dc in 0..w_cells {
                if dr == 0 && dc == 0 { continue; }
                self.put_cell(anchor.row + dr as u32, anchor.col + dc, Cell::ImageContinuation { anchor_row: anchor.row, anchor_col: anchor.col })?;
            }
        }
        // Any existing text under the span emits ImageRemoved { reason: OverwrittenByText } for displaced images.
        Ok(image_id)
    }
}
```

### 4.6 Reflow rules

```rust
// crates/quanta-vt/src/grid/reflow.rs

pub fn reflow_images_for_resize(grid: &mut Grid, old_cols: u16, new_cols: u16) {
    for (image_id, placement) in grid.placements_snapshot() {
        match placement.protocol {
            Protocol::Sixel => {
                // Clip on shrink; no-op on grow.
                if placement.width_cells > new_cols {
                    grid.clip_image_to_width(image_id, new_cols);
                }
            }
            Protocol::Iterm if placement.hints.preserve_aspect_ratio => {
                // Rescale display dims; blob unchanged.
                let new_w = std::cmp::min(placement.width_cells, new_cols);
                let scale = new_w as f32 / placement.width_cells as f32;
                let new_h = (placement.height_cells as f32 * scale).round() as u16;
                grid.resize_image_cells(image_id, new_w, new_h);
            }
            Protocol::Iterm => { /* clip */ }
            Protocol::Kitty => {
                // Re-run placement computation using r=/c= + source crop.
                grid.recompute_kitty_placement(image_id, new_cols);
            }
        }
    }
}
```

### 4.7 Selection / copy / search / hit-test

```rust
// crates/quanta-vt/src/grid/selection_scope.rs

impl SelectionScope {
    /// Selection expanding across an image cell treats the whole anchor span as a unit.
    pub fn expand_over_image(anchor: &ImageAnchorRef, sel: &mut Selection) { /* ... */ }

    /// Copy serializes images as `[image:<mime>]` tokens.
    pub fn copy_image_token(mime: Mime) -> String {
        format!("[image:{}]", mime_short(mime))
    }

    /// Search skips image cells entirely.
    pub fn is_searchable(cell: &Cell) -> bool { !cell.is_image() }

    /// Hit-test inside image span returns the anchor coords.
    pub fn hit_test_image(anchor: &ImageAnchorRef, row: u32, col: u16) -> (u32, u16) {
        (anchor.anchor_row, anchor.anchor_col)
    }
}
```

### 4.8 Alt-screen scoping

Images placed while `buffer_kind == Alt` are stored in the alt-buffer's placement map. On alt-exit, all alt-buffer placements emit `ImageRemoved { reason: AltBufferExit }`. Main-buffer placements persist.

### 4.9 Scrollback eviction

Hook registered in `scrollback.rs`:

```rust
impl Scrollback {
    fn evict_row(&mut self, row_idx: u32, callbacks: &EvictCallbacks) {
        for cell in self.row(row_idx).cells() {
            if let Cell::ImageAnchor { image_id, placement_id, .. } = cell {
                callbacks.on_image_evicted(image_id, placement_id);
            }
        }
        // ...
    }
}
```

`on_image_evicted` → `BlobCache::release(hash)` → if refcount 0 and under cap, disk file retained (LRU); if over cap, delete.

### 4.10 UI side — GridMirror + IndexedDB

```ts
// packages/ui/src/shared/lib/grid-mirror/image-cells.ts

export interface ImageAnchorCell {
  kind: 'image-anchor';
  imageId: string;
  placementId: string;
  widthCells: number;
  heightCells: number;
  zIndex: number;
}

export interface ImageContinuationCell {
  kind: 'image-continuation';
  anchorRow: number;
  anchorCol: number;
}
```

```ts
// packages/ui/src/shared/lib/image-cache/indexeddb.ts

export interface StoredImage {
  contentHash: string;
  rgba: Blob;
  mime: string;
  widthPx: number;
  heightPx: number;
  lastAccessMs: number;
  sessionId: string;
}

export class ImageIndexedDbCache {
  constructor(readonly dbName = 'quanta-images', readonly maxBytes = 128 * 1024 * 1024) {}
  async get(contentHash: string): Promise<StoredImage | null>;
  async put(image: StoredImage): Promise<void>;
  async evictLru(): Promise<void>;
}
```

---

## 5. Definition of Done

1. `Cell::ImageAnchor` + `Cell::ImageContinuation` variants exist + serialize.
2. `ImageId`, `PlacementId`, `BlobRef` types in `quanta-proto`.
3. `ImageEmitted` / `ImagePlacementUpdated` / `ImageRemoved` events defined + serde round-trip.
4. All three events honor `(grid_epoch, sequence_no, resize_generation, buffer_kind)` envelope.
5. `BlobCache` on-disk layout matches RFC 0003 §11.1.
6. Cache LRU evicts at `max_bytes`.
7. Cache-hit path skips decode entirely.
8. `Grid::place_image` places anchor + continuation cells correctly.
9. Overwriting text into image cells emits `ImageRemoved { reason: OverwrittenByText }`.
10. Overwriting image into text cells preserves text history (text overwrite is one-way by grid semantics).
11. Selection across image span treats image as atomic unit.
12. Copy produces `[image:<mime>]` token inside text stream.
13. Search skips image cells.
14. Hit-test inside image span returns anchor address.
15. Alt-enter places images on alt buffer; alt-exit emits `ImageRemoved { reason: AltBufferExit }` for alt-buffer placements; main-buffer unchanged.
16. Scrollback eviction of a row containing an anchor decrements refcount + emits `ImageRemoved { reason: ScrollbackEvicted }`.
17. Resize shrink: sixel clips, iTerm scales (if `preserveAspectRatio`) or clips, kitty re-places.
18. GridMirror (TS) absorbs image cells + image events.
19. IndexedDB cache schema works in Chrome + Safari + Firefox.
20. IndexedDB LRU eviction triggers at `maxBytes`.
21. Tauri command `get_image_blob(session_id, content_hash)` wired for UI fetch.
22. 20+ integration fixtures: payload → decode → place → event → mirror match.
23. ADR 0019 (event envelope) accepted + merged.
24. ADR 0021 (anchor cell semantics) accepted + merged.
25. CI grep rule `check-images-no-raw-escape-in-grid` green — image bytes never appear in grid outside anchor+continuation variants.

---

## 6. Quality Gates

- **Gate-1 — Round-trip parity.** Payload → decode → place → serialize event → deserialize → mirror absorb → Cell kinds match byte-identically.
- **Gate-2 — Reflow correctness.** 5 resize scenarios per protocol produce expected cell layouts.
- **Gate-3 — Scrollback eviction emits event.** Eviction test observes `ImageRemoved { reason: ScrollbackEvicted }`.
- **Gate-4 — Alt-screen scoping.** Alt-exit emits `ImageRemoved` for every alt placement; main buffer unchanged.
- **Gate-5 — IndexedDB cache hit.** Same content-hash on page reload loads from IndexedDB, not refetch.
- **Gate-6 — Copy token.** Selection across image produces `[image:<mime>]` in copied text, verified cross-browser.
- **Gate-7 — Hit-test consistency.** Click anywhere in image span returns anchor cell coords.

---

## 7. E2E tests (≥ 5)

1. **E2E-E1 — Full-stack sixel image.** `chafa image.png` emits sixel; parser + decoder + grid place; event stream observed; UI mirror shows anchor + continuations.
2. **E2E-E2 — Full-stack iTerm image.** `imgcat image.png` → anchor placed; selection around anchor → copy yields `[image:png]`.
3. **E2E-E3 — Full-stack kitty chunked image.** `kitten icat bigger.png` sends 5 chunks; assembler reassembles; anchor placed at cursor; UI mirror sees events in order.
4. **E2E-E4 — Alt-screen enter/exit.** `less image-preview-program` pushes to alt; images placed; exit less → images removed from alt mirror; main unchanged.
5. **E2E-E5 — Scrollback eviction.** Scroll 10k rows past an image anchor; scrollback ring evicts it; `ImageRemoved` event observed; blob refcount → 0; disk entry remains cache-hot.
6. **E2E-E6 — Resize shrink with mixed protocols.** 3 images (one per protocol) on screen; shrink cols by 10; sixel clips, iTerm scales, kitty re-places — all correct per §4.6.
7. **E2E-E7 — IndexedDB replay.** Record session with 5 images → close page → reopen → replay → all images shown from IndexedDB cache without refetch.

---

## 8. Tests

### 8.1 Unit

- `Cell::is_image` / `is_anchor` / `anchor_address` — exhaustive.
- `compute_cell_span` with each `DimSpec` variant.
- `BlobCache::insert` / `acquire` / `release` — refcount semantics.
- `BlobCache::evict_lru` — cap boundary.
- `reflow_images_for_resize` — per-protocol branch coverage.
- `GridMirror.applyImageEvent` — cell kinds absorbed.

### 8.2 Integration

- `tests/image_grid_integration.rs` — 20+ payload → cell scenarios.
- `tests/image_reflow.rs` — 15 resize scenarios.
- `tests/image_scrollback_eviction.rs` — 5 eviction scenarios.
- `tests/image_alt_screen.rs` — 10 alt-buffer scenarios.

### 8.3 UI tests

- `image-cells.test.ts` — mirror absorbs events.
- `indexeddb.test.ts` — schema + LRU + cross-browser.
- E2E: existing e2e harness + `image.e2e.test.tsx` (new) covering E2E-E1 through E2E-E7.

---

## 9. Failure modes

- **F-E1 — Decode returns error mid-dispatch.** Defense: placeholder cell placed; event emitted with `mime=placeholder`; user sees reason tooltip.
- **F-E2 — Anchor off-screen.** Defense: anchor clamped to grid bounds; continuation cells clipped.
- **F-E3 — Multiple images at same anchor (race).** Defense: grid is single-owner; second `place_image` emits `ImageRemoved` for first then places second.
- **F-E4 — Text write into image span.** Defense: first text write emits `ImageRemoved { reason: OverwrittenByText }`; rest of span cleared to Empty.
- **F-E5 — Resize to 0 cols.** Defense: collapse all images to 1×1 placeholder; protocol hints preserved for future resize.
- **F-E6 — Scrollback evicts middle of image span (anchor still alive).** Defense: impossible by design — entire image span is contiguous rows; eviction operates at row granularity; if anchor row evicted, all continuations are already in evicted rows too.
- **F-E7 — BlobCache eviction during active placement.** Defense: refcount prevents eviction; eviction only applies to zero-refcount blobs.
- **F-E8 — BlobCache disk full.** Defense: insert returns error; placeholder placed.
- **F-E9 — IndexedDB quota denied.** Defense: fall back to in-memory LRU with small cap + banner.
- **F-E10 — Event ordering swap (Remove before Emitted).** Defense: events share the RFC 0001 envelope; reducer enforces order; out-of-order drop + telemetry.
- **F-E11 — Session cleanup leaves orphan blobs.** Defense: session-end hook deletes the session image dir.
- **F-E12 — UI receives Emitted but blob fetch 404s.** Defense: placeholder renders + banner "image payload unavailable".
- **F-E13 — Image spans rows across alt/main boundary.** Defense: images belong to exactly one buffer kind at place time; cannot span both.
- **F-E14 — Placement ID collision across sessions.** Defense: ID space is per-session; replay starts new id space.
- **F-E15 — Wide-char cell adjacent to image.** Defense: width SSOT still applies; wide-char right-half not placed inside image span.

---

## 10. Risks

- **R-E1 — Integration with scrollback reflow.** Mitigation: fixtures cover many reflow-with-image scenarios; manual QA on `tmux` + `vim` interactions.
- **R-E2 — Event-stream backpressure.** Mitigation: images generate 1 event per placement, not per byte; negligible relative to text events.
- **R-E3 — IndexedDB quirks (Safari private mode).** Mitigation: feature-detect + in-memory fallback.
- **R-E4 — Cross-protocol reflow parity regressions.** Mitigation: per-protocol visual-regression fixtures in UI e2e.
- **R-E5 — Session-end race with pending decodes.** Mitigation: worker pool drained on session close; pending decodes dropped.

---

## 11. Rollback

- Cell variants remain in enum (can't remove after wire-format freeze) but emit can be gated.
- Event emission gated behind flag; with flag off, no events → UI mirror sees no image cells.
- BlobCache compiled but inert.
- Reflow branches guard against empty placements map — safe when disabled.

---

## 12. Cross-refs

- RFC 0003 §7.3 — event envelope.
- RFC 0003 §7.5 — grid model extension.
- RFC 0003 §11 — storage layout.
- RFC 0003 §13 — alt-screen + reflow.
- RFC 0003 §14 — copy / selection / search / hit-test.
- EPIC-A — `DecodedImage` consumed here.
- EPIC-B / C / D — `RawImagePayload` producers.
- EPIC-F — renderer consumes events + cells.
- RFC 0001 §2 — invariants (I-3 grid-is-truth upheld; images owned by grid).
- RFC 0001 §7 — event envelope (inherited).
- ADR 0019 / 0021 — spawned + accepted here.

---

## 13. Day-by-day

### Week 1

- **Mon** — `Cell` variants + `ImageId` / `PlacementId` / `BlobRef` types. Unit tests.
- **Tue** — `BlobCache` + tests. On-disk layout verified on macOS + Linux.
- **Wed** — `Grid::place_image` + overwrite semantics. 5 fixture integration tests green.
- **Thu** — Event envelope + serde round-trip. `ImageDispatchWorker` orchestration.
- **Fri** — Alt-screen scoping + scrollback eviction hook. 10 fixtures green.

### Week 2

- **Mon** — Reflow rules per protocol. 15 reflow fixtures.
- **Tue** — Selection / copy / search / hit-test rules.
- **Wed** — GridMirror (TS) image absorption + unit tests.
- **Thu** — IndexedDB cache + cross-browser test matrix.

### Week 2.5

- **Mon** — E2E: E2E-E1 through E2E-E7 green.
- **Tue** — ADR 0019 + 0021 accepted + merged; docs + CI grep rule. EPIC-F unblocked.

---

End of EPIC-E design.
