# EPIC-F Design — Renderer Integration (Canvas2D drawImage + WebGL texture hook)

- **Status**: Design-ahead (Gear 3). Extends the `BackendContract` (RFC 0001 §12, RFC 0001 EPIC-D) with `drawImage` / `removeImage` / `onImageLoaded`. Ships the Canvas2D implementation; provides a WebGL stub that RFC 0002 wires in when its backend lands.
- **Date**: 2026-04-20
- **Related**: RFC 0003 §7.4 (renderer contract extension), §12.3 (texture upload strategy), §14 (hit-test + copy actions), §15 (fallback rendering), RFC 0001 §12 (backend contract), EPIC-E (grid events + cells), EPIC-D of RFC 0001 (existing Canvas2D backend), RFC 0002 (WebGL follow-up).
- **Blocks**: v1 flag-flip to `stripped-placeholder` (requires render path shipped).

One-paragraph read: EPIC-F is where events and cells become pixels. The Canvas2D backend gains an image layer beneath the cursor layer; `drawImage(imageId, anchor, cellSpan, opts)` blits the decoded RGBA as a composited rect. The WebGL backend (RFC 0002) gets a texture-atlas page per image with the same interface. `onImageLoaded` fires per-blob so the renderer can defer actual paint until bytes land. Placeholder rendering for failure modes (decode error, cap exceeded, blob missing) is opinionated — a muted gray rect with a centered picture icon and an accessible label. The "copy image" menu action lives here; it packs the blob into a platform clipboard payload.

---

## 1. Summary

- **Goal**: Extend `BackendContract` with `drawImage`, `removeImage`, `onImageLoaded`; implement Canvas2D path; stub WebGL path for RFC 0002; ship placeholder rendering; wire IndexedDB cache fetch; wire "copy image" menu action.
- **Phase**: 4 (per RFC 0003 §17).
- **Duration**: 1.5 weeks.
- **Dependencies**: EPIC-E shipped (cells + events on GridMirror). RFC 0001 EPIC-D Canvas2D backend shipped.
- **Owner**: Renderer / UX squad.

### 1.1 Contracts frozen

- `BackendContract.drawImage` / `.removeImage` / `.onImageLoaded` signatures.
- `ImageBlobSource` interface (Canvas2D fetch strategy).
- Placeholder rendering visual spec.
- `copyImageToClipboard(imageId)` action.
- IndexedDB read API consumed by renderer.

### 1.2 Contracts consumed

- EPIC-E `GridMirror` image-cell events.
- EPIC-E IndexedDB cache API (`ImageIndexedDbCache`).
- EPIC-E Tauri command `get_image_blob`.
- RFC 0001 EPIC-D `Canvas2DBackend` mount/unmount lifecycle.

---

## 2. Background

### 2.1 Why images paint on a separate layer

- DPI/DPR correctness — image source is in absolute pixels, not cell-aligned; compositing under text is cleaner.
- Damage tracking — image changes are rare vs text changes; separate layer means no full-row repaint when one image loads.
- Z-order — kitty's z-index works cleanly when images are their own layer.
- Performance — Canvas2D `drawImage` with a cached `ImageBitmap` is fast; no need to re-blit per text delta.

### 2.2 Why `onImageLoaded` is asynchronous

Blob fetch (from IndexedDB or Tauri command) is async. The mirror sees `ImageEmitted` before the bytes are available. The renderer can either (a) block paint until load, or (b) paint a loading placeholder and swap when ready. We pick (b) — no black screen.

### 2.3 Why placeholder visuals matter

Failure modes (decode panic, size cap, 404) happen often enough in the wild that the placeholder is the *public-facing UI* in many scenarios. Ugly placeholder = visibly broken terminal. We spec it carefully.

---

## 3. Scope

### 3.1 Files

| File | Purpose |
|------|---------|
| `packages/ui/src/shared/ui/cell-renderer/backend/BackendContract.ts` | Updated. Add `drawImage`, `removeImage`, `onImageLoaded`. |
| `packages/ui/src/shared/ui/cell-renderer/backend/Canvas2DBackend.ts` | Updated. Image layer + `drawImage` impl. |
| `packages/ui/src/shared/ui/cell-renderer/backend/MemoryBackend.ts` | Updated. No-op `drawImage` for parity tests. |
| `packages/ui/src/shared/ui/cell-renderer/ImageLayer.ts` | New. Canvas2D image-layer manager (one `<canvas>` beneath cursor). |
| `packages/ui/src/shared/ui/cell-renderer/ImageBlobSource.ts` | New. Fetch abstraction over IndexedDB + Tauri command. |
| `packages/ui/src/shared/ui/cell-renderer/Placeholder.ts` | New. Placeholder rendering. |
| `packages/ui/src/shared/ui/cell-renderer/types.ts` | Updated. Add image-related types. |
| `packages/ui/src/features/image/copy-image.ts` | New. `copyImageToClipboard` action. |
| `packages/ui/src/features/image/save-image-as.ts` | New. Save-as action (v1.1 minimally; v1 stub). |
| `packages/ui/src/features/image/index.ts` | Barrel. |
| `packages/ui/src/widgets/terminal-canvas/TerminalCanvas.tsx` | Updated. Mount image layer; wire context-menu actions. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/image-layer.test.tsx` | New. Image layer lifecycle. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/image-placeholder.test.tsx` | New. Placeholder visual regression. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/copy-image.test.tsx` | New. Copy-image action test. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/fixtures/images/` | Test fixtures: decoded blobs + golden PNG output. |
| `packages/ui/src/__tests__/e2e/inline-image-render.e2e.test.tsx` | New. Full-stack e2e: chafa + imgcat + kitten icat render. |
| `crates/quanta-vt/src/ipc/get_image_blob.rs` | New. Tauri command handler. |

### 3.2 Out of scope

- WebGL implementation (RFC 0002).
- Animation playback (v2 per RFC 0003 §6).
- OCR / text extraction from images (out of scope).
- Editing / overlays on images (out of scope).
- Alt-text rich interactions (v1.1).

---

## 4. Design

### 4.1 Contract extension

```ts
// packages/ui/src/shared/ui/cell-renderer/backend/BackendContract.ts
// (additions only)

export interface BackendContract {
  // ... existing methods ...

  /**
   * Draw an image at the given cell anchor + span. Idempotent for the same
   * (imageId, placementId). If the image is not yet loaded (bytes not in
   * ImageBlobSource), the backend schedules a placeholder draw and repaints
   * when onImageLoaded fires.
   */
  drawImage(
    imageId: string,
    placementId: string,
    anchor: { row: number; col: number },
    cellSpan: { rows: number; cols: number },
    opts: ImageDrawOptions,
  ): void;

  /**
   * Remove an image placement. Idempotent.
   */
  removeImage(imageId: string, placementId?: string): void;

  /**
   * Notify the backend that a blob is now available. Backend may repaint
   * any pending placements that reference this blob.
   */
  onImageLoaded(contentHash: string, bitmap: ImageBitmap): void;
}

export interface ImageDrawOptions {
  preserveAspectRatio: boolean;
  zIndex: number;
  opacity: number;          // 0.0 — 1.0; default 1.0.
  srcCrop?: { x: number; y: number; w: number; h: number };  // kitty source crop.
  contentHash: string;      // used by onImageLoaded matching.
  mime: string;             // drives placeholder look when bytes absent.
}
```

### 4.2 Canvas2D image layer

```ts
// packages/ui/src/shared/ui/cell-renderer/ImageLayer.ts

export class ImageLayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  // Active placements keyed by (imageId, placementId).
  private placements = new Map<string, Placement>();
  // Pending placements (bytes not yet loaded).
  private pending = new Map<string, Placement>();
  // Bitmaps keyed by content hash.
  private bitmaps = new Map<string, ImageBitmap>();

  constructor(private metrics: CellMetrics, private blobSource: ImageBlobSource) {
    // ... create canvas element at container + mount ...
  }

  place(imageId: string, placementId: string, anchor: CellPos, span: CellSpan, opts: ImageDrawOptions): void {
    const key = `${imageId}:${placementId}`;
    this.placements.set(key, { imageId, placementId, anchor, span, opts });
    const bitmap = this.bitmaps.get(opts.contentHash);
    if (bitmap) {
      this.paintPlacement(key, bitmap);
    } else {
      this.paintPlaceholder(key);
      this.pending.set(key, { imageId, placementId, anchor, span, opts });
      this.blobSource.fetch(opts.contentHash).then(bitmap => {
        if (!bitmap) return;
        this.bitmaps.set(opts.contentHash, bitmap);
        this.pending.delete(key);
        this.paintPlacement(key, bitmap);
      });
    }
  }

  remove(imageId: string, placementId?: string): void {
    if (placementId) {
      const key = `${imageId}:${placementId}`;
      this.placements.delete(key);
      this.pending.delete(key);
      this.erasePlacement(key);
    } else {
      for (const key of [...this.placements.keys()]) {
        if (key.startsWith(`${imageId}:`)) this.remove(imageId, key.split(':')[1]);
      }
    }
  }

  private paintPlacement(key: string, bitmap: ImageBitmap): void {
    const p = this.placements.get(key); if (!p) return;
    const { x, y, w, h } = this.cellSpanToPx(p.anchor, p.span);
    this.ctx.save();
    this.ctx.globalAlpha = p.opts.opacity;
    if (p.opts.srcCrop) {
      const c = p.opts.srcCrop;
      this.ctx.drawImage(bitmap, c.x, c.y, c.w, c.h, x, y, w, h);
    } else {
      this.ctx.drawImage(bitmap, x, y, w, h);
    }
    this.ctx.restore();
  }

  private paintPlaceholder(key: string): void {
    const p = this.placements.get(key); if (!p) return;
    Placeholder.draw(this.ctx, p, this.metrics);
  }

  private erasePlacement(key: string): void { /* clear rect + repaint overlapping */ }

  private cellSpanToPx(anchor: CellPos, span: CellSpan): { x: number; y: number; w: number; h: number } {
    return {
      x: anchor.col * this.metrics.cellWidthPx,
      y: anchor.row * this.metrics.cellHeightPx,
      w: span.cols * this.metrics.cellWidthPx,
      h: span.rows * this.metrics.cellHeightPx,
    };
  }

  repaintAll(): void { /* DPR change / metrics change */ }
  dispose(): void { /* ... */ }
}
```

### 4.3 `ImageBlobSource`

```ts
// packages/ui/src/shared/ui/cell-renderer/ImageBlobSource.ts

export interface ImageBlobSource {
  fetch(contentHash: string): Promise<ImageBitmap | null>;
}

export class CompositeBlobSource implements ImageBlobSource {
  constructor(
    private indexedDb: ImageIndexedDbCache,
    private tauriCommand: (hash: string) => Promise<Blob | null>,
  ) {}

  async fetch(contentHash: string): Promise<ImageBitmap | null> {
    // 1. IndexedDB cache.
    const stored = await this.indexedDb.get(contentHash);
    if (stored) {
      stored.lastAccessMs = Date.now();
      await this.indexedDb.touch(contentHash, stored.lastAccessMs);
      return createImageBitmap(stored.rgba);
    }
    // 2. Tauri command (fetch from engine).
    const blob = await this.tauriCommand(contentHash);
    if (!blob) return null;
    await this.indexedDb.put({ contentHash, rgba: blob, /* ...meta... */ } as StoredImage);
    return createImageBitmap(blob);
  }
}
```

### 4.4 Placeholder rendering

```ts
// packages/ui/src/shared/ui/cell-renderer/Placeholder.ts

export const Placeholder = {
  draw(ctx: CanvasRenderingContext2D, p: Placement, metrics: CellMetrics): void {
    const { x, y, w, h } = spanToRect(p.anchor, p.span, metrics);
    // Background rect (muted gray).
    ctx.fillStyle = 'rgba(128, 128, 128, 0.25)';
    ctx.fillRect(x, y, w, h);
    // Border.
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.75)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    // Centered icon (Unicode picture frame).
    ctx.font = `${Math.min(24, Math.min(w, h) * 0.4)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(128, 128, 128, 1)';
    ctx.fillText('\u{1F5BC}', x + w / 2, y + h / 2);
  },
};
```

A `<div role="img" aria-label="...">` is overlaid for accessibility, positioned to match the rect. The label is derived from:
- `iTerm name` param (base64-decoded).
- else protocol + mime.
- else "image (decode failed)".

### 4.5 Copy-image action

```ts
// packages/ui/src/features/image/copy-image.ts

export async function copyImageToClipboard(imageId: string, contentHash: string, mime: string): Promise<void> {
  const blob = await blobSource.fetch(contentHash);
  if (!blob) { showToast('Image payload unavailable'); return; }
  // createImageBitmap returned earlier; for clipboard we need the original blob.
  const original = await indexedDb.get(contentHash);
  if (!original) { showToast('Image payload unavailable'); return; }
  try {
    await navigator.clipboard.write([ new ClipboardItem({ [mime]: original.rgba }) ]);
    showToast('Image copied');
  } catch (err) {
    // Firefox lacks full ClipboardItem support for image/*; fall back to data-URL text copy.
    fallbackCopyImageAsDataUrl(original.rgba, mime);
  }
}
```

### 4.6 Context menu wiring

`TerminalCanvas.tsx` hit-test on right-click: if the target cell is an image anchor or continuation, show a menu:

- Copy image.
- Save image as... (v1 shows toast "coming in v1.1").
- Copy image as data URL.
- Inspect payload (dev-build only — opens devtools with metadata).

### 4.7 Tauri command — `get_image_blob`

```rust
// crates/quanta-vt/src/ipc/get_image_blob.rs

#[tauri::command]
pub async fn get_image_blob(session_id: String, content_hash: String) -> Result<Vec<u8>, String> {
    let sid = SessionId::parse(&session_id)?;
    let hash = hex::decode(&content_hash).map_err(|_| "bad hash")?;
    let hash: [u8; 16] = hash.try_into().map_err(|_| "bad hash length")?;
    let cache = blob_cache_for_session(&sid)?;
    cache.read(hash).map(|bytes| bytes.to_vec()).map_err(|e| e.to_string())
}
```

### 4.8 WebGL stub

```ts
// packages/ui/src/shared/ui/cell-renderer/backend/WebGLBackend.stub.ts

export class WebGLBackendStub implements BackendContract {
  drawImage(): void {
    throw new Error('WebGL image drawing not implemented — see RFC 0002');
  }
  // ... remaining methods delegate to MemoryBackend or throw ...
}
```

When RFC 0002 lands, this stub is replaced with a real WebGL implementation using texture atlas pages per RFC 0003 §12.3.

---

## 5. Definition of Done

1. `BackendContract` updated with `drawImage` / `removeImage` / `onImageLoaded` signatures.
2. `Canvas2DBackend` implements all three; `MemoryBackend` no-ops them.
3. Image layer canvas mounted beneath cursor layer with correct z-order.
4. `ImageLayer.place` correctly schedules paint after blob load.
5. `ImageLayer.remove` clears placement + repaints neighbors.
6. `ImageBlobSource` returns IndexedDB result when available; falls back to Tauri command.
7. Tauri command `get_image_blob` wired + tested.
8. Placeholder renders for: decode error, size cap, 404, quota exceeded.
9. Placeholder has accessible `role="img"` + `aria-label`.
10. Context menu on image anchor shows Copy / Save / Inspect options.
11. Copy-image action writes to `navigator.clipboard` with correct MIME.
12. Firefox fallback to data-URL when `ClipboardItem` unsupported.
13. `onImageLoaded` repaints pending placements.
14. DPR change triggers full image-layer repaint.
15. Selection highlight renders above image layer (selection overlay z-order preserved).
16. Cursor renders above image layer.
17. 15+ unit tests covering placement lifecycle.
18. E2E test — chafa + imgcat + kitten icat all render visually correct.
19. WebGL stub throws a clear error if instantiated — RFC 0002 will replace it.
20. No render regression in text-only scenarios (full regression suite from EPIC-D still green).

---

## 6. Quality Gates

- **Gate-1 — Visual parity.** 10 reference images render byte-identical (via screenshot diff) across 3 browsers.
- **Gate-2 — Placeholder consistency.** Placeholder visual is identical across browsers on DPR 1, 1.5, 2, 3.
- **Gate-3 — Copy-image round-trip.** Copy → paste into image editor → image preserves pixels.
- **Gate-4 — No text-path regression.** Full RFC 0001 EPIC-D regression suite passes.
- **Gate-5 — Replay on cold load.** Recorded session reopens with all images from IndexedDB cache; no refetch.
- **Gate-6 — Accessibility.** `role="img"` + `aria-label` verified by axe-core; screen reader announces label.

---

## 7. E2E tests (≥ 5)

1. **E2E-F1 — `chafa image.png` full render.** PTY capture from chafa replayed; sixel decoded; placed; rendered; pixel diff vs golden PNG.
2. **E2E-F2 — `imgcat image.png` full render.** Analogous.
3. **E2E-F3 — `kitten icat image.png` full render.** Analogous.
4. **E2E-F4 — `fzf --preview='chafa {}'` cycle.** Multiple images placed + removed rapidly; no memory leak observed; frame rate holds 60 fps.
5. **E2E-F5 — Copy image → paste into preview.** Right-click anchor → Copy image → paste into browser img preview → image displays correctly.
6. **E2E-F6 — Placeholder on decode error.** Injected-panic fixture → placeholder visible + tooltip + `aria-label` correct.
7. **E2E-F7 — IndexedDB cache on replay.** Record session → close tab → reopen → images render from IndexedDB without Tauri call (network panel clean).
8. **E2E-F8 — Z-order correctness.** kitty image with `z=10` vs `z=0` at overlapping placement → higher z drawn on top.
9. **E2E-F9 — DPR change repaint.** Drag window between displays of different DPR → image layer repaints cleanly.

---

## 8. Tests

### 8.1 Unit

- `ImageLayer.place` / `.remove` — placement map semantics.
- `ImageLayer` pending queue — painted on `onImageLoaded`.
- `CompositeBlobSource.fetch` — IndexedDB hit, IndexedDB miss + Tauri hit, both miss.
- `Placeholder.draw` — canvas operations verified via mock ctx.
- `copyImageToClipboard` — clipboard API success + fallback paths.
- DPR-change triggers `repaintAll`.

### 8.2 Integration / visual regression

- 10 reference image rendering tests with screenshot diff.
- Placeholder rendering at 4 DPR values.

### 8.3 E2E

- `inline-image-render.e2e.test.tsx` — E2E-F1 through E2E-F9.

---

## 9. Failure modes

- **F-F1 — `createImageBitmap` fails on malformed blob.** Defense: catch + placeholder + telemetry.
- **F-F2 — Canvas drawImage throws (Safari on oversized bitmap).** Defense: catch + placeholder + log.
- **F-F3 — Blob fetch returns null (backend says 404).** Defense: placeholder; banner after 3 consecutive 404s.
- **F-F4 — IndexedDB quota exceeded on write.** Defense: evict LRU + retry; if still failing, disable cache for session + banner.
- **F-F5 — Clipboard write denied (no user gesture).** Defense: toast "Click the image first to grant clipboard permission".
- **F-F6 — User agent doesn't support ClipboardItem image write.** Defense: data-URL fallback + toast.
- **F-F7 — Tauri command panics server-side.** Defense: IPC returns error; placeholder; telemetry.
- **F-F8 — Backend swap (Canvas2D → WebGL) with live images.** Defense: image layer state serializable; transferred to new backend on swap.
- **F-F9 — Rapid place+remove (fzf preview).** Defense: placement map consistent; no stale bitmap refs; ImageBitmap closed on remove.
- **F-F10 — Font change invalidates cell metrics.** Defense: `ImageLayer.repaintAll` on metrics change.
- **F-F11 — Very large image (4096×4096) slow to paint.** Defense: cached `ImageBitmap` (hardware-accelerated); paint under 5 ms p95.
- **F-F12 — Concurrent reads of same hash.** Defense: `CompositeBlobSource` dedups in-flight fetches by hash.
- **F-F13 — Image layer canvas DOM removed externally.** Defense: MutationObserver detects; re-mount; paint from placement map.
- **F-F14 — Selection over image triggers copy-to-plain-text.** Defense: copy produces `[image:<mime>]` token per EPIC-E rules.
- **F-F15 — A11y tree mismatch under shadow DOM.** Defense: render placeholder overlays in light DOM.

---

## 10. Risks

- **R-F1 — Safari async decode quirks.** Mitigation: use `createImageBitmap` with `{ premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' }`; golden screenshots capture Safari output.
- **R-F2 — Firefox lacks `ClipboardItem` image write.** Mitigation: data-URL fallback + toast.
- **R-F3 — Canvas memory pressure with many images.** Mitigation: ImageBitmap close on placement remove; cache cap at 128 MB.
- **R-F4 — WebGL stub accidentally shipped as prod backend.** Mitigation: stub throws on `drawImage`; CI test asserts Canvas2D is default.
- **R-F5 — DPI change races pending fetch.** Mitigation: `onImageLoaded` re-checks metrics before paint.
- **R-F6 — Placeholder visual drift vs design spec.** Mitigation: golden screenshots in the test suite.
- **R-F7 — Scrollback-scroll repaint cost with images.** Mitigation: image layer is absolute-positioned; scroll translates rather than repaints.

---

## 11. Rollback

- Feature flag `experimental.images='off'` → no `ImageEmitted` events → image layer never paints → placeholder code dormant.
- `WebGLBackend` is a stub; safe to leave in place.
- Tauri command safe to leave (noop on unused endpoint).
- Context menu entries gated behind `experimental.images != 'off'`.

---

## 12. Cross-refs

- RFC 0003 §7.4 — renderer contract extension.
- RFC 0003 §12.3 — texture upload strategy (WebGL).
- RFC 0003 §14 — hit-test + copy actions.
- RFC 0003 §15 — fallback rendering.
- EPIC-E — cell kinds + event envelope.
- RFC 0001 §12 — backend contract.
- RFC 0001 EPIC-D — existing Canvas2D backend.
- RFC 0002 — WebGL backend follow-up; replaces the stub here.

---

## 13. Day-by-day

### Week 1

- **Mon** — Extend `BackendContract` + `MemoryBackend` stubs + Canvas2D integration point. Image layer scaffold.
- **Tue** — `ImageBlobSource` + IndexedDB integration. Tauri command wired. Cross-browser mount test.
- **Wed** — Placeholder rendering + accessibility. 5 placeholder scenarios covered.
- **Thu** — `drawImage` real path + pending-queue. Z-order + opacity + crop honored. 5 fixture renders green.
- **Fri** — `removeImage` + DPR-change repaint. Remaining 5 fixtures green.

### Week 2 (half)

- **Mon** — Context menu + copy-image action + Firefox fallback.
- **Tue** — E2E tests E2E-F1 through E2E-F9. Visual regression green on 3 browsers.

### Week 1.5 soak

- **Wed** — Docs + merge.

---

End of EPIC-F design.
