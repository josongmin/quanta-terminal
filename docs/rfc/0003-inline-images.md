# RFC 0003 — Inline Images (sixel + iTerm + kitty graphics protocols)

- **Status**: Proposed (v1)
- **Author**: Quanta Terminal Team
- **Date**: 2026-04-20
- **Related**: RFC 0001 §3 (non-goals — sixel/kitty explicitly deferred), §12 (renderer backend contract), §15 (DEFER list names this RFC), RFC 0002 (WebGL/WebGPU renderer — image texture upload hook)
- **Spawns**: ADR 0019 (image event envelope + cache eviction — new), ADR 0020 (decoder sandbox + base64 DoS contract — new), ADR 0021 (image-anchor cell semantics — new)
- **Succeeds**: the implicit "images are someone else's problem" posture of v1
- **Supersedes**: nothing — RFC 0001 §15 deferred this deliberately

---

## 0. Purpose

1. Parse and render images emitted by programs through the three de-facto terminal image protocols: **sixel**, **iTerm inline images (OSC 1337 File=)**, and **kitty graphics protocol (APC G)**.
2. Decode safely — arbitrary base64 and binary blobs from a piped PTY stream are a primary attack surface; the decoder must never crash the process and never allocate unbounded memory.
3. Integrate with the VT engine's grid model without violating RFC 0001's invariants — images occupy cells, cells remain the source of truth, reflow obeys the same resize contract as text.
4. Keep the renderer backend contract (RFC 0001 §12) honest — Canvas2D and WebGL (RFC 0002) must both draw images without diverging selection / copy / search / hit-test semantics.
5. Ship progressively: day-one recognize-and-ignore (so `timg` doesn't spew garbage), later full render under a feature flag once perf + security baselines land.

## 1. One-paragraph read

Three image protocols exist in the wild — sixel (DEC, 1987, most Linux/BSD TUIs), iTerm inline images (OSC 1337, macOS-origin but broadly supported), and the kitty graphics protocol (APC G, most capable). A terminal without image support is no longer taken seriously in AI workflows where `matplotlib`-in-repl, `pandas` DataFrame rendering, `image.nvim` plot preview, `fzf --preview`'d thumbnails, and `jupyter console` cell outputs all expect to just work. Quanta treats images as a **first-class cell-anchored artifact**: the engine parses the protocol, dispatches bytes to a dedicated `quanta-image-decoder` crate running on a background thread, stores the decoded RGBA blob on disk (keyed by content hash), emits an `ImageEmitted` event into the reducer stream, and places an "image anchor" cell into the grid that occupies `width_cells × height_cells` cells. The renderer (Canvas2D today, WebGL tomorrow) draws the blob as a textured rect. Selection, copy, search, and reflow treat the anchor as a single logical unit. Decode happens off-thread and is strictly size-capped (64 MB intermediate, 32 MB decoded) so a malicious stream cannot wedge the engine. A three-state feature flag (`off` / `stripped-placeholder` / `full`) lets us ship the parser everywhere before we ship the renderer — because parsing politely is required for compatibility even when we don't render.

## 2. Non-negotiable invariants

These are design-level rules. Violating any is not a bug — it's a refactor.

- **II-1 — Parse even when we don't render.** Every protocol MUST be consumed by the VT engine even when `experimental.images='off'`. Unrecognized bytes leaking into the grid as text is a defect.
- **II-2 — Decode off the engine thread.** The `quanta-vt` hot path MUST NOT call into PNG/JPEG/sixel decoders synchronously. All decoding is `spawn_blocking` (Rust) or a Web Worker (UI replay).
- **II-3 — Size caps are hard.** 64 MB on the wire (base64/binary) per image, 32 MB decoded RGBA. Exceeding either emits a placeholder, not a partial image.
- **II-4 — Never panic on hostile input.** Fuzz each protocol to panic-free + memory-bounded invariants before flag flips to `full`.
- **II-5 — Image anchor cells obey the grid.** Width SSOT applies — image anchors occupy whole cells. The anchor's top-left is the cell address; trailing cells are marked `ImageContinuation` and are non-text, non-selectable-as-text, non-searchable.
- **II-6 — Copy serializes images as alt text.** Text copy includes a placeholder `[image]` token; a separate "copy image" action fetches the blob. Selection spanning the anchor includes `[image]` in the text stream, no binary.
- **II-7 — Reflow respects protocol hints.** `preserveAspectRatio` (iTerm), `z` + `C` (kitty positioning), and sixel's row-by-row model determine whether an image clips, scales, or anchors on resize.
- **II-8 — No filesystem escape.** kitty's file-path transmission mode (`f` + `t=f`) resolves only within a user-approved directory allowlist. Shared-memory mode is opt-in and gated the same way.
- **II-9 — Grid truth extends to images.** Image id, cell span, and anchor row are engine-owned state in `quanta-vt::Grid`. UI mirrors. UI never re-derives pixel placement from raw PTY bytes.
- **II-10 — Placeholder is the default fallback.** Decode failure, size-cap breach, missing blob, unsupported mime → a 1×1 (or size-hinted-if-known) placeholder cell, never a crash, never silent drop.

## 3. Source-of-truth boundaries (extension of RFC 0001 §3)

### 3.1 Protocol parse truth — `quanta-vt` (Rust)

The VT engine gains three new DCS/OSC/APC handlers. Parse state stays inside the engine; payload bytes are buffered until terminator.

- `SixelParser` — `ESC P <params> q ... ESC \` (DCS).
- `ItermInlineImageParser` — `ESC ] 1337 ; File=[key=value;]* : <base64> BEL` (OSC).
- `KittyGraphicsParser` — `ESC _ G <ctrl> ; <payload> ESC \` (APC).

Each protocol emits a `RawImagePayload { protocol, params, bytes }` to the decoder dispatch queue.

### 3.2 Decode truth — `quanta-image-decoder` (Rust crate, new)

Adapter-per-protocol pattern. Produces canonical `DecodedImage { id, rgba, width_px, height_px, mime, source_protocol }`. The decoder never touches `Grid`; it returns results via channel and `quanta-vt` anchors them.

### 3.3 Blob storage truth — on-disk cache (Rust), IndexedDB (UI replay)

- Engine: `$APP_CONFIG_DIR/images/<session_id>/<content_hash>.rgba` + `.meta.json`.
- UI replay: IndexedDB `images` object store keyed by content hash.
- Both LRU-capped at 256 MB per session.

### 3.4 Render truth — renderer backend (unchanged from RFC 0001 §3.4)

Backend gains `drawImage(id, rowRange, colRange, opts)`. All other semantics (hit-test, selection, copy) continue to come from EPIC-D's modules, augmented by the image-anchor rules below.

### 3.5 Enforcement

- CI grep: no image decoding outside `crates/quanta-image-decoder/`. No base64 decoding of PTY bytes in `packages/ui/`.
- Parity test: `quanta-vt` parses 50+ golden image streams; decoder produces byte-identical RGBA for the same content-hash across OS/arch.
- Fuzz: each protocol has a `cargo-fuzz` target; invariant is "never panic, never allocate >64 MB, always produce `DecodedImage` or `DecodeError`."

## 4. Motivation

### 4.1 The AI-workflow bar

The modern CLI user runs `jupyter console`, queries Claude/ChatGPT CLIs that stream markdown with embedded chart images, previews plots from `polars` / `pandas`, and drives `image.nvim`. Each of those, on a terminal that can render images, Just Works. On a terminal that cannot, the user sees `\x1b]1337;File=...` or a screenful of sixel bytes. Every terminal shipping in 2026 that cares about the power user has image support: WezTerm, kitty, iTerm2, foot, mlterm, alacritty (via future work), Warp (via custom extensions).

### 4.2 Protocol ubiquity — we get the bytes whether we want them or not

Users who set `$TERM=xterm-256color` and run `chafa` with no flags still get sixel output by default on many distros. `imgcat` from iTerm ships on every macOS dev machine. `kitten icat` is invoked by `image.nvim`. A terminal that doesn't even *recognize* these escape sequences leaks garbage to the grid, corrupts the cursor position (because sixel moves the cursor), and is visibly broken.

### 4.3 Three protocols, three reasons

- **Sixel** — standardized (DEC VT340, 1987), widely supported, inefficient-but-simple encoding. Many Linux/BSD TUIs emit it because it's the oldest and most portable.
- **iTerm inline images** — OSC 1337 extension; trivially piggybacks on OSC dispatch the engine already has; base64-wrapped PNG/JPEG/etc; macOS ecosystem lingua franca.
- **kitty graphics** — richest feature set (chunked transmit, z-order, animation frames, shared memory, file transport, placements), most complex, increasingly the default in modern TUIs that want capability (neovim's image.nvim, `timg`, etc.).

Supporting all three is the minimum bar — each is the-only-one some program emits.

### 4.4 What not supporting images has cost so far

- dogfood reports consistently list "can't render plots" as top-3 friction.
- AI-assistant sessions that want to show a generated diagram fall back to ASCII art, which is unreadable.
- `fzf --preview='chafa {}'` — common workflow — shows junk.
- `imgcat` is the most-typed "damn, this terminal" command in telemetry.

### 4.5 Why now, not earlier

RFC 0001 §3 deferred this because the right foundation (grid SSOT, renderer backend contract, event-ordered reducer, delta-based protocol) had to land first. With those in place, images become a new cell kind + a new event type, not a wholesale terminal rewrite.

## 5. Protocol coverage

### 5.1 Sixel (DCS)

**Envelope**: `ESC P <P1>;<P2>;<P3> q <sixel-data> ESC \`

- `P1` — pixel aspect ratio (most use `0` = default 2:1 or `7` = 1:1).
- `P2` — background color behavior (0 = transparent, 1 = opaque, 2 = opaque-fill-with-bg).
- `P3` — horizontal grid size (rarely used).
- `<sixel-data>` — six-pixel-row encoded data:
  - `#n;2;r;g;b` — define color n as RGB (each 0-100).
  - `#n` — select color n for subsequent pixels.
  - `"` — set raster attributes `"Pan;Pad;Ph;Pv` (aspect + expected dims).
  - `$` — carriage return (return to start of current sixel row).
  - `-` — next sixel row (advance six pixels down).
  - `!<n><char>` — run-length repeat of `char` n times.
  - `?` through `~` — one sixel (six vertical pixels), bits 0-5 encoding on/off.

**Parser state**: `Idle → InDcs (buffering params) → InSixelData → Complete`.

**Terminates**: on `ESC \` (ST). Implicit terminate on BEL is *non-standard*; we accept it for resilience, behind telemetry counter.

**Row accumulator**: maintain a 6-pixel-tall row buffer while decoding; flush on `-` or terminator. Width grows as `?`..`~` arrive. Max width cap: 8192 px.

**Palette**: 256-entry palette, default empty (colors undefined until defined). Using an undefined color yields `DecodeError::UndefinedPaletteIndex` — we render the placeholder.

**Produces**: RGBA image of size (accumulated_width × 6 × row_count).

**Cursor semantics**: cursor advances by `ceil(height_px / cell_height_px)` rows and `ceil(width_px / cell_width_px)` columns per DEC convention (though in practice most sixel consumers treat it as "cursor drops to row below image").

### 5.2 iTerm inline images (OSC 1337 File=)

**Envelope**: `ESC ] 1337 ; File=<key=value;>* : <base64-payload> BEL` (or `ST`).

**Keys**:
- `name` — base64-encoded filename (decorative).
- `size` — decimal bytes (hint; authoritative size is payload length).
- `width` / `height` — `N` (pixels), `Npx` (pixels), `Nch` (cells), `N%` (percent of pane), or `auto`. Default `auto`.
- `preserveAspectRatio` — `0` or `1` (default `1`).
- `inline` — `0` (download, ignore) or `1` (render inline). We treat `0` as "ignore" (placeholder-less drop).
- `doNotMoveCursor` — `0`/`1`; if `1`, cursor position not advanced after draw.

**Payload**: base64-encoded image file (PNG / JPEG / GIF-first-frame / WebP-stripped / BMP / TIFF). Dispatch by sniffing magic bytes (`89 50 4E 47` PNG, `FF D8` JPEG, `47 49 46` GIF, `52 49 46 46 ... 57 45 42 50` WebP). Unknown magic → `DecodeError::UnknownMime` → placeholder.

**Terminates**: `BEL` (0x07) or `ST` (`ESC \`).

**Cursor semantics**: advance by the rendered cell span unless `doNotMoveCursor=1`.

### 5.3 kitty graphics protocol (APC G)

**Envelope**: `ESC _ G <ctrl-csv> ; <payload-chunk> ESC \`

**Control keys** (CSV of `key=value`):
- `a` — action: `t` (transmit), `T` (transmit+display), `p` (put/display), `d` (delete), `f` (frame-for-animation), `q` (query support).
- `f` — format: `32` (RGBA), `24` (RGB), `100` (PNG).
- `t` — transport: `d` (direct — payload is the image bytes), `f` (file path), `t` (temporary file), `s` (shared memory).
- `s` / `v` — width / height in pixels (required for raw RGBA/RGB).
- `i` — image id (client-chosen 32-bit).
- `I` — image number (alternative addressing).
- `p` — placement id.
- `q` — quiet level (0/1/2 response suppression).
- `m` — more-chunks-follow flag (0 = last, 1 = more).
- `r` / `c` — placement cell rows / cols.
- `z` — z-index (signed 32-bit).
- `C` — cursor movement policy (0 = advance below image, 1 = stay).
- `x`, `y`, `w`, `h` — source-rect crop within transmitted image.

**Chunking**: large payloads split across multiple APC frames, each with `m=1`; final frame `m=0`. Engine must buffer per `i` until `m=0`.

**Transmission modes** — all gated by security policy (§10):
- `d` (direct) — always allowed.
- `f` (file) — require allowlist; default-deny.
- `t` (temp file) — require allowlist; default-deny.
- `s` (shared memory) — default-off; deny with telemetry counter; re-enable opt-in.

**Responses**: kitty protocol defines response APCs (`ESC _ G i=<id>;<status> ESC \`). We emit `OK`, `EIO`, `ENOENT`, `EINVAL`, `ENOTSUP`, `EOVERFLOW` per spec.

**Animation** (`a=f`): frames accumulated under same `i`; `z` controls loop behavior. V1 strips animations to first frame; v2 (future) plays.

### 5.4 Coverage matrix

| Capability | sixel | iTerm | kitty |
|------------|:-----:|:-----:|:-----:|
| Parse-and-ignore (flag=`off`) | yes | yes | yes |
| Parse-and-placeholder (flag=`stripped-placeholder`) | yes | yes | yes |
| Full render PNG | n/a | yes | yes |
| Full render JPEG | n/a | yes | yes |
| Full render raw RGBA | n/a | no | yes |
| Chunked transmit | n/a | no | yes |
| File-path transport | n/a | no | gated |
| Shared-memory transport | n/a | no | opt-in |
| Animation (multi-frame) | no | no | v2 |
| Z-order | no | no | yes |
| Placement id (reuse blob) | no | no | yes |
| Cursor-advance control | implicit | `doNotMoveCursor` | `C=1` |
| Aspect-ratio preservation | palette-level | `preserveAspectRatio` | explicit crop |
| Reflow-on-resize behavior | clip | scale | placement-re-eval |

## 6. Non-goals (v1)

- **Animated GIFs / APNG / kitty animation frames 2+** — strip to first frame; revisit in v2 once render-budget baseline exists.
- **WebP animation** — strip; decode first frame if encoded as static, else placeholder.
- **Arbitrary DECSIXEL vendor extensions** — parse as best-effort; unknown bytes inside sixel-data become errors, not text-leak.
- **`kitten icat --transfer-mode=stream`** — streaming mode (kitty's not-yet-widely-deployed variant) deferred.
- **Protocol negotiation via DA / DA2** — we respond with support strings in v1.1; v1 just emits the images.
- **Saving images from selection** — menu action lands in v1.1.
- **OSC 1337 non-File extensions** (e.g. `SetMark`, `StealFocus`) — out of scope here; handled by existing OSC dispatch if needed.
- **TMUX passthrough of image sequences** (`DCS tmux; ... ST`) — recognized but stripped in v1; full passthrough in v1.1.

## 7. Architecture

### 7.1 Component layout

```
┌─────────────────────────────────────────────────────────┐
│ PTY bytes                                                │
└───────────────┬─────────────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────┐
│ quanta-vt (RFC 0001 owner)                              │
│ ┌────────────────────────────────────────────┐          │
│ │ Sixel / iTerm / kitty parsers (new)        │          │
│ └──────────┬─────────────────────────────────┘          │
│            │ RawImagePayload { protocol, params, bytes }│
│            ▼                                             │
│ ┌────────────────────────────────────────────┐          │
│ │ ImageDispatch (new)                         │          │
│ │ - size cap check                            │          │
│ │ - content-hash compute (xxh3)               │          │
│ │ - cache lookup (if hash known → skip decode)│          │
│ │ - enqueue to decoder worker pool            │          │
│ └──────────┬─────────────────────────────────┘          │
│            │                                             │
│            ▼ (after decode completes via channel)        │
│ ┌────────────────────────────────────────────┐          │
│ │ Grid: place ImageAnchor cell                │          │
│ │ emit ImageEmitted event                     │          │
│ └──────────┬─────────────────────────────────┘          │
└────────────┼────────────────────────────────────────────┘
             │ spawn_blocking
             ▼
┌─────────────────────────────────────────────────────────┐
│ quanta-image-decoder (new crate)                         │
│ - SixelAdapter                                           │
│ - ItermAdapter (wraps `image` crate)                     │
│ - KittyAdapter (raw RGBA fast path + `image` for PNG)    │
│ - size guards, panic catcher, fuzz corpus                │
└─────────────────────────────────────────────────────────┘
             │ DecodedImage / DecodeError
             ▼
┌─────────────────────────────────────────────────────────┐
│ blob cache ($APP_CONFIG_DIR/images/<session_id>/)        │
└─────────────────────────────────────────────────────────┘

             │ event stream (protocol §8)
             ▼
┌─────────────────────────────────────────────────────────┐
│ UI (packages/ui)                                         │
│ - GridMirror: absorbs ImageAnchor cells                  │
│ - IndexedDB image store (replay cache)                   │
│ - RendererBackend.drawImage()                            │
│   - Canvas2D: drawImage on layered canvas                │
│   - WebGL (RFC 0002): texture atlas page per image       │
└─────────────────────────────────────────────────────────┘
```

### 7.2 New crate — `quanta-image-decoder`

- Adapters per protocol.
- Common output type `DecodedImage { id, rgba: Bytes, width_px: u32, height_px: u32, mime: Mime, hash: [u8; 16] }`.
- Common error `DecodeError { kind: DecodeErrorKind, protocol: Protocol, at_offset: Option<usize> }`.
- All public APIs are `#[no_panic]`-audited; internal `unwrap()` banned by CI grep.

Uses the `image` crate for PNG/JPEG/GIF/BMP/TIFF under a single workspace-managed version. No native image libraries (no `libpng`, no `libjpeg-turbo`, no `libwebp`) — pure Rust, fuzzable, memory-safe.

### 7.3 Event envelope extensions (`quanta-proto`)

New events on the reducer stream (ordered by `grid_epoch, sequence_no` per RFC 0001):

```
ImageEmitted {
  grid_epoch: u64,
  sequence_no: u64,
  resize_generation: u64,
  image_id: ImageId,
  protocol: Protocol,        // sixel | iterm | kitty
  mime: Mime,                // image/png | image/jpeg | image/rgba-raw | ...
  width_px: u32,
  height_px: u32,
  width_cells: u16,
  height_cells: u16,
  anchor: CellAnchor,        // { row, col, buffer_kind }
  blob_ref: BlobRef,         // { content_hash, size_bytes, session_id }
  hints: ImageHints,         // preserve_aspect_ratio, z, cursor_advance
}

ImagePlacementUpdated {     // kitty-only: reposition existing blob
  image_id: ImageId,
  placement_id: u32,
  anchor: CellAnchor,
  z: i32,
}

ImageRemoved {
  image_id: ImageId,
  placement_id: Option<u32>,
}
```

Protocol version bumps from `v1` → `v2` with `image_events: true` in the hello message. Old UIs connecting to new engines see a compatibility banner.

### 7.4 Renderer contract extension (RFC 0001 §12)

Add to `BackendContract`:

```ts
drawImage(
  imageId: string,
  anchor: { row: number; col: number },
  cellSpan: { rows: number; cols: number },
  opts: {
    preserveAspectRatio: boolean;
    zIndex: number;
    opacity: number;
  },
): void;

removeImage(imageId: string, placementId?: string): void;

onImageLoaded(imageId: string, blob: Blob | ImageBitmap): void;
```

Canvas2D: layered `<canvas>` beneath the cursor layer, `ctx.drawImage(bitmap, ...)` per placement. WebGL (RFC 0002): texture atlas page per image (one image per page OK up to 4096×4096; larger images tiled).

### 7.5 Grid-model extension

New cell kind `ImageAnchor { image_id, placement_id?, width_cells, height_cells }` at `(row, col)`; cells `(row..row+h, col..col+w)` except `(row, col)` are `ImageContinuation { anchor_row, anchor_col }`. Continuation cells are:

- non-text (selection treats them as placeholder).
- not searched.
- preserved across re-raster.
- replaced by text when overwritten (image disappears; engine emits `ImageRemoved`).

Wrap + reflow behavior: images anchored to absolute cell addresses, NOT to continuation chains. On resize:
- If `preserveAspectRatio=1` and cols change, rescale displayed dims (render-side only; pixel blob unchanged).
- If cols shrink below image width, clip right-edge cells (placeholder seam shown).
- If image cannot fit at all (e.g., resize to 1 col), collapse to 1×1 placeholder for that placement.

## 8. Protocol wire format

All image events share the common envelope `(grid_epoch, sequence_no, resize_generation, buffer_kind)` from RFC 0001 §7.4.

### 8.1 `ImageEmitted` JSON

```json
{
  "type": "ImageEmitted",
  "grid_epoch": 42,
  "sequence_no": 1287,
  "resize_generation": 3,
  "buffer_kind": "main",
  "image_id": "img-9a7c3f",
  "protocol": "kitty",
  "mime": "image/png",
  "width_px": 640,
  "height_px": 480,
  "width_cells": 40,
  "height_cells": 15,
  "anchor": { "row": 12, "col": 0 },
  "blob_ref": {
    "content_hash": "b7e1c3...",
    "size_bytes": 48212,
    "session_id": "sess-1a2b"
  },
  "hints": {
    "preserve_aspect_ratio": true,
    "z_index": 0,
    "cursor_advance": "below"
  }
}
```

### 8.2 Blob fetch protocol

UI requests: `GET /session/{sid}/image/{content_hash}` (Tauri command `get_image_blob`). Response: binary `image/<mime>` with `Cache-Control: immutable` header equivalent.

On replay, UI first checks IndexedDB keyed by `content_hash`; cache miss triggers fetch. Store entries evicted LRU at 128 MB UI-side.

## 9. Parsing politely when we don't render

Feature flag `experimental.images`:

- **`off`** — parsers run, bytes consumed, no events emitted, cursor advanced correctly per protocol. This is the "don't break the shell" mode.
- **`stripped-placeholder`** (default v1) — parsers run, events emitted with `mime=image/placeholder` and a decoded blob of a 1×1 gray texture, cell span honored from the source params (so `chafa --size=40x15` still takes 40×15 cells).
- **`full`** (v1.1) — full decode + render.

The parser MUST be on in all three modes. The flag gates decode + render, not parse.

## 10. Security

### 10.1 Threat model

- **T1 — Decode bomb.** Adversary emits a PNG that decompresses to 2 GB. Mitigation: pre-decode size check against width×height×4 cap; abort with placeholder.
- **T2 — Base64 DoS.** Adversary emits 10 GB of base64 inside OSC 1337. Mitigation: 64 MB wire cap; truncate parse + telemetry-counter.
- **T3 — Sixel-bomb.** Adversary emits sixel with 8192×8192 dims + RLE `!65535~`. Mitigation: width cap 8192 px, total-pixel cap 32 Mpx.
- **T4 — Panic in decoder.** Malformed JPEG crashes `image` crate. Mitigation: `std::panic::catch_unwind` wrapper; convert to `DecodeError::Panicked`. CI fuzz corpus enforces panic-free.
- **T5 — File-path escape (kitty `t=f`).** Adversary passes `/etc/passwd`. Mitigation: default-deny; allowlist opt-in; canonicalize + symlink-resolve + prefix-check.
- **T6 — Shared-memory escape (kitty `t=s`).** Adversary maps attacker-chosen shm segment. Mitigation: default-deny; feature-flag off.
- **T7 — Protocol confusion.** Adversary emits APC_G inside a DCS sixel stream. Mitigation: parser-per-protocol is re-entrant; outer parser always wins; nested parses are errors.
- **T8 — Cache poisoning.** Adversary forces content-hash collision. Mitigation: xxh3-128 (not cryptographic, but collision probability <<1 in 2^64 for terminal workloads); cache keyed additionally by `session_id` in v1.
- **T9 — Memory exhaustion via many small images.** Adversary emits 10K 16×16 images. Mitigation: image-id namespace per session capped at 1024 placements; LRU evict oldest.

### 10.2 Sandbox strategy

- Decoder runs on a dedicated worker thread pool (Rust side: `rayon` with bounded queue; UI replay side: Web Worker). No direct access to main-thread heap.
- File-system access restricted to the allowlist (§10.3).
- No network access from the decoder crate — enforced by CI grep (no `reqwest`, no `hyper`, no `std::net::*`).

### 10.3 File-path allowlist (kitty `t=f` / `t=t`)

Config: `security.kitty_image_file_allowlist: Vec<PathBuf>`. Default empty (deny all). Operator opts in by listing e.g. `["/tmp/quanta-imgs/", "~/Screenshots/"]`. Paths canonicalize + symlink-resolve before prefix-check. Failure → `EACCES` response + placeholder emit.

### 10.4 Size caps (configurable, defaults shown)

```toml
[images.limits]
wire_bytes_max     = 67_108_864   # 64 MB
decoded_bytes_max  = 33_554_432   # 32 MB RGBA
width_px_max       = 8192
height_px_max      = 8192
total_pixels_max   = 33_554_432   # 32 Mpx
placements_per_session_max = 1024
blob_cache_bytes_max = 268_435_456  # 256 MB
```

## 11. Storage

### 11.1 Engine side — disk cache

Path: `$APP_CONFIG_DIR/images/<session_id>/<content_hash>.rgba`

- `.rgba` file: raw RGBA bytes, width×height×4, no header.
- `.meta.json` sibling: `{ mime, width_px, height_px, created_at, source_protocol }`.

Eviction: LRU by `access_time`, cap `blob_cache_bytes_max`. Session termination clears the session dir unless `--preserve-images` is set.

### 11.2 UI side — IndexedDB

Object store `images` keyed by `content_hash`. Schema:

```ts
interface StoredImage {
  content_hash: string;
  rgba_blob: Blob;
  mime: string;
  width_px: number;
  height_px: number;
  last_access_ms: number;
  session_id: string;
}
```

128 MB cap UI-side; LRU eviction.

### 11.3 Replay contract

Replay from event log re-emits `ImageEmitted` with the same `content_hash`. Decoder is NOT invoked on replay — the cache is consulted first. If absent (cache miss on cold load), engine re-decodes from the original bytes stored in `$APP_CONFIG_DIR/images/<session_id>/<content_hash>.src`. If the source is also gone, placeholder.

## 12. Performance

### 12.1 Budgets

- **Engine parse cost** ≤ 2 ms p95 for a 1 MB sixel stream (state machine, no decode).
- **Decode time** ≤ 20 ms p95 for a 640×480 PNG (off-thread — engine unaffected).
- **Blob-ref event dispatch** ≤ 500 µs p95.
- **Render drawImage** ≤ 3 ms p95 per image per frame on Canvas2D; ≤ 0.5 ms on WebGL.
- **Cache lookup** ≤ 50 µs p95 in memory; ≤ 5 ms p95 disk-hit.
- **Steady-state** (no new images): 0 overhead beyond RFC 0001 §13.12 budgets.

### 12.2 Concurrency

- Decoder workers: `num_cpus / 2` (min 1, max 4) per engine process.
- Work-stealing queue; newest-submitted decoded first (LIFO) so interactive use feels snappy.
- UI worker: single-threaded per session; multiple sessions get isolated workers.

### 12.3 Texture upload strategy (WebGL, RFC 0002 hook)

- Small images (< 1024×1024): each gets its own texture.
- Medium (≤ 4096×4096): one per atlas page.
- Large (> 4096 per axis): tile into 4096-pixel chunks.

Uploads happen on a dedicated GL context (OffscreenCanvas + transferControlToOffscreen) or deferred to the render thread if the backend is main-thread.

## 13. Alt-screen + reflow

### 13.1 Alt-screen entry

- Images in main buffer persist (main buffer unchanged).
- Images emitted while alt is active anchor to alt buffer; removed on alt-exit.
- Alt-screen programs that emit images and then leave alt (e.g., `fzf --preview` closing the pane) — images gone when alt exits.

### 13.2 Scrollback

- Main-buffer images scroll with their anchor row.
- When an image row is evicted from scrollback ring (RFC 0001 §4 scrollback ring), the `ImageRemoved` event fires and the blob decrements refcount in the cache.
- Blob is deleted from disk when refcount reaches 0 (subject to LRU cache policy).

### 13.3 Reflow

Resize `cols` changes handled per protocol hint:

- **Sixel** — clip on shrink; pad-transparent on grow; never rescale (DEC behavior).
- **iTerm `preserveAspectRatio=1`** — rescale rendered dims; blob unchanged.
- **iTerm `preserveAspectRatio=0`** — clip.
- **kitty** — re-run placement computation per `r`/`c` params; blob unchanged.

Resize `rows` — image anchor row is stable; content below shifts per existing wrap/reflow contract. Images straddling a reflow boundary remain anchored; text flows around them.

### 13.4 Cursor advance after image

Per protocol (§5 details): after image render the cursor moves to one of:

- **sixel default** — row immediately below image, col 1.
- **iTerm** — one row below image unless `doNotMoveCursor=1`.
- **kitty** — depends on `C`: `C=0` → below image; `C=1` → stay.

## 14. Copy, selection, search, hit-test

### 14.1 Copy

- Image anchor cells serialize as `[image:<short-mime>]` in the text stream.
- A separate "copy image" action (available via context menu on anchor) produces a binary image clipboard payload.

### 14.2 Selection

- Selection ranges that include an anchor cell include the `[image:*]` token.
- Clicking inside the anchor selects the anchor as a unit (not per-cell).
- Block-select across an image: treats the image as opaque.

### 14.3 Search

- Image anchors are non-matchable; search skips them.
- Image alt-text (iTerm `name` key, decoded) searchable in v1.1 (not v1).

### 14.4 Hit-test

- `screenToCell` maps pixel inside the image to the anchor cell `(row, col)` (not the continuation).
- Right-click menu shows "Copy image", "Save as...", "Inspect payload".

## 15. Fallback + error UX

### 15.1 Failure modes mapped to user-visible outcome

| Failure | UI outcome |
|---------|------------|
| Decoder panicked | Placeholder + telemetry counter `image.decode_panic` |
| Size cap exceeded | Placeholder with tooltip "image too large (XXX MB)" |
| Unknown mime | Placeholder with tooltip "unsupported format" |
| File-path escape attempt | Placeholder + security log |
| Base64 malformed | Placeholder |
| Blob cache miss on replay | Placeholder, banner "some images not available in replay" |
| Session quota exceeded | Placeholder + banner "image limit reached" |
| Render failure (Canvas drawImage throws) | Placeholder |

### 15.2 Placeholder rendering

1×1 cell (or size-hinted cells if params were known) containing:
- a muted gray rect
- centered Unicode picture icon
- tooltip text explaining why
- role="img" with `aria-label` describing the failure

## 16. Telemetry

Per-session counters:
- `image.emitted.sixel` / `.iterm` / `.kitty`
- `image.decode_ok` / `image.decode_error` (by kind)
- `image.placeholder_shown` (by reason)
- `image.cache_hit` / `.cache_miss`
- `image.wire_bytes_total`
- `image.decoded_bytes_total`
- `image.placements_active` (gauge)
- `image.decode_duration_ms` (histogram)
- `image.render_duration_ms` (histogram, per backend)
- `image.security.file_allowlist_violation`
- `image.security.shm_denied`
- `image.fuzz.panic_caught` (must stay 0 in prod)

## 17. Migration plan — 6 phases

### Phase 0 — Specs + ADRs (~1 week)

- ADR 0019 (image event envelope + eviction) written + accepted.
- ADR 0020 (decoder sandbox + DoS contract) written + accepted.
- ADR 0021 (image-anchor cell semantics) written + accepted.
- Feature flag `experimental.images` plumbed (default `off`).
- **Exit**: all three ADRs merged; CI grep rules added; telemetry counters stubbed.

### Phase 1 — Decoder crate + fuzz (~2 weeks)

- `crates/quanta-image-decoder/` skeleton.
- Sixel adapter (state machine + palette + RLE).
- iTerm adapter (base64 + `image` crate).
- kitty adapter (RGBA direct path + PNG path).
- `cargo-fuzz` target per protocol.
- Size caps enforced; panic-catcher in place.
- **Exit**: 24-hour fuzz run per protocol with 0 panics, 0 OOM; golden decode tests green.

### Phase 2 — VT engine parsers (~2 weeks)

- `crates/quanta-vt/src/parsers/sixel.rs`.
- `crates/quanta-vt/src/parsers/iterm_inline.rs`.
- `crates/quanta-vt/src/parsers/kitty_graphics.rs`.
- Dispatch queue + size-cap enforcement.
- Feature flag honored: `off` consumes bytes silently, `stripped-placeholder` emits placeholder events.
- **Exit**: feed 50 golden image streams → cursor position + parse state match expected; no bytes leak to grid.

### Phase 3 — Grid + event stream (~1.5 weeks)

- `ImageAnchor` + `ImageContinuation` cell kinds in `quanta-vt`.
- `ImageEmitted` / `ImagePlacementUpdated` / `ImageRemoved` events on `quanta-proto`.
- Blob cache on-disk (engine) + IndexedDB (UI).
- GridMirror absorbs new cell kinds; copy/search/hit-test rules per §14.
- **Exit**: full-stack test — PTY bytes → event → cache → mirror → anchor cell — round-trip parity.

### Phase 4 — Renderer integration (~1.5 weeks)

- `drawImage` in `BackendContract`.
- Canvas2D backend implementation.
- WebGL stub (throws `not-implemented`) — wired for RFC 0002 follow-up.
- Placeholder rendering.
- `experimental.images='full'` flag path lit up behind dev-only flag.
- **Exit**: `timg`, `imgcat`, `chafa`, `kitten icat` all render visually correct on macOS + Linux dev setup.

### Phase 5 — Dogfood + flag flip to `stripped-placeholder` default (~1 week)

- Ship to internal dogfood with default `stripped-placeholder`.
- Gather telemetry for a week.
- Fix any regressions; confirm no new panics, no security events.
- **Exit**: dogfood clean for 7 days; flip default in public build.

### Phase 6 — Flag flip to `full` (v1.1, ~1 week after v1 release)

- After v1 has a week in the wild with zero decode panics + security events:
- Flip default to `full`.
- Announce inline image support in release notes.
- **Exit**: public default is `full`; acceptance gate (§19) ALL-TRUE.

## 18. Risks

- **R1 — Large images kill performance.** Mitigation: size caps + off-thread decode + placeholder fallback. Stress test with 8K images.
- **R2 — Malicious decode bombs reach users.** Mitigation: `image` crate is pure-Rust + fuzzed upstream; our fuzz targets add a second layer; size-caps below OOM thresholds.
- **R3 — Protocol ambiguity (e.g., sixel `ESC \` inside RLE).** Mitigation: golden-corpus tests from real-world emitters (`chafa`, `timg`, `img2sixel`, `kitten icat`, `imgcat`); parser errors on ambiguous input rather than guessing.
- **R4 — Browser Canvas limits.** Chrome/Safari limit canvas to ~16384 × 16384; our 8192 × 8192 image cap is half that. For multi-image scenes, use multiple canvases, not one mega-canvas.
- **R5 — IndexedDB eviction under storage pressure.** Mitigation: quota request + graceful fall-back to in-memory LRU if quota denied; placeholder on cache miss with banner.
- **R6 — Protocol version skew (old UI + new engine).** Mitigation: protocol hello negotiates `image_events`; old UI receives no image events, engine logs telemetry.
- **R7 — Animation-lite misuse.** Emitters that send many frames-per-second abuse our one-frame-only behavior. Mitigation: kitty `a=f` frames beyond the first are dropped with telemetry; we don't buffer them.
- **R8 — kitty response protocol drift.** The kitty response spec has evolved; we lock to the 2023 spec and update in v1.1 if needed.
- **R9 — tmux passthrough encoding.** tmux wraps DCS/APC into its own DCS; without passthrough support our engine sees the outer DCS and strips. Mitigation: detect tmux and emit a banner explaining `allow-passthrough on` is required in v1; full passthrough v1.1.
- **R10 — File-path allowlist misconfig.** Users copy-paste allowlist from docs and grant too much. Mitigation: default empty; config validator warns on `/`, `/home`, `$HOME` entries.

## 19. Acceptance gate

All-true gate before flag-default flips to `full`:

- [ ] `timg <image.png>` renders visually correct — sixel path.
- [ ] `imgcat <image.png>` renders visually correct — iTerm path.
- [ ] `chafa <image.png>` renders visually correct — sixel path (chafa emits sixel by default in appropriate TERM).
- [ ] `kitten icat <image.png>` renders visually correct — kitty path.
- [ ] `fzf --preview='chafa {}'` — image preview cycles smoothly.
- [ ] `image.nvim` inside neovim renders plots — kitty path.
- [ ] Zero decode panics across 24-hour fuzz on each protocol.
- [ ] Zero allocations > 64 MB per blob across fuzz corpus.
- [ ] Selection across image + text copies with `[image:*]` token.
- [ ] Copy image → clipboard produces a valid PNG.
- [ ] Replay of a recorded session with images → identical placements.
- [ ] Alt-screen entry/exit correctly scopes images.
- [ ] Resize reflow: sixel clips, iTerm scales, kitty re-places — all visually correct.
- [ ] Placeholder shows on every failure mode in §15.1.
- [ ] No new CI grep violations under `check-images-no-decode-in-ui`.
- [ ] Telemetry dashboards show expected counters on dogfood builds.
- [ ] Security audit passes (filesystem allowlist, shm denial, size caps).
- [ ] Performance budgets (§12.1) green on the perf harness.
- [ ] Dogfood 7 days with no image-related P0/P1.

## 20. Open questions (resolved by ADRs)

- **Q1 — content-hash collision handling.** → ADR 0019. v1: xxh3-128 per session. v1.1: consider blake3.
- **Q2 — how to handle image-emits-while-in-preedit.** → ADR 0018 extension. Likely queue behind composition boundary.
- **Q3 — session-boundary blob sharing.** → ADR 0019. v1: per-session isolation. v1.1: cross-session dedup by content hash.
- **Q4 — Windows path allowlist canonicalization.** → ADR 0020. v1: deny on Windows entirely; v1.1: path normalization.
- **Q5 — kitty query (`a=q`) responses.** → spec says respond with supported capabilities CSV. v1 responds conservatively (no animation, no shm).

## 21. What this RFC does NOT commit us to

- A full image editor.
- Rendering PDFs, SVGs, videos.
- Converting terminal selections to image format.
- Automatic thumbnail generation for file listings.
- OCR on displayed images.

## 22. Post-v1 roadmap (v1.1 → v2)

- **v1.1** — full flag default, animation (kitty `a=f`), tmux passthrough, cross-session dedup, alt-text search.
- **v1.2** — WebGPU backend (RFC 0002 follow-up) with GPU-side scaling.
- **v2** — WebP animation, APNG, video-frame inline (opt-in — big rabbit hole).
- **v2.x** — custom renderer hooks (plugin API) so third parties can ship their own protocols.

## 23. Cross-refs

- RFC 0001 §3 — source-of-truth boundaries (extended in §3 here).
- RFC 0001 §7 — event envelope (extended in §7.3 here).
- RFC 0001 §12 — renderer backend contract (extended in §7.4 here).
- RFC 0001 §13.1 — engine SSOT (honored in II-9).
- RFC 0001 §15 — DEFER list (this RFC discharges the "sixel / iTerm / kitty graphics" item).
- RFC 0002 §renderer — WebGL texture upload hook.
- ADR 0015 — width SSOT (image anchors obey cell-count hints).
- ADR 0017 — reducer ordering (new events share envelope).
- ADR 0019 / 0020 / 0021 — spawned by this RFC.

## 24. Editorial appendix

### 24.1 Why a dedicated crate (`quanta-image-decoder`)?

- Compilation isolation — image decoders (the `image` crate + transitive deps) are large; isolating them keeps `quanta-vt` compile time low.
- Feature gating — downstream consumers that want only the VT engine without image support can disable the `images` feature.
- Fuzz surface — a dedicated crate has a dedicated fuzz target, not tangled with VT parser fuzz.
- Dependency audit — image libs have the biggest historical CVE surface of any terminal-adjacent dep; isolation makes tracking tractable.

### 24.2 Why xxh3 for content hash?

- Fast (~10 GB/s on modern CPUs) — hashing a 32 MB image in ~3 ms is acceptable.
- 128-bit output sufficient for collision-avoidance at terminal session scales.
- Already a transitive dep through other crates.
- Not cryptographic, but we're not using it for security — a malicious emitter can already emit garbage; dedup only needs to avoid accidental collisions.

### 24.3 Why default `stripped-placeholder` not `full` in v1?

- Protocol compatibility (parsing politely) is *required* for v1 — without it, programs break.
- Render correctness, perf, and security are *hardening* — they need real-world soak time.
- Decoupling those two deliverables means v1 ships protocol-compatible on the v1 date; v1.1 flips the flag once soak is done. Low-risk, high-compatibility, honest with users.

### 24.4 Why no shared-memory mode by default?

- Shared-memory is the richest attack surface in the kitty protocol — adversary provides the shm name, decoder maps arbitrary memory.
- Almost no real-world usage (only emits when kitty detects it's running on the same machine as the client).
- Cost of leaving off: maybe 1 ms saved on large intra-machine transfers; we prefer the safety margin.

### 24.5 What changes if WebGL (RFC 0002) lands first?

- `drawImage` dispatch goes to the GL texture path immediately; Canvas2D path becomes the fallback.
- No semantic change to this RFC; the contract in §7.4 covers both.

### 24.6 What about SGR/attribute interactions?

- Image anchor cells have no SGR; they draw the blob unconditionally (SGR applies to text only).
- The cell beneath the image (background of the cell box) defaults to the prevailing bg color for the row, so "transparent" PNGs composite visibly.

### 24.7 What about the block overlay (EPIC-H)?

- Images belong to the grid, and the grid belongs to a block per command boundary. On block collapse, the image collapses with the block.
- Collapsing preserves the blob-ref; re-expanding redraws.

### 24.8 Editorial stance on the "don't ship images" camp

A subset of terminal purists argues images are mission-creep and the right answer is "the shell shouldn't be doing this." The shell is doing this. Programs emit these sequences today regardless of whether we want them. Our choice is between graceful render, graceful placeholder, or broken output. We pick graceful, in that order of preference, gated by the three-state flag so we can ship each level of graceful on its own timeline.

### 24.9 Relationship to accessibility

- Image anchors surface `role="img"` with `aria-label` derived from the iTerm `name` key (if present) or a generic label.
- Screen readers announce the label; block-navigation jumps treat an image as one stop.
- High-contrast theme: placeholder is drawn with high-contrast fill + border regardless of system preference.

### 24.10 Licensing

- `image` crate — MIT/Apache-2.0.
- `xxh3` — Apache-2.0.
- No GPL / LGPL / AGPL deps introduced.
- Our fuzz corpus includes only CC0 / public-domain images.

---

End of RFC 0003.
