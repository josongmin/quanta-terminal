# RFC 0002 — WebGL/WebGPU Renderer ("GPU Paint Backend")

- **Status**: Proposed (v1, follows RFC 0001 acceptance)
- **Author**: Quanta Terminal Team
- **Date**: 2026-04-20
- **Depends on**: RFC 0001 (custom VT engine + xterm removal) — ALL of §12 (renderer backend contract), §13.12 (performance gate), §13.13 (performance budget decomposition), §13.14 (telemetry), §19 (final xterm-removal gate) are load-bearing
- **Related**: ADR 0014 (architecture invariants), ADR 0015 (width / grapheme / line-break SSOT — consumed), ADR 0016 (selection / search / copy — consumed), ADR 0017 (reducer ordering — consumed), ADR 0018 (IME state machine — consumed)
- **Spawns**: ADR 0019 (backend selection + fallback policy — new), ADR 0020 (GPU atlas eviction policy — new), RFC 0002.1 (WebGPU bridge — follow-up once WebGL ships)
- **Supersedes**: none; this is a pure addition behind the RFC 0001 §12 renderer-backend contract
- **Does NOT touch**: `quanta-vt` (Rust engine), `GridMirror` / `CellBuffer` (mirror layer), `Selection` / `HitTest` / `Search` (shared UI semantics). This RFC is scoped entirely to the paint layer.

---

## 0. Purpose

1. Replace the Canvas2D paint backend with a GPU-accelerated backend (WebGL first, WebGPU as a follow-up).
2. Hit the **stretch** performance budget from RFC 0001 §10 / §13.12 — cold start ≤ 80 ms, keystroke p95 ≤ 8 ms, 120 fps under `yes | head -10000`, memory ≤ 12 MB for 10 k × 120 scrollback.
3. Preserve every contract frozen by RFC 0001 — selection / copy / search / hit-test / IME overlay / degraded mode / telemetry — **bit-for-bit identical** to Canvas2D.
4. Ship behind the RFC 0001 §12 renderer-backend contract so the swap is a plug-in, not a rewrite.
5. Keep Canvas2D alive as the default and the always-available fallback. WebGL is opt-in until a §14 hard gate is ALL-TRUE.

## 1. One-paragraph read

RFC 0001 shipped a single Rust VT engine, a mirror protocol, and a Canvas2D backend behind a `BackendContract`. Nothing semantic lives in the renderer. This RFC replaces the paint backend with a GPU path: a texture-page glyph atlas, an instanced quad renderer, three-pass overlay composition (cells → cursor → selection/IME). We do **not** redesign the mirror, the protocol, the selection contract, the hit-test, the search, the IME state machine, or any ADR from RFC 0001. We plug a new `BackendContract` implementation into the same socket Canvas2D occupies today, and we gate activation behind `experimental.renderer = 'webgl' | 'canvas'`. Canvas2D remains the default renderer and the always-available fallback. WebGPU is covered as a shim (§15) so that once browser coverage crosses the bar, dropping in a `WebGPUBackend` is the same drop-in Canvas2D → WebGL is today. Success is six-axis: correctness parity, perf budget met, context-loss recovery, mobile/integrated-GPU coverage, rollout flag + telemetry, no selection/search/copy regression.

## 2. Non-negotiable invariants (inherited from RFC 0001 §2)

This RFC does not weaken any RFC 0001 invariant. It adds **paint-layer** invariants below.

Inherited (verbatim enforcement):

- **I-1 — Exactly one VT engine.** WebGL does not parse ANSI. CI grep unchanged.
- **I-2 — UI does not parse ANSI.** The GPU path consumes mirrored rows; no shader reads an escape byte.
- **I-3 — Grid is the truth.** WebGL reads `GridMirror` state through `CellBuffer`; it does not poach semantics.
- **I-4 — Semantic width wins, paint adapts.** Glyph atlas width is derived from width-SSOT cell count; the GPU never re-widths.
- **I-5 — Delta from day one.** GPU path subscribes to damage; no per-tick full-grid redraw.
- **I-8 — No black screen.** On GL context loss or shader compile fail, the active backend falls back to Canvas2D **without unmount-remount visible flash**.
- **I-10 — xterm removal gate** (§19 of RFC 0001) — unchanged. WebGL ships **after** xterm is gone.

Added paint-layer invariants:

- **I-P1 — Backend contract is the only socket.** `WebGLBackend` implements `BackendContract` identically to `Canvas2DBackend`. No new public method enters the contract without an RFC amendment.
- **I-P2 — Atlas is derived state.** The GPU atlas is reconstructable from grapheme+attrs+dpr+font. Losing it is a perf event, never a correctness event.
- **I-P3 — Context loss is recoverable.** `webglcontextlost` → switch to Canvas2D in < 1 frame; no data lost; `webglcontextrestored` may re-arm WebGL behind the user flag.
- **I-P4 — Three layers, always.** Grid cells, cursor, overlay (selection + IME + hyperlink hover). Order and blending preserved across backends.
- **I-P5 — DPR / theme / font-load invalidation is a full-atlas drop.** No partial-atlas recolor or rescale. Matches Canvas2D `FontAtlas.invalidateAll` policy.
- **I-P6 — No backend-specific contract drift.** Any WebGL-only hook added to `BackendContract.ts` must be implemented (or trivially no-op'd) by every other backend under the parity test (`backend-contract.test.ts`). If WebGL needs a hook Canvas2D can't emulate, the hook doesn't enter the contract.
- **I-P7 — WebGPU is a peer, not a replacement.** The shim (§15) treats WebGPU as another `BackendContract` implementation selectable by the same flag. No WebGL-only primitive leaks into the contract.

## 3. Source-of-truth boundaries (unchanged from RFC 0001 §3)

Paint truth — §3.4 — still owned by the renderer. WebGL joins Canvas2D there; nothing else moves.

The renderer MAY NOT:

- change semantic cell width
- change grapheme segmentation
- change wrap boundary
- alter any layer 1 or 2 state
- cache mirrored state beyond one `applyGridDelta` / `applyGridSnapshot` / `applyCursor` / `applyMode` call

The renderer MAY:

- own texture pages, VBOs, shaders, uniform buffers
- own DPR / theme / font-family cache invalidation
- own cursor blink timing
- own atlas LRU policy
- own GPU feature detection + fallback orchestration (subject to §8)

## 4. Motivation

### 4.1 The stretch perf goal from RFC 0001 §13.12

RFC 0001's performance gate is:

- keystroke → rendered cell p95 ≤ 16 ms
- `yes | head -10000` sustained 60 fps
- idle CPU < 0.1 %
- memory ≤ 22 MB for 10 k × 120 scrollback

These gates are **hit by Canvas2D** per the EPIC-D perf-budget harness. We ship Canvas2D as "production adequate."

The RFC 0001 §10 / §13.13 budget decomposition, however, identifies three stages the CPU path can't shrink further without an architectural change:

- **Raster** — per-frame `ctx.fillText` dominates; ~40–60 % of the frame budget on high-DPR displays. Atlas hits help; atlas misses destroy the budget.
- **Cell blit** — per-cell `drawImage` calls for atlas-cached glyphs are ~10–20 % of the frame; scales with dirty-cell count, not row count.
- **Damage coalescing overhead** — cheap, but the ceiling it buys is the CPU raster ceiling.

Stretch targets (from RFC 0001 §10 notes + stakeholder "Warp-class" language):

- **cold start ≤ 80 ms** (currently ~110 ms on M-series; Canvas2D bottleneck is first-raster filling the atlas)
- **keystroke p95 ≤ 8 ms** (currently ~12 ms; Canvas2D raster is the long pole on wide-char + attribute-variant rows)
- **120 fps under `yes | head -10000`** on 120 Hz displays (currently ~72 fps; Canvas2D can't sustain 8.3 ms/frame with atlas churn)
- **memory ≤ 12 MB for 10 k × 120 scrollback** (currently ~18 MB; GPU atlas frees ~6 MB by keying rasters by `(grapheme, attrs_variant, dpr)` rather than per-row textures)

A GPU path moves raster to upload-once-draw-many: rasterize a grapheme to an atlas page **once**, instance a quad per cell that samples that page. The frame-time floor drops from "number of dirty cells" to "number of instanced draw calls," which is ~O(buffer pages).

### 4.2 What RFC 0001 §13.13 leaves on the table

The RFC 0001 perf-budget decomposition explicitly calls out:

- PTY parse / apply budget — Rust-side, not renderer-affected
- Reducer / apply-delta budget — mirror-side, not renderer-affected
- Layout / hit-test budget — shared, unchanged
- **Raster budget** — Canvas2D dominant, GPU addresses
- **Cursor / overlay budget** — Canvas2D separate-pass-already, GPU preserves
- **Atlas miss recovery budget** — Canvas2D synchronous in-paint, GPU can upload on worker

Stages 4 / 6 are the lever. Stage 5 stays under the 3-layer model.

### 4.3 Why now, not in RFC 0001

RFC 0001 §15 DEFER explicitly lists "GPU renderer (WebGL / WebGPU) — RFC 0002." The reasoning, per RFC 0001 §13.11: a GPU path committed first buries correctness bugs inside GPU state. Canvas2D gave us the stable substrate to validate `BackendContract`, `CellBuffer`, `FontAtlas`, `DamageSet`, `HitTest`, `Selection`, `Search`. Those now carry the parity suite. WebGL drops in behind them.

### 4.4 What we are *not* solving for

- Sixel / kitty graphics / iTerm images — RFC 0003.
- Compute shaders for reflow / search / width scanning — mirror-layer concern, not paint.
- Variable-rate shading / foveated rendering — not a terminal concern.
- WebGPU coverage — §15 bridge; not the 2026-H2 target.

## 5. Non-goals (explicit)

- We do not port `Selection`, `HitTest`, or `Search` into WebGL. They stay CPU-side in TS, reading `CellBuffer`, because the `BackendContract` isolates them from paint.
- We do not build a second `GridMirror` on the GPU. Mirror is authoritative; GPU is a paint consumer.
- We do not ship WebGPU alongside WebGL v1. WebGPU is a follow-up (§15).
- We do not modify `quanta-vt`, the event protocol, or any ADR from RFC 0001.
- We do not change the block-chrome layer; blocks are overlays on the paint layer and remain DOM-anchored via `cellToScreen`.
- We do not alter the RFC 0001 §19 removal gate. WebGL activates **after** xterm is removed and Canvas2D is stable in production.
- We do not build a native Metal/Vulkan/DX12 backend. Out of scope; terminal lives in the browser runtime.
- We do not introduce per-backend telemetry names. Existing RFC 0001 §13.14 counter namespace is reused with a `backend=webgl|canvas` tag.

## 6. Architecture

### 6.1 Where WebGL sits

```
   ┌─────────────────────────────────────────────┐
   │           QUANTA ENGINE (Rust)              │    (unchanged from RFC 0001 §7)
   │   quanta-vt::Processor → Grid → Events      │
   └──────────────────────┬──────────────────────┘
                          │
                          ▼
   ┌─────────────────────────────────────────────┐
   │           QUANTA UI (TypeScript)            │
   │                                             │
   │   GridMirror     ← ADR 0017 ordering        │    (unchanged)
   │     │                                       │
   │     ▼                                       │
   │   CellBuffer     ← packed Uint32Array       │    (unchanged — §4.3 EPIC-D)
   │     │                                       │
   │     ▼                                       │
   │   Renderer.tick() rAF loop                  │    (unchanged)
   │     │                                       │
   │     ▼                                       │
   │   BackendContract (single interface)        │    (unchanged — RFC 0001 §12)
   │     │                                       │
   │     ├───► Canvas2DBackend      (default)    │    (unchanged)
   │     ├───► MemoryBackend        (tests)      │    (unchanged)
   │     └───► WebGLBackend         (NEW)        │    ← RFC 0002
   │              │                              │
   │              ├── GPU glyph atlas (pages)    │
   │              ├── Instanced cell VBO         │
   │              ├── Cursor pass                │
   │              ├── Overlay pass               │
   │              └── Context-loss recovery      │
   └─────────────────────────────────────────────┘
```

The WebGL backend subscribes to the same `applyGridSnapshot` / `applyGridDelta` / `applyCursor` / `applyMode` / `applyMetrics` / `requestDamageFlush` entry points as Canvas2D. Every call that Canvas2D handles as a CPU raster, WebGL handles as a glyph-lookup + instance-upload + draw-call.

### 6.2 Two backends live side-by-side in code

Both implementations ship simultaneously:

- `Canvas2DBackend` — default, always available, zero feature detection.
- `WebGLBackend` — opt-in via `experimental.renderer = 'webgl'`; feature-detects on mount; falls back to Canvas2D if detection fails.

The `Renderer` doesn't know which is mounted. The `TerminalCanvas` widget owns the decision at construct time (§8).

### 6.3 Fallback topology

Three failure modes degrade from WebGL → Canvas2D:

1. **Feature detection fail** (no WebGL2, no `OES_texture_float`, no `vertexAttribDivisor`, no `EXT_color_buffer_float` if needed) — never mount WebGL.
2. **Context lost mid-session** (`webglcontextlost` event) — unmount WebGL, mount Canvas2D, re-apply last snapshot, resume.
3. **Performance cliff detected** (telemetry: frame time > 2× baseline sustained for 5 s) — opt-out flag bumps the user to Canvas2D until manual re-enable.

All three emit a telemetry counter (§9) and a visible but dismissable banner ("switched to compatible renderer — details"); no black-screen, no data loss.

## 7. Glyph atlas on GPU

### 7.1 Texture pages

An atlas page is a `TEXTURE_2D` with dimensions negotiated at init (§7.4):

- target page size: 2048 × 2048 for desktop GPUs (64 × 32 glyphs at 32 × 64 px)
- fallback: 1024 × 1024 for mobile / integrated GPUs
- hard floor: 512 × 512 (if `MAX_TEXTURE_SIZE < 1024`, WebGL disabled)

One active page receives rasters; when full, allocate a new page. Target steady-state: 1–3 pages in typical use (Latin + bold + italic + one CJK block).

### 7.2 Atlas key

Identical to Canvas2D:

```ts
interface AtlasKey {
  grapheme: string;       // grapheme cluster, multi-codepoint allowed
  attrsVariant: number;   // packed bold/italic/under/strike/faint/double-under bits
  dpr: number;            // rounded to 2 decimals
}
```

### 7.3 Rasterization path

- Rasterize glyphs off the main GL context on an `OffscreenCanvas` (2D) — identical to Canvas2D path.
- Upload the rasterized sub-rect via `texSubImage2D` into the active page.
- Store `(pageIndex, u, v, w, h, cellsWide, ascent, descent)` in a CPU-side `Map<hashed_key, AtlasEntry>`.

Fast path for known attrsVariants pre-warms the Latin basic printable set on mount (<0.5 ms, deterministic — EPIC-B DoD).

### 7.4 LRU with GPU page eviction

- Each `AtlasEntry` tracks `lastAccessTick`.
- On capacity exceeded (per-page, not per-atlas), evict the LRU entry in the active page and reclaim its rect.
- Hard atlas cap: 4 096 entries × max 4 pages = 16 384 entries (stretch cap, typically ≤ 500 active).
- Page eviction: when all pages are > 95 % full, drop the coldest entire page and its GL texture. Next raster triggers a new page allocation.

Atlas eviction during a burst (100+ dirty cells in one frame) is a known worst case: §12 #4 and EPIC-B DoD assert this never drops a frame.

### 7.5 Mipmap-aware rasterization

- Desktop path: no mipmaps. Glyphs are 1:1 and sampled with `LINEAR` / `NEAREST` depending on DPR. DPR change → full atlas drop (I-P5).
- Mobile / integrated path: generate two mip levels (0 and 1) for 2× DPR zoomed displays. Saves a full-atlas rebuild on DPR switch (plug/unplug external display).

### 7.6 CPU-rasterize fast-path fallback

If a grapheme rasterization takes > 4 ms (web-font late load, complex combining sequence, fallback-font chain), the `WebGLBackend` draws a **Canvas2D glyph** for that cell this frame and schedules the GPU raster for the next idle frame. Preserves the frame budget during font-load storms (RFC 0001 §22 #19).

## 8. Instanced cell rendering

### 8.1 Instance record

Per-cell instance attribute layout (48 bytes per cell, 16-byte aligned):

```
struct CellInstance {
  vec2  cellOrigin;     // screen-space top-left of the cell quad (in cell units)
  float atlasPage;      // which texture page to sample
  float atlasUV_packed; // u,v of glyph top-left in page (quantized to 0.5 px)
  vec4  fgRGBA;         // foreground color (premultiplied)
  vec4  bgRGBA;         // background color
  float attrsBits;      // bold/italic/under/... bitfield (for shader-side styling)
  float cellsWide;      // 1 or 2, for quad sizing
  float reserved_0;
  float reserved_1;     // reserved for v2 (e.g. per-cell underline color)
};
```

### 8.2 Rendering loop

- One `gl.DRAW_ARRAYS_INSTANCED` call per atlas page per frame.
- VBO is a single pre-allocated `GL_DYNAMIC_DRAW` buffer of size `rows × cols × sizeof(CellInstance)` (≈ 120 × 40 × 48 = 230 KB for a typical viewport).
- Damage updates rewrite only dirty-cell ranges via `bufferSubData`.
- Background fill is a separate pass before glyphs, using a simpler instance layout (`cellOrigin`, `bgRGBA`, `cellsWide`).

### 8.3 Vertex shader (GLSL ES 3.0)

```glsl
#version 300 es
in vec2 a_quadCorner;
in vec2 a_cellOrigin;
in float a_atlasPage;
in vec4 a_fgRGBA;
in vec4 a_bgRGBA;
in float a_atlasU;
in float a_atlasV;
in float a_attrsBits;
in float a_cellsWide;

uniform vec2 u_cellSizePx;
uniform vec2 u_viewportPx;
uniform float u_dpr;

out vec2 v_atlasUV;
out vec4 v_fg;
out vec4 v_bg;
out float v_attrs;
out float v_page;

void main() {
  vec2 cellPx = a_cellOrigin * u_cellSizePx;
  vec2 cornerPx = a_quadCorner * vec2(u_cellSizePx.x * a_cellsWide, u_cellSizePx.y);
  vec2 ndc = ((cellPx + cornerPx) / u_viewportPx) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_atlasUV = vec2(a_atlasU, a_atlasV) + a_quadCorner * /* glyph w,h in page */;
  v_fg = a_fgRGBA;
  v_bg = a_bgRGBA;
  v_attrs = a_attrsBits;
  v_page = a_atlasPage;
}
```

### 8.4 Fragment shader

```glsl
#version 300 es
precision highp float;
in vec2 v_atlasUV;
in vec4 v_fg;
in vec4 v_bg;
in float v_attrs;
in float v_page;

uniform sampler2DArray u_atlas;      // all pages stacked as an array texture

out vec4 outColor;

void main() {
  vec4 glyphSample = texture(u_atlas, vec3(v_atlasUV, v_page));
  float alpha = glyphSample.a;
  vec4 fg = v_fg;

  // attrs bits: faint → alpha * 0.5, inverse → swap fg/bg (pre-unpacked CPU-side preferred).
  if ((int(v_attrs) & 1) != 0) { /* bold: thickening already handled in atlas */ }
  if ((int(v_attrs) & 4) != 0) { /* underline: stroke pass handles */ }

  outColor = mix(v_bg, fg, alpha);
}
```

### 8.5 Truecolor path

No uniform table or palette lookup needed: truecolor + palette256 + palette8 are resolved CPU-side during instance packing and land in `fgRGBA` / `bgRGBA` as premultiplied RGBA. Shader is color-agnostic.

### 8.6 SGR → shader uniforms vs shader attributes

- **Per-cell attrs** (bold, italic, underline, strikethrough, faint, double-underline, inverse) → per-instance `attrsBits` bitfield. Avoids uniform churn.
- **Global styling** (cursor blink phase, selection highlight color, theme background) → uniforms updated once per frame.
- **Palette swaps** (theme change) → full atlas drop (I-P5).

## 9. Three-pass overlay composition

Pass order, preserved from Canvas2D (and RFC 0001 §13.8 selection requirements):

### 9.1 Pass 1 — cells

- Background fill (per-cell instance, no texture sample).
- Glyph pass (per-cell instance, sampled from atlas pages).
- Blend: `ONE`, `ONE_MINUS_SRC_ALPHA` premultiplied.

### 9.2 Pass 2 — cursor

- One instance (or two, if cursor is wide-char).
- Shape: block / bar / underline (shader branch on `u_cursorShape`).
- Blink: alpha modulated by `u_cursorBlinkPhase` (CPU-computed from rAF time).
- Separate draw call so cursor animations don't touch the cells VBO.

### 9.3 Pass 3 — overlay

- Selection highlight (rectangle-per-run, alpha 0.3 over fg).
- IME preedit text (rasterized to a mini-atlas, drawn via same instanced shader with a `u_overlay = 1` uniform that suppresses cell-bg).
- Hyperlink hover (1-px underline stroke).

Z-order preserved: cells < cursor < overlay. Matches Canvas2D `Renderer.tick()` sequence. Backend-contract parity test (`backend-contract.test.ts`) covers the stack.

## 10. DPR / theme / font-family / font-load invalidation

Inherited rules from Canvas2D `FontAtlas.invalidateAll`:

| Event | Action |
|-------|--------|
| DPR change (monitor swap) | drop all atlas pages; rebuild on next frame |
| Theme change | drop all pages (color-multiplied rasters would leak on fg/bg change, but since we render uncolored atlas, **theme change is a CPU-only concern** — GPU atlas survives) |
| Font family change | drop all pages |
| `document.fonts.ready` new face | drop all pages |
| Resize without DPR change | no drop; `u_viewportPx` and `u_cellSizePx` update |
| Buffer swap (main ↔ alt) | no drop; damage from mirror triggers full redraw, atlas unchanged |

**Clarification vs Canvas2D**: Canvas2D bakes color into rasters (faster blit). GPU path renders uncolored glyphs + multiplies in the shader. Theme swap therefore does *not* force a GPU atlas drop — a small win vs Canvas2D.

## 11. Device detection + fallback (`experimental.renderer` setting)

### 11.1 Setting shape

`experimental.renderer: 'canvas' | 'webgl'` in user settings. Default `'canvas'` through the full v1. Once §14 gate is ALL-TRUE, a follow-up RFC (0002.1 or ADR 0019) can flip the default.

### 11.2 Detection at mount

WebGL mount protocol:

1. Request `webgl2` context. If null → fall back Canvas2D, telemetry `backend.mount_fallback{reason=no_webgl2}`.
2. Query required extensions (instancing is core in WebGL2; texture arrays core; float textures require `EXT_color_buffer_float`). Missing any → fall back.
3. Query `MAX_TEXTURE_SIZE ≥ 1024` and `MAX_ARRAY_TEXTURE_LAYERS ≥ 2`. Otherwise fall back.
4. Compile + link vertex + fragment shaders. Compile fail → fall back, telemetry `backend.mount_fallback{reason=shader_compile}`.
5. Rasterize + upload 3 sentinel glyphs (ASCII `A`, CJK `あ`, emoji `😀`). Verify round-trip. Otherwise fall back.
6. Emit `backend.mount_ok{backend=webgl}`. Proceed.

### 11.3 Runtime fallback

- `webglcontextlost` → preventDefault → emit `backend.context_lost`; unmount WebGL; mount Canvas2D; re-apply last snapshot from `GridMirror`. User-visible time: ≤ 1 frame (16.7 ms at 60 Hz).
- `webglcontextrestored` → telemetry `backend.context_restored`. Do **not** auto-swap back to WebGL in-session; require a manual reload. Avoids swap-storm on driver reset.
- Perf cliff detection (§12 #7): if `frame_p95 > 2 × baseline` for 5 consecutive seconds, switch to Canvas2D + emit `backend.perf_fallback`.

### 11.4 ADR 0019 (spawned)

Records the fallback policy, setting key, detection matrix, telemetry names. Binds this RFC's §11 decisions for later reference.

## 12. Perf budget decomposition (per RFC 0001 §13.13 schema)

Stretch numbers. Each stage maps to a bench file path (existing or to-be-created).

| Stage | Canvas2D baseline | WebGL target | Bench file |
|-------|-------------------|---------------|------------|
| PTY parse | 0.5 ms | 0.5 ms (unchanged) | `crates/quanta-vt/benches/parse_throughput.rs` |
| Reducer / apply-delta | 0.8 ms | 0.8 ms (unchanged) | `packages/ui/src/shared/lib/grid-mirror/__benches__/apply-delta.bench.ts` |
| Layout / hit-test | 0.2 ms | 0.2 ms (unchanged) | `packages/ui/src/shared/ui/cell-renderer/__benches__/hit-test.bench.ts` |
| Raster (atlas hit) | 2.5 ms | 0.4 ms | `packages/ui/src/shared/ui/cell-renderer/__benches__/raster-hit.bench.ts` |
| Raster (atlas miss) | 9.0 ms | 3.5 ms | `packages/ui/src/shared/ui/cell-renderer/__benches__/raster-miss.bench.ts` |
| Cell blit / instance upload | 4.0 ms | 0.8 ms | `packages/ui/src/shared/ui/cell-renderer/__benches__/blit.bench.ts` |
| Cursor pass | 0.3 ms | 0.1 ms | `packages/ui/src/shared/ui/cell-renderer/__benches__/cursor-pass.bench.ts` |
| Overlay pass | 0.4 ms | 0.2 ms | `packages/ui/src/shared/ui/cell-renderer/__benches__/overlay-pass.bench.ts` |
| Atlas miss recovery | 12.0 ms | 4.0 ms | `packages/ui/src/shared/ui/cell-renderer/__benches__/atlas-miss-recovery.bench.ts` |
| Font-atlas rebuild | 35.0 ms | 18.0 ms | `packages/ui/src/shared/ui/cell-renderer/__benches__/atlas-rebuild.bench.ts` |
| Context-loss recovery | N/A | 14.0 ms | `packages/ui/src/shared/ui/cell-renderer/__benches__/context-loss-recovery.bench.ts` |
| Full-snapshot fallback | 28.0 ms | 9.0 ms | `packages/ui/src/shared/ui/cell-renderer/__benches__/full-snapshot.bench.ts` |

Real-load harnesses (10-min runs, p50/p95/p99 reported):

- `packages/ui/src/__tests__/perf/yes-head-10000.perf.ts` — `yes | head -10000` sustained
- `packages/ui/src/__tests__/perf/keystroke-roundtrip.perf.ts` — keystroke → paint
- `packages/ui/src/__tests__/perf/vim-edit-session.perf.ts` — 5-min vim editing session
- `packages/ui/src/__tests__/perf/tmux-pane-resize.perf.ts` — rapid resize stress
- `packages/ui/src/__tests__/perf/htop-refresh.perf.ts` — high-churn refresh
- `packages/ui/src/__tests__/perf/cold-start.perf.ts` — mount → first-paint latency

Memory harness:

- `packages/ui/src/__tests__/perf/memory-10k-scrollback.perf.ts` — RSS after 10 000 × 120 cells scrollback

## 13. Six-axis success criteria

Same structure as RFC 0001 §5.

1. **Correctness parity** — WebGL produces the same pixels ±1 for the entire Canvas2D golden corpus. Diff suite in `packages/ui/src/shared/ui/cell-renderer/__tests__/cross-backend-pixel-diff.test.ts`.
2. **Perf budget met** — every stage in §12 meets the WebGL target p95 across the bench corpus.
3. **Context-loss recovery** — fault-injected `webglcontextlost` in ≥ 10 points in the 24 h dogfood log; zero frames dropped beyond the one restore frame; zero visible flash beyond a single frame swap.
4. **Mobile / integrated-GPU coverage** — runs green on Intel Iris, Apple M1/M2/M3, Apple M1 low-power mode, Android Chrome (WebView/WebGL2-required set). Test matrix logged at `docs/plans/0002-webgl-renderer/device-matrix.md` (to be produced in EPIC-E).
5. **Rollout flag + telemetry** — `experimental.renderer` setting works; telemetry distinguishes backends; auto-fallback events observable.
6. **No selection / search / copy / hyperlink regression** — ADR 0016 parity suite passes under WebGL identical to Canvas2D. Side-by-side diff (analogous to RFC 0001 §13.11) is zero across the RFC 0001 compat matrix.

## 14. Failure modes — "where we die" (paint-layer checklist)

Twenty-plus concrete failures, each with an owning phase + test. Missing test = phase does not exit.

1. **Lost GL context on driver reset** — EPIC-F fault injection; `webglcontextlost` handler must unmount + fall back in ≤ 1 frame.
2. **Shader compile fail on Mesa/Intel** — EPIC-A detection; fall-back path under `mount()`.
3. **Texture page size < 1024** — EPIC-B hard floor; refuse WebGL mount, emit telemetry.
4. **Atlas eviction during burst** — EPIC-B stress; 500-cell frame with 100 % atlas miss must not drop a frame (CPU-raster fast path §7.6).
5. **SGR state-variant explosion** — EPIC-C attrs-bits overflow check; 8-bit attrs packed, no room for underline-color variants. Variant overflow → single extra atlas key class, benchmarked.
6. **Instanced draw-call batching wrong** — EPIC-C draw-call-count assertion; steady-state ≤ 3 `drawArraysInstanced` per frame (bg fill, glyphs, cursor+overlay merged).
7. **Integrated-GPU perf cliff** — EPIC-E perf harness on Intel Iris / AMD Vega; must hit 60 fps baseline. Below = auto-fall-back (§11.3).
8. **High-DPI Retina rasterization artifacts** — EPIC-B DPR change test; 2× DPR full atlas drop + rebuild in ≤ 18 ms (§12).
9. **WebGPU feature detection collides with WebGL** — EPIC-F mount ordering: detect WebGPU first (if `experimental.renderer = 'webgpu'`), WebGL second, Canvas2D last. Covered by §15.
10. **Lost overlay handle during IME burst** — EPIC-D; mount/update/unmount overlay across shader rebind must not leak a GL resource. EPIC-D DoD item.
11. **Theme change mid-render** — EPIC-C; fg/bg uniforms update on next frame; atlas survives (per §10); bench asserts < 2 ms swap.
12. **Cursor blink desynchronization with Canvas2D** — EPIC-D visual-parity test; cursor phase derived from `performance.now() % 1000` identically in both backends.
13. **Wide-char right-half cell mis-instanced** — EPIC-C; wide cells emit ONE instance with `cellsWide = 2`, never two unit instances. Assertion in cell-buffer → instance encoder.
14. **Selection rect crosses page boundary** — EPIC-D; selection overlay rect drawn in viewport space, not atlas space; unaffected by page swap.
15. **Font-load mid-paint causes atlas tearing** — EPIC-B; `document.fonts.ready` fires → invalidateAll before next `requestDamageFlush`, not mid-frame. CPU-raster fallback (§7.6) covers the gap frame.
16. **Mobile Safari WebGL2 feature gap** — EPIC-A detection ≥ iOS 15; older iOS falls back silently.
17. **Driver-level memory exhaustion** — EPIC-B; atlas page cap + LRU page drop bounds VRAM at N_pages × 4 MB. EPIC-B DoD item.
18. **Offscreen `canvas` taint (CORS) blocks atlas upload** — EPIC-B; rasterization uses in-process OffscreenCanvas; no external image sources.
19. **Rapid resize causes viewport uniform drift** — EPIC-C; `applyMetrics` updates uniforms + VBO row/col range in a single frame; no partial state visible.
20. **Perf regression gate regression** — EPIC-E; bench results gated in CI; any perf miss > 10 % on p95 fails the PR.
21. **`data-renderer="webgl"` flag left enabled in tests** — EPIC-F; e2e tests default to `canvas`; WebGL tests opt-in. Prevents non-deterministic test failures due to driver differences.
22. **Context-loss happens during snapshot apply** — EPIC-F; fault injection mid-apply; recovery must re-apply the snapshot after Canvas2D mounts.
23. **`webglcontextrestored` attempt to re-mount WebGL corrupts state** — EPIC-F; policy is no auto-remount in-session. Require user reload.
24. **Telemetry counter for `backend.perf_fallback` misfires on cold start** — EPIC-F; 5 s warmup window excluded from perf-cliff detection.

## 15. WebGPU bridge (RFC 0002.1 placeholder)

WebGPU drops into the same `BackendContract`. This RFC does not ship a WebGPU backend but commits to a shim-preserving design:

### 15.1 API shim

- `BackendContract` stays language-neutral (no WebGL-only types leak). Any GL-specific primitive in `WebGLBackend.ts` stays private.
- The atlas page model (§7) maps directly to WebGPU `GPUTexture` / `GPUTextureView`.
- Instancing (§8) maps to WebGPU `vertexBuffers` + `drawIndexedIndirect`.
- Shaders translate WGSL ↔ GLSL ES via a source-level adapter we maintain by hand (ShaderPair helper in EPIC-C; ~200 LOC).

### 15.2 Selection

`experimental.renderer = 'webgpu' | 'webgl' | 'canvas'`. Default stays `canvas` forever until an explicit follow-up RFC flips it.

### 15.3 Feature detection order

On mount with `webgpu` selection: try WebGPU, fall back WebGL, fall back Canvas2D.

### 15.4 Why deferred

- Browser coverage: Safari shipped WebGPU in 2024; mobile Safari staged through 2025. Desktop Chrome/Edge/Firefox stable. Coverage adequate for opt-in but not for default.
- Shader debug tooling: WebGL2 is better-understood than WGSL today; ship WebGL first, learn, add WebGPU behind the same contract.

RFC 0002.1 will carry the WebGPU body. §15 here is only the contract-preservation commitment.

## 16. Rollback plan

Canvas2D is always available. Rollback is **one setting flip**: `experimental.renderer = 'canvas'`. Unlike xterm (which had to be ripped out of the tree in RFC 0001 §17 Phase 6), Canvas2D is not going anywhere this RFC. Rollback therefore looks like:

1. Flip setting → WebGL unmounts → Canvas2D mounts → last snapshot re-applied → session resumes.
2. If WebGL codepath is quarantined as harmful, mark `experimental.renderer = 'canvas'` as forced and disable the 'webgl' option in settings UI behind a build flag.
3. If we need to delete the WebGL code entirely, the `BackendContract` surface doesn't change; only `WebGLBackend.ts` + its deps + its tests are removed. Contract parity suite continues to pass with Canvas2D + Memory backends alone.

No rollback plan touches `quanta-vt`, the mirror, or any ADR. This is a paint-layer-only RFC, with paint-layer-only rollback.

## 17. Migration plan — 6 phases (parallel to RFC 0001 structure)

Unlike RFC 0001 (which had to land a whole VT engine), RFC 0002 is a plug-in. Phases are shorter.

### Phase A — Backend contract audit (~4 d)
- Verify `BackendContract.ts` is WebGL-shaped. Add hooks only where needed (§17 of EPIC-A).
- Update ADR 0016 companion note if needed (likely only a reference to §12 of this RFC).
- Second no-op backend (`WebGLStubBackend`) compiles and passes the parity suite empty.
- **Exit**: `backend-contract.test.ts` includes a WebGLStub entry; green.

### Phase B — GPU atlas (~1.5 w)
- `crates/quanta-ui/packages/ui/src/shared/ui/cell-renderer/backend/webgl/FontAtlasGpu.ts` (texture pages + LRU + page eviction).
- DPR / theme / font-family / font-load invalidation hooks.
- CPU-rasterize fast path when raster > 4 ms.
- **Exit**: atlas bench green (§12 stage "Raster atlas hit"); LRU eviction stress test passes under 500-cell burst.

### Phase C — Glyph instancing (~2 w)
- VBO + shader pair + instance-encoder from `CellBuffer`.
- Truecolor path, SGR attrs bit-pack, selection/cursor shape uniforms.
- **Exit**: cross-backend pixel diff ≤ 1 ± across RFC 0001 compat golden corpus; all `backend-contract.test.ts` cases green on `WebGLBackend`.

### Phase D — Overlays (~1 w)
- Three draw passes: cells / cursor / overlay (selection + IME + hover).
- z-order + alpha-blend match Canvas2D byte-for-byte.
- **Exit**: selection / IME / hyperlink parity tests green identical to Canvas2D.

### Phase E — Perf baseline (~1 w)
- Criterion-style bench harness for every §12 stage.
- Real-load harnesses (§12 list).
- Device matrix captured in `docs/plans/0002-webgl-renderer/device-matrix.md`.
- **Exit**: §12 table populated with measured WebGL numbers; every stage meets target p95.

### Phase F — Rollout flag + fallback (~1 w)
- `experimental.renderer` setting wiring end to end.
- `webglcontextlost` fault injection + recovery.
- Perf-cliff auto-fallback.
- Telemetry counters (§9, RFC 0001 §13.14 extended with `backend` tag).
- **Exit**: §14 gate ALL-TRUE on M-series Mac + Intel Iris Windows. Auto-fallback fires correctly in fault injection.

### Wall-clock

Sequential: A → B → C → D → E → F.
Parallel tracks: E (perf) starts after C freezes VBO layout; F (flag + fallback) starts after A freezes detection hooks.
**Total ≈ 6–7 weeks + 1.5 weeks contingency.**

## 18. Testing strategy

- **Unit** — every class in the WebGL backend has co-located tests. Coverage ≥ 90 %.
- **Parity** — `backend-contract.test.ts` runs against Canvas2D, Memory, WebGL (with `webgl-mock` in CI + real WebGL on a gated "real-gpu" lane).
- **Pixel diff** — `cross-backend-pixel-diff.test.ts` replays the golden PTY stream through both backends and diffs canvas pixels ± 1.
- **Fault injection** — `webglcontextlost` via `WEBGL_lose_context` extension; shader-compile-fail via deliberate bad GLSL; OOM via synthetic atlas explosion.
- **Perf** — every §12 bench runs in CI (tagged `@slow`; gated once per nightly). Regression > 10 % fails the PR.
- **Device matrix** — manual + BrowserStack lane for mobile; documented per EPIC-E.
- **Side-by-side** — RFC 0001 §13.11 harness extended with `backend=webgl|canvas` dimension.

## 19. Risks

- **Browser coverage** — WebGL2 + `EXT_color_buffer_float` + vertex array textures. Coverage ≥ 95 % of target-desktop browsers in 2026; mobile Safari ≥ iOS 15. Below bar → Canvas2D stays default. Monitored.
- **Driver quirks** — Intel Iris + Mesa + Windows combinations have known shader-compile eccentricities. Detection suite is defensive; fallback path is the escape valve.
- **Shader debugging** — WebGL2 tooling is mature but slower than Canvas2D devtools. Mitigated by the MemoryBackend + parity suite catching non-GPU bugs before they touch the GPU path.
- **Atlas fragmentation** — LRU + page drop policy bounded; worst-case simulated in EPIC-B stress.
- **Context-loss storms** — driver-induced loss cycling. Detection: no auto-remount in-session + 5 s warmup in perf-cliff detector + ADR 0019-level operator policy.
- **Telemetry namespace collision** — existing RFC 0001 §13.14 counters gain a `backend` tag rather than fork; reviewed in EPIC-F.
- **WebGPU arrives faster than planned** — if WebGPU hits 95 % coverage in 2026-Q3, we fast-track RFC 0002.1. Not a risk to this RFC; just a follow-up schedule.

## 20. Acceptance gate (hard gate)

WebGL ships to the `experimental.renderer = 'webgl'` opt-in only when ALL of:

- [ ] Cross-backend pixel diff zero across RFC 0001 §13.9 compat matrix.
- [ ] §12 perf targets green on M-series Mac + Intel Iris Windows + Intel Iris macOS.
- [ ] `webglcontextlost` fault injection recovers in ≤ 1 frame, zero data loss, visible single-frame swap only.
- [ ] Auto-fallback on perf cliff verified under 2× slowdown injection.
- [ ] Canvas2D fallback path mount time ≤ 20 ms post-unmount.
- [ ] `experimental.renderer` setting persists; user-toggleable in settings UI; telemetry counters emit.
- [ ] ADR 0019 accepted.
- [ ] ADR 0020 (atlas eviction) accepted.
- [ ] All `backend-contract.test.ts` invariant cases green on WebGLBackend.
- [ ] Selection / copy / search / hyperlink parity suite green on WebGLBackend.
- [ ] No new `BackendContract` method lacks a Canvas2D / Memory implementation.
- [ ] Mobile matrix (iOS 15+ Safari, Android Chrome with WebGL2) green or cleanly falls back.
- [ ] Internal dogfood ≥ 1 week clean on WebGL.
- [ ] Context-lost incident rate < 1 / 24 h on the dogfood fleet.
- [ ] No selection/search/copy regression detected across 1 week.

Any single FALSE = no 'webgl' option in production settings. Canvas2D remains sole shipping backend. No part of this RFC alters RFC 0001's §19 xterm-removal decision; §20 is additive only.

## 21. Non-negotiable UX preservations

Paint-backend swap is **invisible to the user** except:

- Settings menu has a new `experimental.renderer` row.
- A diagnostic banner appears if an auto-fallback fires.

Nothing else changes:

- Fonts — same font-family + metrics.
- Colors — same theme + SGR → RGB mapping.
- Cursor — same shape + blink rate.
- Selection — same highlight color + anchor behavior.
- Hyperlinks — same hover + Cmd+click semantics.
- IME — same preedit + commit layout.
- Block chrome — same DOM anchoring via `cellToScreen`.

Any UX-visible difference is a bug.

## 22. Cross-references back into RFC 0001

Everything load-bearing from RFC 0001 this RFC relies on:

- **§2 invariants** — I-1 through I-10 inherited verbatim.
- **§3 SSOT boundaries** — paint truth (§3.4) is the only RFC 0001 authority this RFC writes to.
- **§5 six-axis success** — this RFC has its own six-axis structure at §13; same shape.
- **§10 performance** — stretch targets at §4.1 are RFC 0001's stretch line.
- **§12 renderer backend contract** — the entire socket this RFC plugs into.
- **§13.8 selection / copy** — preserved; parity tested.
- **§13.11 side-by-side diff** — extended with `backend` dimension for cross-backend verification.
- **§13.12 performance gate** — baseline; this RFC tightens, does not weaken.
- **§13.13 performance budget decomposition** — schema reused at §12.
- **§13.14 telemetry** — counters inherited; `backend` tag added.
- **§14.1 SHOULD — renderer items** — GPU-optimized atlas + damage-based redraw items naturally satisfied by this RFC.
- **§15 DEFER — GPU renderer (WebGL/WebGPU) — RFC 0002** — this RFC closes that DEFER line.
- **§19 xterm-removal gate** — unchanged; this RFC ships after §19 ALL-TRUE.
- **§20 degraded mode contract** — WebGL fallback is a degraded-mode transition; inherits the "no black screen" rule.
- **§22 #19 — web-font late load causes atlas flash** — §7.6 CPU-rasterize fast path handles this for WebGL identically to Canvas2D.

## 23. Six-axis summary

Success / failure turns on:

1. **Correctness parity** — pixels match Canvas2D ± 1.
2. **Perf budget** — stretch targets met.
3. **Context-loss recovery** — fallback invisible.
4. **Device coverage** — mobile + integrated + desktop green.
5. **Rollout hygiene** — setting + telemetry + auto-fallback.
6. **No regression** — selection / search / copy / hyperlink / IME all parity-green.

Every epic, phase, test, gate above serves one of these six.

---

## 24. Appendix A — Shader uniform & attribute reference

Canonical list. Every uniform / attribute appears here exactly once; naming collisions are a review-blocking defect.

### 24.1 Cells pass uniforms

| Name | Type | Update rate | Owner | Purpose |
|------|------|-------------|-------|---------|
| `u_viewportPx` | `vec2` | on resize | EPIC-C | Viewport in device pixels. |
| `u_cellSizePx` | `vec2` | on resize + DPR | EPIC-C | Single-cell size in device pixels. |
| `u_dpr` | `float` | on DPR change | EPIC-C | Current device pixel ratio. |
| `u_atlas` | `sampler2DArray` | on page bind | EPIC-B/C | Glyph atlas texture array. |
| `u_bgBase` | `vec4` | on theme change | EPIC-C | Default background color. |
| `u_fgBase` | `vec4` | on theme change | EPIC-C | Default foreground color. |
| `u_overlay` | `int` | per-pass | EPIC-D | 0 = cells, 1 = IME overlay. |
| `u_selectionColor` | `vec4` | on theme change | EPIC-D | Selection rectangle tint. |

### 24.2 Cells pass per-instance attributes

| Name | Type | Source | Purpose |
|------|------|--------|---------|
| `a_quadCorner` | `vec2` | per-vertex (static VBO) | Unit quad 0/0, 1/0, 0/1, 1/1 corners. |
| `a_cellOrigin` | `vec2` | per-instance | Top-left in cell units. |
| `a_atlasPage` | `float` | per-instance | Index into `u_atlas` array. |
| `a_atlasU` | `float` | per-instance | Page-normalized u. |
| `a_atlasV` | `float` | per-instance | Page-normalized v. |
| `a_fgRGBA` | `vec4` | per-instance | Premultiplied foreground. |
| `a_bgRGBA` | `vec4` | per-instance | Premultiplied background. |
| `a_attrsBits` | `float` | per-instance | Packed SGR bitfield (see §24.4). |
| `a_cellsWide` | `float` | per-instance | 1 or 2. |

### 24.3 Cursor pass uniforms

| Name | Type | Update rate | Purpose |
|------|------|-------------|---------|
| `u_cursorShape` | `int` | on mode change | 0 block, 1 bar, 2 underline, 3 hollow-unfocused. |
| `u_cursorBlinkPhase` | `float` | per-frame | `(now % 1000) / 1000`. |
| `u_cursorColor` | `vec4` | on theme change | Cursor tint. |
| `u_cursorVisible` | `int` | on cursor visible transition | 0/1 gate. |

### 24.4 `attrsBits` layout

Packed bitfield, LSB first:

| Bit | Meaning |
|-----|---------|
| 0 | bold |
| 1 | italic |
| 2 | underline |
| 3 | strikethrough |
| 4 | faint |
| 5 | double-underline |
| 6 | inverse (resolved CPU-side; bit retained for shader-side double-check) |
| 7 | reserved (used by `u_overlay` flag path in overlay pass) |

Overflow policy: if an 8-bit budget is insufficient (extended decorations, per-cell underline color), the encoder emits a fallback glyph with the base attrs and records a telemetry counter `backend.attrs_variant_overflow`. A follow-up RFC widens `attrsBits` to u16 if the counter trends non-zero.

### 24.5 Invariants

- **Every uniform named in this appendix has exactly one writer.** Two writers = race; forbidden.
- **Every per-instance attribute is written by `CellInstanceEncoder`.** No shortcut paths.
- **No shader samples from two atlas pages in one draw call.** One page per draw, N draws for N pages.

## 25. Appendix B — Fault-injection catalogue (for CI + dogfood)

Every failure mode in §14 has a reproducible injection. Inventory:

| # | Fault | Injection site | Entry point |
|---|-------|----------------|-------------|
| 1 | Lost GL context | `WEBGL_lose_context.loseContext()` | `packages/ui/src/__tests__/e2e/context-loss-recovery.e2e.test.tsx` |
| 2 | Shader compile fail | stub `ShaderProgram.compile` returns error | `packages/ui/src/shared/ui/cell-renderer/backend/webgl/__tests__/ShaderProgram.test.ts` |
| 3 | Texture size < 1024 | mock `gl.getParameter(MAX_TEXTURE_SIZE) = 512` | `FeatureDetect.test.ts` |
| 4 | Atlas burst | fixture with 500 unique graphemes | `FontAtlasGpu.stress.test.ts` |
| 5 | SGR overflow | synthetic cell with all reserved bits set | `SGREncoder.test.ts` |
| 6 | Draw-call overrun | synthetic 5 passes | `DrawCallBudget.test.ts` |
| 7 | Perf cliff | `performance.now` stub returns +32 ms per frame | `perf-cliff-fallback.e2e.test.tsx` |
| 8 | Retina swap | matchMedia event + `devicePixelRatio` mock | `atlas-dpr-change.e2e.test.tsx` |
| 9 | WebGPU collision | setting `'webgpu'` with WebGPU disabled | `feature-detect-fallback.e2e.test.tsx` |
| 10 | IME burst | 100 mountOverlay/update/unmount cycles | `webgl-ime-lifecycle.e2e.test.tsx` |
| 11 | Theme swap | mode update with new bg/fg | `webgl-theme-swap.e2e.test.tsx` |
| 12 | Blink desync | phase injection + diff vs Canvas2D | `webgl-cursor-blink.e2e.test.tsx` |
| 13 | Wide-char encoding | `한` + `👨‍👩‍👧‍👦` grid | `webgl-wide-char.e2e.test.tsx` |
| 14 | Selection page-cross | selection rect on cell whose atlas page just dropped | `webgl-selection-multiline.e2e.test.tsx` |
| 15 | Font-load mid-paint | `document.fonts.ready` stub fires mid-session | `atlas-font-load.e2e.test.tsx` |
| 16 | Mobile gap | mock iOS 14 detection | `feature-detect-fallback.e2e.test.tsx` |
| 17 | VRAM exhaustion | 5-page burst request | `FontAtlasGpu.stress.test.ts` |
| 18 | Taint | cross-origin font URL → rasterizer rejects | `AtlasRasterizer.test.ts` |
| 19 | Rapid resize | 50 resize events | `webgl-rapid-resize.e2e.test.tsx` |
| 20 | Perf regression | slow branch in encoder | `perf-gate.test.ts` |
| 21 | Test-default WebGL leak | CI snapshot check | `tools/ci/perf-gate.ts` audit |
| 22 | Context-lost mid-apply | lose during `applyGridSnapshot` | `context-loss-recovery.e2e.test.tsx` |
| 23 | Auto-remount storm | `webglcontextrestored` event | `webgl-context-restored-no-remount.e2e.test.tsx` |
| 24 | Cold-start perf false fire | detector reading pre-warmup | `cold-start-detect-ok.e2e.test.tsx` |

## 26. Appendix C — Open questions (post-RFC freeze)

Non-blocking for RFC acceptance but flagged for review during EPIC-A:

- Should shader sources be validated at build time (via a `glslang` CLI invocation in CI) or only at runtime? Recommendation: both; CI at build, runtime as a defense-in-depth. Decision tagged in EPIC-C.
- Should the cursor pass and overlay pass merge into a single draw call with a uniform-driven branch, or stay separate draws? Separate preserves debugging clarity; merged saves one call. Decision tagged in EPIC-D.
- What is the boundary for "atlas miss storm"? Is a counter-based auto-fallback useful, or does the CPU fast-path alone suffice? Decision: CPU fast-path alone for v1; telemetry will tell us by EPIC-F dogfood.
- Can we ship a software-WebGL fallback (e.g. Chromium SwiftShader) as an additional tier between WebGL-hardware and Canvas2D? RFC answer: no, SwiftShader ≠ faster than Canvas2D and adds complexity; rejected. Captured here for closure.
- Do we ship a "force WebGL" debug toggle for internal QA? Yes, behind a developer-only setting; EPIC-F decides surface.

## 27. Appendix D — Benchmark filenames reference

Every perf number in §12 maps to a bench path. Listed explicitly so reviewers can mechanically verify:

- Raster (atlas hit) → `packages/ui/src/shared/ui/cell-renderer/__benches__/raster-hit.bench.ts`
- Raster (atlas miss) → `packages/ui/src/shared/ui/cell-renderer/__benches__/raster-miss.bench.ts`
- Cell blit / instance upload → `packages/ui/src/shared/ui/cell-renderer/__benches__/blit.bench.ts`
- Cursor pass → `packages/ui/src/shared/ui/cell-renderer/__benches__/cursor-pass.bench.ts`
- Overlay pass → `packages/ui/src/shared/ui/cell-renderer/__benches__/overlay-pass.bench.ts`
- Atlas miss recovery → `packages/ui/src/shared/ui/cell-renderer/__benches__/atlas-miss-recovery.bench.ts`
- Font-atlas rebuild → `packages/ui/src/shared/ui/cell-renderer/__benches__/atlas-rebuild.bench.ts`
- Context-loss recovery → `packages/ui/src/shared/ui/cell-renderer/__benches__/context-loss-recovery.bench.ts`
- Full-snapshot fallback → `packages/ui/src/shared/ui/cell-renderer/__benches__/full-snapshot.bench.ts`
- Hit-test → `packages/ui/src/shared/ui/cell-renderer/__benches__/hit-test.bench.ts`
- Reducer / apply-delta → `packages/ui/src/shared/lib/grid-mirror/__benches__/apply-delta.bench.ts`
- Yes | head -10000 sustained → `packages/ui/src/__tests__/perf/yes-head-10000.perf.ts`
- Keystroke → paint → `packages/ui/src/__tests__/perf/keystroke-roundtrip.perf.ts`
- Vim edit session → `packages/ui/src/__tests__/perf/vim-edit-session.perf.ts`
- Tmux pane resize → `packages/ui/src/__tests__/perf/tmux-pane-resize.perf.ts`
- Htop refresh → `packages/ui/src/__tests__/perf/htop-refresh.perf.ts`
- Cold start → `packages/ui/src/__tests__/perf/cold-start.perf.ts`
- Memory 10 k scrollback → `packages/ui/src/__tests__/perf/memory-10k-scrollback.perf.ts`
- Backend swap recovery → `packages/ui/src/__tests__/perf/switch-backend-recovery.perf.ts`

If any bench in RFC 0002 §12 lacks a filename in this appendix, the RFC does not freeze.

## 28. Appendix E — Telemetry counter taxonomy

Extends RFC 0001 §13.14. All names tagged `backend=canvas|webgl` unless noted.

- `backend.mount_ok{backend}` — successful mount.
- `backend.mount_fallback{reason}` — mount-time fallback; reason ∈ {`no_webgl2`, `missing_extension`, `shader_compile`, `texture_too_small`, `sentinel_roundtrip_fail`, `unknown`}.
- `backend.context_lost` — `webglcontextlost` event.
- `backend.context_restored` — `webglcontextrestored` event; no remount.
- `backend.perf_fallback` — perf-cliff auto-fallback fired.
- `backend.manual_fallback` — user toggled setting.
- `backend.atlas_page_drop_count` — incremented each page drop.
- `backend.atlas_miss_count` — atlas-miss rasterizations (steady-state visible).
- `backend.cpu_fast_path_hit` — CPU rasterizer used for a frame due to slow GPU raster.
- `backend.attrs_variant_overflow` — SGR variant exceeded 8-bit budget.
- `backend.draw_call_over_budget` — dev-only; steady-state > 4 draws.

RFC 0001 §13.14 existing counters (unknown CSI, full-redraw, etc.) continue to apply identically across backends.

## 29. Appendix F — "Warp-class" reference comparison

Stakeholder-asked comparison; not a gate, for context:

| Target | Canvas2D today | WebGL stretch | Warp reference (observed) |
|--------|----------------|---------------|---------------------------|
| Cold start | ~110 ms | ≤ 80 ms | ~75 ms |
| Keystroke p95 | ~12 ms | ≤ 8 ms | ~6 ms |
| `yes \| head -10000` fps | ~72 fps | ≥ 120 fps | ~120 fps |
| 10 k scrollback memory | ~18 MB | ≤ 12 MB | ~10 MB |

Stretch brings us to Warp parity without bespoke-GPU engineering; the architecture is the same `BackendContract` we already ship. This is the strategic argument for RFC 0002's timing.

## 30. Appendix G — What this RFC explicitly does NOT do

- Does not alter `quanta-vt` — any line, any module, any test.
- Does not alter `GridMirror`, `CellBuffer`, `DamageSet`, `Selection`, `HitTest`, `Search`, `FontAtlas` (Canvas2D).
- Does not alter the input encoder, IME state machine, or bracketed-paste logic.
- Does not alter block chrome, terminal-page layout, or any feature module under `packages/ui/src/features/**`.
- Does not alter RFC 0001's §19 xterm-removal gate or any ADR from RFC 0001.
- Does not spawn a WebGPU backend in v1 (§15 is contract-preservation only).
- Does not change the default renderer; Canvas2D remains default through this RFC's lifetime.

Anything outside this appendix's enumeration is in scope; anything inside this appendix's enumeration is out of scope.

## 31. Appendix H — Reading guide for reviewers

- Skim §0–§5 first (Purpose → Non-goals). 20-minute read.
- Then §6 (Architecture) + §12 (Perf budget) + §14 (Failure modes) + §20 (Acceptance gate). Another 30 minutes.
- Then appendices A–C for technical detail. 20 minutes.
- Total reviewer load ≈ 1 h 10 min.

Implementation agents should additionally read:

- `docs/plans/0002-webgl-renderer/README.md` — dependency graph.
- The epic file for the phase they own.
- RFC 0001 §12 (contract), §13.11–§13.14 (perf / telemetry), §19 (gate pattern).

---

**Next step**: sign-off on §2 (invariants) + §11 (fallback policy) + §14 (failure-mode checklist) + §17 (phase plan) + §20 (acceptance gate) freezes the contract and authorizes EPIC-A kickoff.
