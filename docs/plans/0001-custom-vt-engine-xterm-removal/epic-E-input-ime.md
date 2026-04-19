# EPIC-E Design — Input Encoder + IME

- **Status**: Design-ahead (Gear 3). Freezes contracts for the `packages/ui/src/features/input/` tree and the IME state-machine surface.
- **Date**: 2026-04-19
- **Related**: RFC 0001 §2 (invariants I-6 input-encoder-mandatory, I-7 preedit-never-enters-grid), §9 (reducer ordering, snapshot-based mode reads), §10 (IME state machine authority), §13.5 (input encoding), §13.6 (IME), §13.14 (telemetry), ADR 0017 (reducer ordering + mode authority), ADR 0018 (IME state machine — see Deliverable 2 of this phase), RFC 0001 Epic Plan — Epic E, EPIC-C Design (`docs/rfc/epics/epic-C-protocol-mirror-design.md` §1.2, §4.1, §4.2 for `getMode()` + `snapshotMode()`).
- **Blocks**: `packages/ui/src/features/input/**` implementation agent (Phase 3).

One-paragraph read: the browser sees raw DOM events. This document specifies how those events become PTY bytes, under what mode-state truth, and how IME composition events are kept out of the grid and out of the PTY wire until a commit fires. The key-encoding surface is three modes (legacy xterm, modifyOtherKeys=2, kitty levels 1-3). The mode snapshot is one-shot frozen, read from the EPIC-C `GridMirror` via `snapshotMode()`. The IME state machine is an exhaustive transition table backed by per-platform blur policy. All of it is covered by an input-matrix fixture + IME recording fixtures that feed CI.

---

## 1. File layout

All files under `packages/ui/src/features/input/`.

| File | Purpose |
|---|---|
| `KeyEncoder.ts` | `KeyEvent + TerminalModeSnapshot → EncoderOutput`. Implements §3 algorithm + sub-encoders for legacy / modifyOtherKeys-v2 / kitty 1-3. Pure; no DOM access. |
| `MouseEncoder.ts` | `MouseEvent + TerminalModeSnapshot → EncoderOutput`. SGR 1006 primary. Wheel-to-cursor-key fallback when mouse tracking off. |
| `Paste.ts` | Bracketed paste wrapper. Wraps text with `ESC [ 200 ~ ... ESC [ 201 ~` when DECSET 2004 is on. Filters nested sentinels from payload per xterm convention. |
| `Focus.ts` | Focus in/out encoder. Emits `ESC [ I` / `ESC [ O` iff DECSET 1004 is on. |
| `ModeSnapshot.ts` | One-shot `read()` that returns a deep-frozen `TerminalModeSnapshot`. Wraps `GridMirror.snapshotMode()` from EPIC-C §4.1. |
| `input-host.ts` | Top-level DOM binding. Subscribes to `keydown`, `keypress`, `keyup`, `pointerdown/up/move`, `wheel`, `paste`, `focus`, `blur`, `compositionstart/update/end`. Wires into the encoders + IME state machine. Single DOM-attached orchestrator. |
| `index.ts` | Barrel exports of public types + classes (`KeyEncoder`, `MouseEncoder`, `Paste`, `Focus`, `ModeSnapshot`, `InputHost`, `ImeStateMachine`, `PreeditOverlay`). |
| `ime/ImeStateMachine.ts` | Pure state machine. `transition(currentState, event): { nextState, sideEffects }`. No DOM, no encoder imports. |
| `ime/PreeditOverlay.tsx` | React view component; pure; props-driven. §6 contract. |
| `ime/ime-types.ts` | Shared types (`ImeState`, `ImeEvent`, `ImeSideEffect`, `PreeditOverlayProps`). |
| `ime/index.ts` | Barrel for the IME submodule. |
| `fixtures/input-matrix.template.json` | Template schema + seed ≥ 40 cases. Impl agent expands to 800+. See §8. |
| `fixtures/ime-recordings/<id>.json` | One file per recorded IME session. Six seed recordings enumerated in §9. |

Tests — under `packages/ui/src/features/input/__tests__/`:

| File | Scope |
|---|---|
| `KeyEncoder.test.ts` | Loop over `input-matrix.template.json` + all expansions; byte-parity assertions. |
| `MouseEncoder.test.ts` | ≥ 20 SGR 1006 cases across button × modifier × kind. |
| `Paste.test.ts` | 6 cases: bracketed on/off × payload variants. |
| `Focus.test.ts` | 4 cases: DECSET 1004 on/off × focus/blur. |
| `ModeSnapshot.test.ts` | Snapshot-based read: live mirror mutation after `read()` does not leak into encoded output. |
| `ime/ImeStateMachine.test.ts` | ≥ 20 transition cases covering every row of §5 table. |
| `ime/korean-2set.recording.test.ts` | Replays Korean 2-set recordings, asserts PTY bytes + overlay states. |
| `ime/jp-ime.recording.test.ts` | JP IME recordings. |
| `ime/cn-pinyin.recording.test.ts` | CN pinyin recordings. |
| `ime/deadkey.test.ts` | 3 dead-key cases. |
| `ime/blur-policy.test.ts` | macOS cancel vs Linux/Windows preserve-1s. |
| `ime/sidecar-restart.test.ts` | Mid-composition disconnect → Cancelled + banner. |
| `ime/PreeditOverlay.test.tsx` | Pure-view: given props, overlay renders at right position with correct dim/underline styling. |
| `input-host.test.ts` | Integration: DOM event dispatch → encoder + state machine wiring. Uses jsdom. |

---

## 2. Type contracts

All types are exported from `index.ts` and, where marked, aligned with EPIC-C's `GridMirror.snapshotMode()` output (see EPIC-C §4.1, §4.2, §3.1 for the wire shape).

### 2.1 `KeyEvent`

```ts
/**
 * Normalized key event. Created by input-host.ts from DOM KeyboardEvent.
 * Modifier flags match DOM semantics; `key` and `code` are DOM conventions;
 * `isComposing` mirrors DOM KeyboardEvent.isComposing — when true the KeyEncoder
 * MUST suppress PTY emission (invariant I-7).
 */
export interface KeyEvent {
  /** DOM KeyboardEvent.key — printable glyph or named key ("Enter", "ArrowUp", "F1", ...). */
  key: string;
  /** DOM KeyboardEvent.code — physical-layout key identifier ("KeyA", "Digit1", "ArrowUp", "F1"). */
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  /** macOS Command / Windows Windows-key / Linux Super. */
  metaKey: boolean;
  shiftKey: boolean;
  /** Autorepeat. For kitty level ≥ 1 we emit repeat reports; other modes typically dedupe. */
  repeat: boolean;
  /** DOM KeyboardEvent.isComposing. When true, encoder returns empty bytes + diagnostic flag. */
  isComposing: boolean;
}
```

### 2.2 `MouseEvent`

```ts
/**
 * Cell-normalized mouse event. input-host.ts converts client coords to cell coords
 * via renderer.screenToCell() (EPIC-D contract). Modifiers are the same triplet
 * as KeyEvent for consistent bitmap construction.
 */
export interface MouseEvent {
  /** 0-based cell column. Encoder converts to 1-based per SGR 1006. */
  xCell: number;
  /** 0-based cell row. Encoder converts to 1-based per SGR 1006. */
  yCell: number;
  button: 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down';
  modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };
  kind: 'press' | 'release' | 'drag' | 'wheel';
}
```

### 2.3 `PasteEvent`

```ts
/**
 * Normalized paste event. Text is already unwrapped from DOM ClipboardEvent.
 * `length` is carried so telemetry can bin by size without re-measuring.
 */
export interface PasteEvent {
  text: string;
  length: number;
}
```

### 2.4 `FocusEvent`

```ts
export interface FocusEvent {
  focused: boolean;
}
```

### 2.5 `TerminalModeSnapshot`

Subset of EPIC-C's `TerminalModeState` (see EPIC-C §3.1 `mode_state` JSON shape, §4.1 `getMode()` / `snapshotMode()`, ADR 0017 §4 authority list). Only the flags the encoder actually reads are here; extending the snapshot is additive.

```ts
/**
 * Frozen snapshot of terminal mode flags relevant to input encoding.
 * MUST be structurally identical to the subset of GridMirror.snapshotMode() output
 * that covers key/mouse/paste/focus encoding decisions. Source of truth is ADR 0017 §4
 * and EPIC-C §3.1 mode_state JSON.
 *
 * Field names match EPIC-C wire form (snake_case ↔ camelCase mapping: EPIC-C wire is
 * snake_case; GridMirror deserialization camelCases on the TS boundary).
 *
 * Invariant: once returned by ModeSnapshot.read(), the object is deep-frozen.
 */
export interface TerminalModeSnapshot {
  /** DECCKM — cursor keys send ESC O A/B/C/D (application) instead of ESC [ A/B/C/D. */
  decckm: boolean;
  /** DECSET 2004 — bracketed paste. Paste.ts wraps payload with ESC [ 200~ / ESC [ 201~. */
  bracketedPaste: boolean;
  /** DECSET 1004 — focus reporting. Focus.ts emits ESC [ I / ESC [ O. */
  focusReporting: boolean;
  /** DECSET 1000 / 1002 / 1003 — aligned to EPIC-C MouseTrackingMode enum. */
  mouseTracking: 'off' | 'x10' | 'button_event' | 'any_event';
  /** DECSET 1005 / 1006 / 1015 — aligned to EPIC-C MouseEncoding enum. 'sgr' is the only supported non-default path in v1. */
  mouseEncoding: 'default' | 'utf8' | 'sgr' | 'url_xterm';
  /** xterm modifyOtherKeys: 0 = off, 1 = partial, 2 = full CSI 27 reporting. */
  modifyOtherKeys: 0 | 1 | 2;
  /** Kitty keyboard protocol level: 0 (off) | 1 (basic) | 2 (+ release) | 3 (+ alternates). Levels 4-5 deferred (see Epic E rollback). */
  kittyKeyboard: 0 | 1 | 2 | 3;
  /** Alt-screen active. Rarely affects encoding (mouse wheel fallback behavior differs). */
  altScreen: boolean;
  /** DECSET 2026 synchronized update in progress. Not read by encoder today; carried for parity. */
  synchronizedUpdate: boolean;
  /**
   * Opaque monotonic counter bumped by the mirror on every ModeChanged apply.
   * Encoder records this in diagnostics so a test can detect an inconsistency
   * between "snapshot taken" and "snapshot used" paths.
   */
  readonly snapshotEpoch: bigint;
}
```

**Alignment check vs EPIC-C §3.1**:
- EPIC-C wire `mode_state` uses `decckm`, `bracketed_paste`, `focus_reporting`, `mouse_tracking`, `mouse_encoding`, `modify_other_keys`, `kitty_keyboard`, `alt_screen`, `synchronized_update` — one-to-one with this snapshot modulo snake_case→camelCase. EPIC-C `TerminalModeStateWire` does not expose `snapshotEpoch`; that field is added by `ModeSnapshot.read()` at read time from the mirror's `appliedSequence` (EPIC-C §4.2 `GridMirrorState.appliedSequence`) — it is NOT on the wire.

### 2.6 `EncoderOutput`

```ts
/**
 * Uniform return of KeyEncoder / MouseEncoder / Paste / Focus.
 * Diagnostics are telemetry breadcrumbs; never gate emission.
 */
export interface EncoderOutput {
  /** Bytes to write to PTY. Empty Uint8Array means "suppress" (e.g., IME composing). */
  bytes: Uint8Array;
  diagnostics: {
    /**
     * True iff the snapshot's snapshotEpoch does not match the mirror's live
     * snapshotEpoch at the moment the encoder completed. In a single-threaded
     * JS runtime this SHOULD NEVER be true; if it flips, something is re-reading
     * mid-encode (test-only assertion).
     */
    modeReadInconsistency: boolean;
    /**
     * True iff the encoder produced a byte sequence using a fallback path
     * (e.g., kitty was requested but the key did not have a kitty-known code,
     * or wheel fallback to cursor keys fired because mouse tracking was off).
     */
    deprecatedFallback: boolean;
    /** Copy of the snapshot's snapshotEpoch, for traceability. */
    snapshotEpoch: bigint;
  };
}
```

### 2.7 `EncodingMode`

```ts
/**
 * Key-encoder selection. Chosen per-call based on TerminalModeSnapshot.
 * Precedence: kittyKeyboard >= 1 → kitty-{level}; else modifyOtherKeys === 2 →
 * modify-other-keys-v2; else legacy.
 */
export type EncodingMode =
  | 'legacy'
  | 'modify-other-keys-v2'
  | 'kitty-1'
  | 'kitty-2'
  | 'kitty-3';
```

---

## 3. KeyEncoder algorithm

### 3.1 Top-level dispatch

```
KeyEncoder.encode(event: KeyEvent, snapshot?: TerminalModeSnapshot) -> EncoderOutput:
  1. snapshot ??= ModeSnapshot.read()          // one-shot, no mid-encode re-read
  2. if event.isComposing:                     // invariant I-7 — preedit suppresses PTY
       return {
         bytes: new Uint8Array(0),
         diagnostics: { modeReadInconsistency: false, deprecatedFallback: false,
                        snapshotEpoch: snapshot.snapshotEpoch }
       }
  3. mode = selectMode(snapshot)
       if snapshot.kittyKeyboard >= 1:
         mode = ('kitty-' + snapshot.kittyKeyboard) as EncodingMode     // clamp to 1..3
       else if snapshot.modifyOtherKeys === 2:
         mode = 'modify-other-keys-v2'
       else:
         mode = 'legacy'
  4. bytes = dispatch(mode, event, snapshot)
  5. liveEpoch = ModeSnapshot.peekEpoch()
     modeReadInconsistency = (liveEpoch !== snapshot.snapshotEpoch)   // debug-only
  6. return { bytes, diagnostics: { modeReadInconsistency, deprecatedFallback, snapshotEpoch } }
```

`selectMode` is total; `dispatch` delegates to one of §3.2, §3.3, §3.4.

Invariant I-6 (RFC 0001 §2): every browser `KeyboardEvent` runs through this function. `input-host.ts` is the only DOM attach-point. No component, no hook, no bridge code is allowed to bypass to the PTY. Grep-enforceable: no other module imports `encodedInput.write` / the PTY-write bridge API.

### 3.2 Legacy xterm sub-encoder (`mode = 'legacy'`)

Rules — all byte values decimal unless hex-prefixed:

**Printables (no modifier)** — emit the UTF-8 bytes of `event.key`. Browsers already give composed UTF-8 in `KeyEvent.key` for non-dead-key input.

**Ctrl + letter A-Z (case-insensitive)** — emit the single byte `key.toUpperCase().charCodeAt(0) & 0x1F` (A=0x01 … Z=0x1A). Ctrl+Shift+letter aliases to Ctrl+letter under legacy (documented limitation; `modifyOtherKeys=2` disambiguates — see §3.3).

**Ctrl + `[`/`\`/`]`/`^`/`_`** — emit `0x1B`, `0x1C`, `0x1D`, `0x1E`, `0x1F` respectively. Ctrl+Space → `0x00`.

**Alt + X (no Ctrl)** — emit `ESC` (`0x1B`) followed by whatever X would emit without Alt. Applies to printables, Ctrl+letter, cursor keys.

**Cursor keys** — with DECCKM off: `ESC [ A` / `ESC [ B` / `ESC [ C` / `ESC [ D`. With DECCKM on: `ESC O A` / `ESC O B` / `ESC O C` / `ESC O D`.

**Modified cursor keys** — `CSI 1 ; <mod> {A|B|C|D}` form, where `<mod>` uses the bitmap in §3.3. Example: Shift+ArrowUp → `CSI 1 ; 2 A` = `ESC [ 1 ; 2 A`.

**Function keys F1-F4** — unmodified: `ESC O P` / `ESC O Q` / `ESC O R` / `ESC O S`. Modified: `ESC O 1 ; <mod> P` etc.

**Function keys F5-F12** — `ESC [ <code> ~` with codes 15, 17, 18, 19, 20, 21, 23, 24 respectively. Modified: `ESC [ <code> ; <mod> ~`.

**F13-F24** — extension table (codes 25, 26, 28, 29, 31, 32, 33, 34, 42, 43, 44, 45). Deferred from default build; emitted only when physical keyboard exposes them (rare).

**Special keys (Home/End/Ins/Del/PgUp/PgDn)**:
| Key | Unmodified | Modified |
|---|---|---|
| Home | `ESC [ H` or `ESC O H` (with DECCKM) | `ESC [ 1 ; <mod> H` |
| End | `ESC [ F` or `ESC O F` (with DECCKM) | `ESC [ 1 ; <mod> F` |
| Insert | `ESC [ 2 ~` | `ESC [ 2 ; <mod> ~` |
| Delete | `ESC [ 3 ~` | `ESC [ 3 ; <mod> ~` |
| PageUp | `ESC [ 5 ~` | `ESC [ 5 ; <mod> ~` |
| PageDown | `ESC [ 6 ~` | `ESC [ 6 ; <mod> ~` |

**Enter / Tab / Backspace / Escape / Delete — byte conventions**:
| Key | Byte(s) | Notes |
|---|---|---|
| Enter | `0x0D` (CR) | Line-discipline in shell translates to LF. If cursor-keys-mode inverts CR/LF (DECSCL), it's a shell concern not an encoder concern. |
| Shift+Enter | `0x0D` | Same under legacy; disambiguates under modifyOtherKeys=2. |
| Tab | `0x09` | |
| Shift+Tab | `ESC [ Z` | Back-tab convention. |
| **Backspace** | **`0x7F`** | **DECISION**: BS key emits DEL (0x7F). Most modern terminals and shells are configured for DEL. |
| **Ctrl+H** | **`0x08`** | Distinct from Backspace. |
| Escape | `0x1B` | |
| Space (no mod) | `0x20` | |
| Ctrl+Space | `0x00` | |

### 3.3 `modifyOtherKeys=2` sub-encoder (`mode = 'modify-other-keys-v2'`)

Base behavior mirrors legacy for **unmodified keys** and **cursor/function/special keys**. The divergence is for **modified printables and previously-ambiguous Ctrl+Shift+letter**.

**Modifier bitmap** (xterm convention):
| Bitmap | Modifiers |
|---|---|
| 1 | (unmodified — parameter omitted in most forms) |
| 2 | Shift |
| 3 | Alt |
| 4 | Shift + Alt |
| 5 | Control |
| 6 | Shift + Control |
| 7 | Alt + Control |
| 8 | Shift + Alt + Control |

Meta is not represented in xterm's bitmap; macOS Command is handled by the host menu bar and does not reach the encoder.

**Modified printable / ambiguous-control** keys → `CSI 27 ; <modifier> ; <keycode> ~` where `<keycode>` is the raw character code of the unmodified glyph (e.g., Ctrl+Shift+A → keycode 65, mod=6 → `ESC [ 27 ; 6 ; 65 ~`).

**Ctrl+letter (no Shift)** still emits the bare control byte under modifyOtherKeys=2 (shell compatibility); only the Shift-disambiguation path uses CSI 27.

**Enter/Tab/Backspace/Esc with modifiers** → CSI 27 with the respective keycodes (13 for Enter, 9 for Tab, 127 for Backspace, 27 for Escape). Unmodified bytes remain as in §3.2.

**Cursor / function / special keys** use the same CSI forms as §3.2 with the modifier parameter.

### 3.4 Kitty levels 1-3 sub-encoder (`mode = 'kitty-1' | 'kitty-2' | 'kitty-3'`)

General shape: `CSI <keycode> ; <modifier> [; <event-kind>] u` for printable + named keys. Cursor keys and F1-F4 retain their `ESC [ ... ` / `ESC O ... ` forms in level 1; level ≥ 2 may report them via `u` form.

**Level 1 — basic encoding**:
- Every key event emits `CSI <keycode> ; <mod> u`.
- Autorepeat repeats the press form (no release report at L1).
- Keycode = Unicode codepoint for printables; named table for Escape (27), Enter (13), Tab (9), Backspace (127), Arrow Up/Down/Right/Left (57352..57355 per kitty spec), F1-F12 (57364..57375), etc.
- See [kitty keyboard protocol spec](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) for the keycode table — implementation agent mirrors it into `KeyEncoder.ts` as a constant map.

**Level 2 — adds release reports**:
- Press: `CSI <keycode> ; <mod> u` (same as L1).
- Release: `CSI <keycode> ; <mod> ; 3 u` (`3` = release event kind).
- Autorepeat: `CSI <keycode> ; <mod> ; 2 u` (`2` = repeat event kind).

**Level 3 — adds alternate-layout reports**:
- Layout-shifted keys report the alternate codepoint alongside: `CSI <keycode> : <alternate> ; <mod> u`. Example: a German QWERTZ keyboard where KeyY physically types `Z` but US layout would type `Y` → reports both with `:` separator.
- The implementation consults `event.code` for the physical key and `event.key` for the current-layout glyph.

**Kitty modifier bitmap**:
| Bit | Modifier |
|---|---|
| 1 | Shift |
| 2 | Alt |
| 4 | Ctrl |
| 8 | Super (macOS Command / Windows Windows key / Linux Super) |
| 16 | Hyper |
| 32 | Meta |
| 64 | Caps Lock (rare) |
| 128 | Num Lock (rare) |

The emitted `<mod>` parameter = `(bitmap | 1)` per kitty convention (offset-by-1 so "no modifier" = 1).

**Kitty levels 4-5 NOT supported in v1** — see Epic E rollback. If `kittyKeyboard` reports > 3 on negotiation, the encoder clamps to 3 and sets `diagnostics.deprecatedFallback = true`.

### 3.5 Modifier bitmap construction (shared)

For legacy-CSI and modifyOtherKeys paths, the bitmap is xterm's (§3.3 table). For kitty it's the bit-field (§3.4 table). `KeyEncoder` exports pure helpers `xtermMod(event)` and `kittyMod(event)` so tests can assert bit construction independently of byte output.

---

## 4. MouseEncoder

### 4.1 SGR 1006 primary path (`snapshot.mouseTracking != 'off' && snapshot.mouseEncoding == 'sgr'`)

Form: `CSI < <Cb> ; <Cx> ; <Cy> M` for press/drag/wheel, `CSI < <Cb> ; <Cx> ; <Cy> m` for release.

- `<Cb>` base = button code | modifier flags:
  - Button codes:
    - `0` = left press
    - `1` = middle press
    - `2` = right press
    - `3` = release-any (legacy form only — SGR uses explicit button codes on release with the `m` terminator)
    - `32` base + button code = drag (with button held) — so `32` = left drag, `33` = middle drag, `34` = right drag.
    - `64` = wheel-up (no release event)
    - `65` = wheel-down (no release event)
  - Modifier flags OR'd into `<Cb>`:
    - `+4` = Shift
    - `+8` = Meta (macOS Opt per xterm convention — ADR 0009 documents keyboard meta)
    - `+16` = Ctrl
- `<Cx>` = 1-based column (`xCell + 1`)
- `<Cy>` = 1-based row (`yCell + 1`)

### 4.2 Tracking-mode gates

- `off` — click/drag are suppressed (empty bytes). Wheel falls through to §4.4.
- `x10` — press only; no release, no drag, no move.
- `button_event` (DECSET 1002) — press, release, drag-with-button.
- `any_event` (DECSET 1003) — press, release, drag, hover-move.

### 4.3 Worked example

**Click at cell `(xCell=3, yCell=5)`, left button, no modifiers, kind=press, SGR 1006 on** → `<Cb>` = 0, `<Cx>` = 4 (`3 + 1`), `<Cy>` = 6 (`5 + 1`) → `ESC [ < 0 ; 4 ; 6 M`. Byte sequence: `1B 5B 3C 30 3B 34 3B 36 4D`.

**Release at same position** → `ESC [ < 0 ; 4 ; 6 m` (lowercase `m`).

**Ctrl+Shift+Right-drag at (10, 20)** → `<Cb>` = 34 (drag) + 4 (Shift) + 16 (Ctrl) = 54. `ESC [ < 54 ; 11 ; 21 M`.

**Wheel-up at (0, 0), no modifiers** → `<Cb>` = 64, `ESC [ < 64 ; 1 ; 1 M` (no release event follows).

### 4.4 Wheel fallback when mouse tracking is off

When `snapshot.mouseTracking === 'off'`, wheel events synthesize cursor keys:
- `wheel-up` → three repetitions of ArrowUp (DECCKM-aware).
- `wheel-down` → three repetitions of ArrowDown.
- `diagnostics.deprecatedFallback = true`.

Three reps chosen to match common terminal scrollback-substitute UX on TUIs that don't opt into mouse tracking. Configurable via future preference; not in v1.

### 4.5 Clicks with tracking off

Clicks no-op with empty bytes. Selection / focus are handled by the UI layer, not this encoder.

---

## 5. IME state machine (ADR 0018 source of truth)

### 5.1 State set

- `Idle` — no composition active.
- `Composing` — overlay mounted, IME is editing. Sub-flag `persisted` set when Linux/Windows blur triggered 1s preserve path.
- `Committed` — transient, entered momentarily at `compositionend` with non-empty data. State machine immediately returns to `Idle` after side effects run.
- `Cancelled` — transient, entered on Esc / macOS-blur / empty-end / sidecar-disconnect. Also auto-returns to `Idle` after unmount side effect.

### 5.2 Events

| Event | Carries |
|---|---|
| `compositionstart` | `data: string` (often `""`) |
| `compositionupdate` | `data: string` (current preedit) |
| `compositionend` | `data: string` (final commit payload or `""` on cancel) |
| `keydown` | `KeyEvent` (handled specially for Escape + generic suppression) |
| `blur` | `{ platform: 'macos' \| 'windows' \| 'linux' }` |
| `focus` | — |
| `persist-timer-expired` | — (Linux/Windows only) |
| `sidecar-disconnect` | — |

### 5.3 Transition table

| # | From | Event | Guard | To | Side effects |
|---|---|---|---|---|---|
| T1 | Idle | `compositionstart(data)` | always | Composing | Mount overlay at `cellToScreen(cursor)` + line-height offset; overlay text = data; telemetry `ime.lifecycle_start++`. |
| T2 | Composing | `compositionupdate(data)` | always | Composing | Update overlay text to data. No PTY emission (invariant I-2). |
| T3 | Composing | `compositionend(data)`, `data.length > 0` | always | Committed → Idle | Emit bytes via `Paste.encode({ text: data, length: data.length }, snapshot)` (wraps in bracketed-paste sentinels iff DECSET 2004 on, per invariant I-4). Unmount overlay. `ime.lifecycle_commit++`; `ime.composition_duration_ms += now - startedAt`. |
| T4 | Composing | `compositionend(data)`, `data.length === 0` | always | Cancelled → Idle | Unmount overlay. `ime.lifecycle_cancel++`. |
| T5 | Composing | `keydown(Escape)` | always | Cancelled → Idle | Unmount overlay. `ime.lifecycle_cancel++`. Note: the keydown is SUPPRESSED (invariant I-7) — the Escape byte is NOT forwarded to PTY. |
| T6 | Composing | `keydown(*)` | any non-Escape | Composing | Event SUPPRESSED — no state change, no PTY emission (invariant I-7). |
| T7 | Composing | `blur()` | `platform === 'macos'` | Cancelled → Idle | Unmount overlay. `ime.lifecycle_cancel++`. Counter also bumps a sub-label `ime.lifecycle_cancel{reason="blur"}` for diagnosis. |
| T8 | Composing | `blur()` | `platform !== 'macos'` | Composing (sub-flag `persisted=true`) | Overlay dimmed (`dimmed=true` prop). Start 1000 ms `persist-timer`. |
| T9 | Composing{persisted} | `focus()` | timer not expired | Composing (clear `persisted`) | Undim overlay. Cancel timer. Re-anchor to current cursor position (cursor may have moved during blur — recompute `cellToScreen(cursor)`). |
| T10 | Composing{persisted} | `persist-timer-expired` | always | Cancelled → Idle | Unmount overlay. `ime.lifecycle_cancel{reason="blur_timeout"}++`. |
| T11 | Idle | `blur()` / `focus()` / `keydown(Escape)` | always | Idle | No-op. |
| T12 | Composing | `sidecar-disconnect` | always | Cancelled → Idle | Unmount overlay. Show banner "session restarted; re-enter text" (emits UI event, handled by shell layer). `ime.abnormal_termination++`. |
| T13 | Composing{persisted} | `sidecar-disconnect` | always | Cancelled → Idle | Same as T12. |
| T14 | Idle | `compositionend(data)` | (stray — browser sent end without start) | Idle | No-op. Log telemetry `ime.stray_end++` for debugging. |
| T15 | Composing | `compositionstart(data)` | (stray — nested start, shouldn't happen) | Composing | Treat as update: set overlay text to data. Log `ime.stray_nested_start++`. |
| T16 | Composing | `resize` | always | Composing | Recompute overlay anchor via `cellToScreen(cursor)`; composition state untouched. |
| T17 | Composing{persisted} | `resize` | always | Composing{persisted} | Same as T16; dimmed stays. |
| T18 | Any | `mode-change (DECSET 2004 on/off)` | always | unchanged | Snapshot re-read happens lazily on next commit; no in-flight effect. |

### 5.4 Invariant mapping (RFC 0001 §2 + ADR 0018)

- **I-1** (PTY bytes only on commit) — enforced by T3 being the only transition emitting bytes via `Paste.encode`.
- **I-2** (compositionupdate updates only preedit overlay) — enforced by T2 side effect list not including PTY emission.
- **I-3 / I-7 of RFC §2** (preedit never enters grid) — enforced by `PreeditOverlay.tsx` being a paint-layer React component that does not feed into the EPIC-C mirror; no transition writes to the grid.
- **I-4** (commit goes through bracketed-paste path when DECSET 2004 on) — enforced by T3 routing through `Paste.encode` which consults `snapshot.bracketedPaste`.
- **I-5** (cancel clears overlay without PTY emission) — enforced by T4, T5, T7, T10, T12 having unmount-only side effects.
- **I-6** (blur policy platform-dependent, partial bytes never emitted) — enforced by T7 (macOS) vs T8/T9/T10 (Linux/Win). No transition in any blur path emits bytes.
- **I-7 ADR 0018** (keydown during Composing suppressed) — enforced by T5 (Escape cancels but is not forwarded) and T6 (generic suppression).
- **I-6 RFC §2** (input encoder mandatory) — enforced structurally: `input-host.ts` is the only DOM attach-point; `KeyEncoder.encode` has the only path to `encodedInput.write`.

### 5.5 Algorithm (pure transition function)

```ts
// ime/ImeStateMachine.ts — pure; no DOM, no timers (timers orchestrated by input-host.ts).
export function transition(
  current: ImeState,
  event: ImeEvent,
  opts: { platform: 'macos' | 'windows' | 'linux'; now: number }
): { next: ImeState; effects: ImeSideEffect[] } {
  // Exhaustive switch over `current.kind × event.kind` matching §5.3 table.
  // Returns effects the orchestrator applies (mount, unmount, updateText, dim,
  // undim, startPersistTimer, cancelPersistTimer, emitBytes, showBanner,
  // telemetry).
}
```

Exhaustiveness is enforced with a TS `assertNever`. Unknown pairs fall through to a `warn` + return `{ next: current, effects: [{ kind: 'telemetry', name: 'ime.stray_transition' }] }`.

---

## 6. PreeditOverlay (React)

### 6.1 Prop shape

```tsx
export interface PreeditOverlayProps {
  /** Current composition text. Empty string briefly shows a placeholder (rare — most IMEs start with a glyph). */
  text: string;
  /** Cell-coordinate anchor. Converted to screen coords by the overlay using the renderer's cellToScreen(). */
  anchor: { row: number; col: number };
  /** True during Composing{persisted} on Linux/Windows while the 1s timer is running. Applies a CSS `opacity` class. */
  dimmed?: boolean;
  /** Optional measurement callback — called with the rendered bounding rect after layout. Used by IME candidate-popup alignment. */
  onMeasure?: (rect: DOMRect) => void;
}
```

### 6.2 Rendering contract

- Positioned absolutely at `cellToScreen(anchor)` with an additional Y offset of `lineHeight` (below the row baseline) so the preedit sits on the same visual line as the cursor.
- Style: single underline, monospace inheriting the terminal's foreground color, no background fill, no independent caret (the terminal cursor from EPIC-C `CursorState` shows position).
- Z-layer: **above** the cursor overlay layer (EPIC-D §14.1), **below** the selection highlight layer. This matches ADR 0018 §3 UI behavior ("same z as selection" replaced with the more precise ordering: above cursor, below selection).
- `dimmed=true` applies `opacity: 0.5` and disables pointer events on the overlay.
- No internal state; pure function of props.

### 6.3 Resize handling

When the parent terminal resizes, `input-host.ts` re-reads the current cursor and calls `forceUpdate` on the overlay with a fresh `anchor`. The component re-renders at the new screen position without resetting composition state (transition T16).

### 6.4 Layering with candidate popup

The browser-native IME candidate popup is anchored by the DOM via the focused element's caret position. `onMeasure` reports the overlay's rect to input-host.ts, which can optionally hint the OS IME via `document.activeElement.setCaretPos()` on platforms that support it. v1 leaves this to the browser default (see ADR 0018 Deliverable-2 candidate-popup decision).

### 6.5 Invariant I-3 / I-7 enforcement

`PreeditOverlay` renders as its own React tree node attached to the terminal container. It does NOT import from `packages/ui/src/shared/lib/grid-mirror/**`. It does NOT write into any `GridMirror` API. It is purely a visual layer. A repository grep test in `tools/check-*` (owned by cross-cutting infra agent) validates no `import from '.../grid-mirror'` appears under `features/input/ime/`.

---

## 7. Mode-snapshot read protocol

### 7.1 API

```ts
// ModeSnapshot.ts
export class ModeSnapshot {
  constructor(mirror: GridMirror);       // EPIC-C GridMirror reference
  /** One-shot, returns a deep-frozen TerminalModeSnapshot. */
  read(): TerminalModeSnapshot;
  /** Debug-only: returns current mirror snapshotEpoch without building a full snapshot. */
  peekEpoch(): bigint;
}
```

### 7.2 Semantics

- `read()` captures the mirror's current mode state by calling `mirror.snapshotMode()` (EPIC-C §4.1) and augments with `snapshotEpoch = mirror.__appliedSequence` (exposed via a narrow getter `mirror.getAppliedSequence(): bigint`).
- The returned object is produced via `Object.freeze()` applied recursively (equivalent to the mirror's own `Object.freeze` on its `snapshotMode()` output — EPIC-C §4.1 already guarantees `Readonly<TerminalModeState>`).
- Encoders call `read()` ONCE at the start of `encode(event)` — never mid-encode. This is invariant I-6 (input encoder reads a snapshot, never live reads — RFC §9.4 rule).
- In JS's single-threaded runtime, no concurrent mutation is possible during a single `encode` call. The `snapshotEpoch` diagnostic exists only to catch a programmer bug where someone refactors the encoder to call `read()` twice in one `encode` path.

### 7.3 Interaction with `ModeChanged` events

The mirror applies `ModeChanged` events from the stream (EPIC-C §4.3) which bumps `appliedSequence` and mutates `mode`. The encoder holds its snapshot for the duration of one `encode` call; any `ModeChanged` that flies through the DOM microtask queue between `read()` and `return` gets the next encode — acceptable and documented.

### 7.4 Fault-injection test

The `ModeSnapshot.test.ts` scenario: start with `snapshot.bracketedPaste = true`, invoke encoder, inject `mirror.applyMode(ModeChanged(bracketedPaste=false))` between `read()` and byte generation (via a test hook that scheduler-advances). Assert bytes reflect the snapshot's original `bracketedPaste=true` value, not the post-mutation state. `diagnostics.modeReadInconsistency` in this test must be `true` (proof the assertion has teeth).

---

## 8. Input matrix format

File: `packages/ui/src/features/input/fixtures/input-matrix.template.json`.

### 8.1 Schema (v1)

```ts
interface InputMatrix {
  version: 1;
  cases: Array<{
    id: string;                        // unique; used as test name suffix
    mode: EncodingMode;                // which encoding mode to assert under
    modeSnapshot: {
      decckm: boolean;
      bracketedPaste: boolean;
      focusReporting: boolean;
      mouseTracking: 'off' | 'x10' | 'button_event' | 'any_event';
      mouseEncoding: 'default' | 'utf8' | 'sgr' | 'url_xterm';
      modifyOtherKeys: 0 | 1 | 2;
      kittyKeyboard: 0 | 1 | 2 | 3;
      altScreen: boolean;
      synchronizedUpdate: boolean;
    };
    event: KeyEvent;                   // fields per §2.1
    expectedBytesHex: string;          // lowercase hex, no separators; "" = empty
    notes?: string;
  }>;
}
```

### 8.2 Seed cases (≥ 40; implementation agent expands to 800+)

The template JSON ships with these cases. Byte expectations annotated inline.

```json
{
  "version": 1,
  "cases": [
    {
      "id": "legacy-ctrl-a",
      "mode": "legacy",
      "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false },
      "event": { "key": "a", "code": "KeyA", "ctrlKey": true, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false },
      "expectedBytesHex": "01"
    },
    { "id": "legacy-ctrl-z", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "z", "code": "KeyZ", "ctrlKey": true, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1a" },
    { "id": "legacy-ctrl-shift-a-alias", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "A", "code": "KeyA", "ctrlKey": true, "altKey": false, "metaKey": false, "shiftKey": true, "repeat": false, "isComposing": false }, "expectedBytesHex": "01", "notes": "Ctrl+Shift+A aliases to Ctrl+A under legacy; disambiguated under mkeys=2." },
    { "id": "mkeys2-ctrl-shift-a", "mode": "modify-other-keys-v2", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 2, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "A", "code": "KeyA", "ctrlKey": true, "altKey": false, "metaKey": false, "shiftKey": true, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b32373b363b36357e", "notes": "CSI 27 ; 6 ; 65 ~" },
    { "id": "legacy-alt-a", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "a", "code": "KeyA", "ctrlKey": false, "altKey": true, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b61", "notes": "ESC a" },
    { "id": "mkeys2-alt-a", "mode": "modify-other-keys-v2", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 2, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "a", "code": "KeyA", "ctrlKey": false, "altKey": true, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b32373b333b39377e", "notes": "CSI 27 ; 3 ; 97 ~ (key 'a' → codepoint 97)" },
    { "id": "arrow-up-decckm-off", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "ArrowUp", "code": "ArrowUp", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b41" },
    { "id": "arrow-up-decckm-on", "mode": "legacy", "modeSnapshot": { "decckm": true, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "ArrowUp", "code": "ArrowUp", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b4f41" },
    { "id": "arrow-down-decckm-off", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "ArrowDown", "code": "ArrowDown", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b42" },
    { "id": "arrow-right-shift-csi", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "ArrowRight", "code": "ArrowRight", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": true, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b313b3243", "notes": "CSI 1 ; 2 C" },
    { "id": "f1-legacy", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "F1", "code": "F1", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b4f50" },
    { "id": "f1-shift-legacy", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "F1", "code": "F1", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": true, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b4f313b3250", "notes": "ESC O 1 ; 2 P" },
    { "id": "f5-legacy", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "F5", "code": "F5", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b31357e" },
    { "id": "f12-legacy", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "F12", "code": "F12", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b32347e" },
    { "id": "enter-plain", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "Enter", "code": "Enter", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "0d" },
    { "id": "enter-shift-legacy-aliased", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "Enter", "code": "Enter", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": true, "repeat": false, "isComposing": false }, "expectedBytesHex": "0d" },
    { "id": "enter-shift-mkeys2", "mode": "modify-other-keys-v2", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 2, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "Enter", "code": "Enter", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": true, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b32373b323b31337e" },
    { "id": "tab-plain", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "Tab", "code": "Tab", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "09" },
    { "id": "shift-tab", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "Tab", "code": "Tab", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": true, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b5a", "notes": "ESC [ Z" },
    { "id": "backspace-plain", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "Backspace", "code": "Backspace", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "7f" },
    { "id": "ctrl-h", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "h", "code": "KeyH", "ctrlKey": true, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "08" },
    { "id": "escape", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "Escape", "code": "Escape", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b" },
    { "id": "space-plain", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": " ", "code": "Space", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "20" },
    { "id": "ctrl-space", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": " ", "code": "Space", "ctrlKey": true, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "00" },
    { "id": "pageup-plain", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "PageUp", "code": "PageUp", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b357e" },
    { "id": "pagedown-ctrl", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "PageDown", "code": "PageDown", "ctrlKey": true, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b363b357e", "notes": "CSI 6 ; 5 ~" },
    { "id": "home-plain", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "Home", "code": "Home", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b48" },
    { "id": "end-shift", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "End", "code": "End", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": true, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b313b3246" },
    { "id": "delete-plain", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "Delete", "code": "Delete", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b337e" },
    { "id": "delete-alt", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "Delete", "code": "Delete", "ctrlKey": false, "altKey": true, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b333b337e" },
    { "id": "insert-plain", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "Insert", "code": "Insert", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b327e" },
    { "id": "kitty1-a-unmod", "mode": "kitty-1", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 1, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "a", "code": "KeyA", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b39373b3175", "notes": "CSI 97 ; 1 u — keycode 97, mod 1 (no mods)" },
    { "id": "kitty1-ctrl-a", "mode": "kitty-1", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 1, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "a", "code": "KeyA", "ctrlKey": true, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b39373b3575", "notes": "CSI 97 ; 5 u — mod 5 = Ctrl" },
    { "id": "kitty1-escape", "mode": "kitty-1", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 1, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "Escape", "code": "Escape", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b32373b3175", "notes": "CSI 27 ; 1 u" },
    { "id": "kitty2-a-release", "mode": "kitty-2", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 2, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "a", "code": "KeyA", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": true, "isComposing": false }, "expectedBytesHex": "1b5b39373b313b3275", "notes": "CSI 97 ; 1 ; 2 u (autorepeat)" },
    { "id": "kitty3-alt-layout", "mode": "kitty-3", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 3, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "z", "code": "KeyY", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b3132323a3132313b3175", "notes": "CSI 122:121 ; 1 u — QWERTZ: KeyY physical, 'z' current layout" },
    { "id": "ime-composing-suppressed-legacy", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "a", "code": "KeyA", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": true }, "expectedBytesHex": "", "notes": "I-7: isComposing=true → suppressed; empty bytes." },
    { "id": "ime-composing-suppressed-kitty", "mode": "kitty-1", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 1, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "Enter", "code": "Enter", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": true }, "expectedBytesHex": "" },
    { "id": "printable-no-mod", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "x", "code": "KeyX", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "78" },
    { "id": "printable-shift", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "X", "code": "KeyX", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": true, "repeat": false, "isComposing": false }, "expectedBytesHex": "58" },
    { "id": "ctrl-bracket-left", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "[", "code": "BracketLeft", "ctrlKey": true, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b" },
    { "id": "ctrl-backslash", "mode": "legacy", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 0, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "\\", "code": "Backslash", "ctrlKey": true, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1c" },
    { "id": "arrow-up-kitty2-release", "mode": "kitty-2", "modeSnapshot": { "decckm": false, "bracketedPaste": false, "focusReporting": false, "mouseTracking": "off", "mouseEncoding": "default", "modifyOtherKeys": 0, "kittyKeyboard": 2, "altScreen": false, "synchronizedUpdate": false }, "event": { "key": "ArrowUp", "code": "ArrowUp", "ctrlKey": false, "altKey": false, "metaKey": false, "shiftKey": false, "repeat": false, "isComposing": false }, "expectedBytesHex": "1b5b35373335323b3175", "notes": "CSI 57352 ; 1 u (kitty keycode for ArrowUp)" }
  ]
}
```

**Seed count: 42** (above the ≥40 minimum). Categories represented:

| Category | # seed cases |
|---|---|
| Legacy Ctrl+letter A-Z | 2 (ctrl-a, ctrl-z; implementation agent expands to all 26) |
| Legacy Ctrl+Shift+letter (alias) | 1 |
| mkeys2 Ctrl+Shift+letter | 1 |
| Legacy/mkeys2 Alt+letter | 2 |
| Arrow keys × DECCKM | 3 (up off, up on, down off) |
| Modified arrows (legacy CSI 1;<mod>) | 1 |
| F1-F12 | 4 (F1 plain, F1 shift, F5, F12) |
| Enter / Tab / Backspace / Escape / Space + modifier | 8 |
| Special keys (PageUp/Down, Home, End, Ins, Del) | 7 |
| Ctrl+symbols | 2 |
| Kitty levels 1-3 | 5 |
| IME-suppressed cases | 2 |
| Printable base cases | 2 |
| Autorepeat (kitty level 2) | 1 |

Implementation agent expands each category to full coverage; the fixture schema does not change.

---

## 9. IME recording format

Files under `packages/ui/src/features/input/fixtures/ime-recordings/<id>.json`.

### 9.1 Schema (v1)

```ts
interface ImeRecording {
  id: string;                    // matches filename stem
  ime: string;                   // e.g. "korean-2set", "jp-ime-hiragana", "cn-pinyin", "macos-deadkey"
  platform: 'macos' | 'linux' | 'windows';
  events: Array<{
    tMs: number;                 // relative to t=0
    kind: 'compositionstart' | 'compositionupdate' | 'compositionend'
        | 'keydown' | 'blur' | 'focus' | 'sidecar-disconnect' | 'persist-timer-expired';
    data?: string;               // for composition* events
    key?: string;                // for keydown
  }>;
  expectedPtyBytesHex: string;       // aggregate bytes emitted during replay
  expectedMidCompositionPtyBytes: string[];  // MUST be [] for correct behavior (I-1, I-2)
  expectedOverlayStates: Array<{
    afterTMs: number;
    visible: boolean;
    text: string;
    dimmed?: boolean;
  }>;
  notes?: string;
}
```

### 9.2 Seed recordings (six, one per scenario class)

**1. `korean-2set-commit.json`** — compose 한 and commit.

```json
{
  "id": "korean-2set-commit",
  "ime": "korean-2set",
  "platform": "macos",
  "events": [
    { "tMs": 0,   "kind": "compositionstart", "data": "" },
    { "tMs": 50,  "kind": "compositionupdate", "data": "ㅎ" },
    { "tMs": 120, "kind": "compositionupdate", "data": "하" },
    { "tMs": 200, "kind": "compositionupdate", "data": "한" },
    { "tMs": 300, "kind": "compositionend",   "data": "한" }
  ],
  "expectedPtyBytesHex": "ed959c",
  "expectedMidCompositionPtyBytes": [],
  "expectedOverlayStates": [
    { "afterTMs": 50,  "visible": true,  "text": "ㅎ" },
    { "afterTMs": 120, "visible": true,  "text": "하" },
    { "afterTMs": 200, "visible": true,  "text": "한" },
    { "afterTMs": 300, "visible": false, "text": "" }
  ],
  "notes": "RFC §22 #1 — Korean 2-set double-input bug. MUST emit exactly 'ed 95 9c' ONCE at commit."
}
```

**2. `korean-2set-cancel-esc.json`** — compose then Esc.

```json
{
  "id": "korean-2set-cancel-esc",
  "ime": "korean-2set",
  "platform": "macos",
  "events": [
    { "tMs": 0,   "kind": "compositionstart", "data": "" },
    { "tMs": 50,  "kind": "compositionupdate", "data": "ㅎ" },
    { "tMs": 120, "kind": "compositionupdate", "data": "하" },
    { "tMs": 180, "kind": "keydown", "key": "Escape" }
  ],
  "expectedPtyBytesHex": "",
  "expectedMidCompositionPtyBytes": [],
  "expectedOverlayStates": [
    { "afterTMs": 50,  "visible": true,  "text": "ㅎ" },
    { "afterTMs": 120, "visible": true,  "text": "하" },
    { "afterTMs": 180, "visible": false, "text": "" }
  ],
  "notes": "T5: Esc during Composing cancels and does NOT forward to PTY."
}
```

**3. `korean-2set-blur-macos.json`** — compose then blur on macOS.

```json
{
  "id": "korean-2set-blur-macos",
  "ime": "korean-2set",
  "platform": "macos",
  "events": [
    { "tMs": 0,   "kind": "compositionstart", "data": "" },
    { "tMs": 50,  "kind": "compositionupdate", "data": "ㅎ" },
    { "tMs": 150, "kind": "compositionupdate", "data": "하" },
    { "tMs": 200, "kind": "blur" }
  ],
  "expectedPtyBytesHex": "",
  "expectedMidCompositionPtyBytes": [],
  "expectedOverlayStates": [
    { "afterTMs": 50,  "visible": true,  "text": "ㅎ" },
    { "afterTMs": 150, "visible": true,  "text": "하" },
    { "afterTMs": 200, "visible": false, "text": "" }
  ],
  "notes": "T7: macOS blur cancels immediately, no bytes emitted."
}
```

**4. `jp-ime-kanji.json`** — hiragana + kanji conversion to こんにちは (intermediate "ko" → "kon" → "konn" → conversion pick).

```json
{
  "id": "jp-ime-kanji",
  "ime": "jp-ime-hiragana",
  "platform": "macos",
  "events": [
    { "tMs": 0,   "kind": "compositionstart", "data": "" },
    { "tMs": 40,  "kind": "compositionupdate", "data": "こ" },
    { "tMs": 80,  "kind": "compositionupdate", "data": "こん" },
    { "tMs": 120, "kind": "compositionupdate", "data": "こんに" },
    { "tMs": 160, "kind": "compositionupdate", "data": "こんにち" },
    { "tMs": 200, "kind": "compositionupdate", "data": "こんにちは" },
    { "tMs": 400, "kind": "compositionend",   "data": "こんにちは" }
  ],
  "expectedPtyBytesHex": "e38193e38293e381abe381a1e381af",
  "expectedMidCompositionPtyBytes": [],
  "expectedOverlayStates": [
    { "afterTMs": 40,  "visible": true,  "text": "こ" },
    { "afterTMs": 80,  "visible": true,  "text": "こん" },
    { "afterTMs": 120, "visible": true,  "text": "こんに" },
    { "afterTMs": 160, "visible": true,  "text": "こんにち" },
    { "afterTMs": 200, "visible": true,  "text": "こんにちは" },
    { "afterTMs": 400, "visible": false, "text": "" }
  ]
}
```

**5. `cn-pinyin-nihao.json`** — pinyin 你好.

```json
{
  "id": "cn-pinyin-nihao",
  "ime": "cn-pinyin",
  "platform": "macos",
  "events": [
    { "tMs": 0,   "kind": "compositionstart", "data": "" },
    { "tMs": 30,  "kind": "compositionupdate", "data": "n" },
    { "tMs": 60,  "kind": "compositionupdate", "data": "ni" },
    { "tMs": 90,  "kind": "compositionupdate", "data": "nih" },
    { "tMs": 120, "kind": "compositionupdate", "data": "niha" },
    { "tMs": 150, "kind": "compositionupdate", "data": "nihao" },
    { "tMs": 300, "kind": "compositionend",   "data": "你好" }
  ],
  "expectedPtyBytesHex": "e4bda0e5a5bd",
  "expectedMidCompositionPtyBytes": [],
  "expectedOverlayStates": [
    { "afterTMs": 30,  "visible": true, "text": "n" },
    { "afterTMs": 60,  "visible": true, "text": "ni" },
    { "afterTMs": 90,  "visible": true, "text": "nih" },
    { "afterTMs": 120, "visible": true, "text": "niha" },
    { "afterTMs": 150, "visible": true, "text": "nihao" },
    { "afterTMs": 300, "visible": false, "text": "" }
  ]
}
```

**6. `macos-deadkey-eacute.json`** — macOS Opt+e then e → é.

```json
{
  "id": "macos-deadkey-eacute",
  "ime": "macos-deadkey",
  "platform": "macos",
  "events": [
    { "tMs": 0,  "kind": "compositionstart", "data": " " },
    { "tMs": 5,  "kind": "compositionupdate", "data": "´" },
    { "tMs": 120, "kind": "compositionend",  "data": "é" }
  ],
  "expectedPtyBytesHex": "c3a9",
  "expectedMidCompositionPtyBytes": [],
  "expectedOverlayStates": [
    { "afterTMs": 5,   "visible": true,  "text": "´" },
    { "afterTMs": 120, "visible": false, "text": "" }
  ],
  "notes": "Dead-key via macOS Opt+e + e. Overlay briefly shows the accent; commit is é (c3 a9 UTF-8)."
}
```

Implementation agent adds Korean 3-set, vim-insert variants, tmux variants, resize-during-compose, sidecar-restart recording, Linux blur-preserve recording, and Opt+e+a → ä, Opt+e+Escape → cancel, per Epic-E acceptance matrix (18 minimum). The schema is shared.

---

## 10. Tests enumerated

### 10.1 `__tests__/KeyEncoder.test.ts`

- Parameterized over every case in `input-matrix.template.json` + expansions.
- For each case: construct encoder with `modeSnapshot` → feed `event` → assert `bytes` hex-equal to `expectedBytesHex`.
- Separate test: assert `diagnostics.modeReadInconsistency === false` during normal use (no mutation between `read()` and `encode()` completion).
- Separate test: assert `diagnostics.deprecatedFallback === false` for all non-fallback cases.
- Separate test: feed `kittyKeyboard = 5` (out-of-range) and assert encoder clamps to `kitty-3` with `diagnostics.deprecatedFallback = true`.

### 10.2 `__tests__/MouseEncoder.test.ts` (≥ 20 cases)

| # | Scenario | Expected |
|---|---|---|
| 1 | Left press at (3,5), no mods, SGR | `ESC [ < 0 ; 4 ; 6 M` |
| 2 | Left release at (3,5), no mods, SGR | `ESC [ < 0 ; 4 ; 6 m` |
| 3 | Middle press at (10,10), SGR | `ESC [ < 1 ; 11 ; 11 M` |
| 4 | Right press at (0,0), SGR | `ESC [ < 2 ; 1 ; 1 M` |
| 5 | Shift+left press at (3,5), SGR | Cb=4 → `ESC [ < 4 ; 4 ; 6 M` |
| 6 | Ctrl+left press at (3,5), SGR | Cb=16 → `ESC [ < 16 ; 4 ; 6 M` |
| 7 | Alt+left press at (3,5), SGR | Cb=8 → `ESC [ < 8 ; 4 ; 6 M` |
| 8 | Ctrl+Shift+Alt+left press, SGR | Cb=28 → `ESC [ < 28 ; 4 ; 6 M` |
| 9 | Left drag (press+move) at (10,10), SGR button_event | Cb=32 → `ESC [ < 32 ; 11 ; 11 M` |
| 10 | Right drag with Ctrl, SGR button_event | Cb=34+16=50 |
| 11 | Wheel-up at (5,5), SGR | Cb=64 → `ESC [ < 64 ; 6 ; 6 M` (no release) |
| 12 | Wheel-down at (5,5), SGR | Cb=65 |
| 13 | Wheel-up with Shift, SGR | Cb=68 |
| 14 | Any-event move at (20,20), SGR any_event | Drag-form with no button-in-hand: Cb=35 (convention) |
| 15 | Click with tracking=off | empty bytes |
| 16 | Wheel-up with tracking=off, DECCKM off | 3× ArrowUp legacy = `1b5b411b5b411b5b41`, `deprecatedFallback=true` |
| 17 | Wheel-down with tracking=off, DECCKM on | 3× ArrowDown application = `1b4f421b4f421b4f42` |
| 18 | x10 press, SGR | identical to button_event press |
| 19 | x10 release | empty bytes (x10 doesn't report release) |
| 20 | Column > 223 boundary | SGR handles correctly (not legacy's 223 limit) |
| 21 | Row > 223 boundary | SGR handles correctly |

### 10.3 `__tests__/Paste.test.ts` (6 cases)

| # | Input | bracketedPaste | Expected |
|---|---|---|---|
| 1 | `"hello"` | off | `"hello"` (raw) |
| 2 | `"hello"` | on | `ESC [ 200 ~ hello ESC [ 201 ~` |
| 3 | `"line1\nline2"` | off | raw bytes incl `0x0a` |
| 4 | `"line1\nline2"` | on | wrapped |
| 5 | `"has\x1b[2004~embedded"` (contains a sentinel) | on | wrapped, embedded `ESC [ 200 ~` stripped/escaped per xterm convention |
| 6 | `""` (empty) | on | wrapped empty: `ESC [ 200 ~ ESC [ 201 ~` |

### 10.4 `__tests__/Focus.test.ts` (4 cases)

| # | focusReporting | event | Expected |
|---|---|---|---|
| 1 | off | focus | empty bytes |
| 2 | off | blur | empty bytes |
| 3 | on | focus | `ESC [ I` = `1b 5b 49` |
| 4 | on | blur | `ESC [ O` = `1b 5b 4f` |

### 10.5 `__tests__/ModeSnapshot.test.ts`

- `read()` returns a deeply-frozen object — attempts to mutate fields throw in strict mode.
- Two calls to `read()` return independent frozen objects (not aliased).
- Inject a `mirror.applyMode(ModeChanged(bracketedPaste=false))` between `read()` and encoder finalization via test hook; assert encoded bytes reflect the `read()`-time snapshot, not the post-mutation state.
- `peekEpoch()` returns a monotonically increasing `bigint`.

### 10.6 `__tests__/ime/ImeStateMachine.test.ts` (≥ 20 cases)

One case per row of §5.3 (18 rows) plus stray-event coverage. Each case:
1. Starts from a specific `ImeState`.
2. Feeds one `ImeEvent` with the given `platform`.
3. Asserts `next` state kind + sub-flags.
4. Asserts the exact `effects` array (order-preserving).

### 10.7 `__tests__/ime/korean-2set.recording.test.ts`

For each `korean-2set-*.json` recording:
- Feed events in order with `tMs` honored by fake timers.
- After each event, compare overlay state against `expectedOverlayStates`.
- At end, assert aggregated PTY bytes hex-equal to `expectedPtyBytesHex`.
- Assert `expectedMidCompositionPtyBytes === []` — this is the core anti-regression assertion against RFC §22 #1.

### 10.8 `__tests__/ime/jp-ime.recording.test.ts`, `cn-pinyin.recording.test.ts`

Same shape as Korean. One test per recording file under the relevant `ime` prefix.

### 10.9 `__tests__/ime/deadkey.test.ts` (3 cases)

- Opt+e+e → é (the `macos-deadkey-eacute.json` recording).
- Opt+e+a → ä (composed to `c3 a4`).
- Opt+e+Escape → cancel; overlay unmounts; zero bytes.

### 10.10 `__tests__/ime/blur-policy.test.ts`

| # | Platform | Action | Expected |
|---|---|---|---|
| 1 | macos | compose→blur | overlay unmounts immediately, zero bytes (T7) |
| 2 | linux | compose→blur | overlay dimmed, timer starts (T8); after 999 ms still dimmed |
| 3 | linux | compose→blur→focus at 500 ms | overlay un-dimmed, composition preserved (T9) |
| 4 | linux | compose→blur→wait > 1000 ms | overlay unmounts at T=1000 ms (T10) |
| 5 | windows | same as linux cases | same as linux |

### 10.11 `__tests__/ime/sidecar-restart.test.ts`

- Enter `Composing` with text "ㅎ".
- Emit `sidecar-disconnect` event (T12).
- Assert: overlay unmounts, `ime.abnormal_termination` counter +1, banner emission effect was in the effects list.

### 10.12 `__tests__/ime/PreeditOverlay.test.tsx`

- Render `<PreeditOverlay text="한" anchor={{ row: 3, col: 5 }} />`; assert absolute position, underline style, monospace font, text content.
- Render with `dimmed`; assert `opacity: 0.5` CSS property.
- Trigger `onMeasure`; assert it fires with a `DOMRect`.
- Re-render with a new `anchor`; assert position updates without remount (stable key).

### 10.13 `__tests__/input-host.test.ts`

- jsdom integration. Attach `input-host.ts` to a container; dispatch a `KeyboardEvent`, assert the encoder was called with the normalized `KeyEvent` shape.
- Dispatch `compositionstart` → `compositionupdate` → `compositionend` in the jsdom; assert the state machine progressed through T1/T2/T3 and the commit path emitted bytes.
- Dispatch a Ctrl+A `keydown` DURING `Composing`; assert I-7 suppression (no encoder call).

---

## 11. Contract freeze checklist

- [ ] `KeyEvent` shape (§2.1).
- [ ] `MouseEvent` shape (§2.2).
- [ ] `PasteEvent` shape (§2.3).
- [ ] `FocusEvent` shape (§2.4).
- [ ] `TerminalModeSnapshot` shape — aligned to EPIC-C `GridMirror.snapshotMode()` return (§2.5 + EPIC-C §3.1, §4.1).
- [ ] `EncoderOutput` shape (§2.6).
- [ ] `EncodingMode` variants (§2.7).
- [ ] Input matrix JSON format v1 + seed corpus ≥ 40 cases (§8).
- [ ] IME recording JSON format v1 + seed corpus 6 recordings (§9).
- [ ] IME state machine transition table exhaustive (§5.3, T1-T18).
- [ ] `ModeSnapshot.read()` contract: one-shot, frozen, wraps `GridMirror.snapshotMode()` (§7).
- [ ] `PreeditOverlay` prop shape (§6.1).
- [ ] Invariant I-6 (input encoder mandatory) enforcement strategy: `input-host.ts` sole DOM attach-point, `KeyEncoder.encode` sole path to PTY write bridge, grep-enforced by cross-cutting `tools/check-*` (see Epic-E plan, handled by infra agent).
- [ ] Invariant I-7 (preedit never enters grid) enforcement strategy: `PreeditOverlay.tsx` paint-layer only; no import from `grid-mirror/**`; grep-enforced.

---

## 12. Implementation-agent TODOs (deferred)

Items this design explicitly defers; implementation agent resolves before exit:

1. **Input matrix expansion to 800+** — Epic-E acceptance. Seed is 42; expansion fills all (mode × key × modifier-combo × DECCKM) products per §8 categories.
2. **Complete Korean 2-set / 3-set / JP / CN / deadkey recording corpus** — 18 minimum per Epic-E acceptance, spread across shell/vim/tmux contexts. Seed is 6.
3. **Kitty keycode table** — §3.4 references kitty spec; impl agent mirrors the full keycode constants table into `KeyEncoder.ts`.
4. **F13-F24 coverage** — rarely triggered on laptops; impl agent adds coverage if a test keyboard is available, else stubs as TODO for v2.
5. **macOS Opt-vs-Alt terminology** — ADR 0018 Deliverable-2 open question 1; UI strings TBD.
6. **Linux IME real-device validation** — fcitx5, ibus; design assumes same browser composition API surface as macOS. If it diverges, document under §5.3 as a new transition row.
7. **Resize-during-compose recording** — T16/T17 have test coverage at the state-machine level; a full end-to-end recording is deferred to the impl-agent test expansion.
8. **Mouse wheel fallback step count** — currently 3; if dogfood shows it should be configurable, add a preference hook.

---

## 13. Definition of Done (DoD)

The implementation agent may mark EPIC-E complete only when every item below is true. Each item is independently testable; the CI gate evaluates them in aggregate. Numbering is stable; downstream plan edits can reference `DoD-E-##`.

### 13.1 Corpus & fixtures

- [ ] **DoD-E-01** — Full input-matrix corpus committed at `packages/ui/src/features/input/fixtures/input-matrix.json` with **≥ 800 cases**. Categories per §8: printable ASCII (32–126) × 4 modifier combos, Ctrl-letter × legacy/mkeys=2/kitty-1/kitty-2/kitty-3, navigation keys × DECCKM-on/off × mkeys/kitty levels, F1-F24 × modifier combos, numeric-keypad × DECPAM on/off, Alt + printable × macOS/Linux/Win. Every case has `expectedHex` populated (no TODOs).
- [ ] **DoD-E-02** — IME recordings committed under `packages/ui/src/features/input/fixtures/ime-recordings/` — **≥ 6 seed recordings**: `korean-2set-commit.json`, `korean-2set-esc-cancel.json`, `korean-2set-macos-blur.json`, `jp-kanji-konnichiwa.json`, `cn-pinyin-nihao.json`, `macos-deadkey-eacute.json`. Each adheres to §9 recording schema (version, platform, imeMethod, events with `tMs` timestamps, expectedOverlayStates, expectedPtyBytesHex, expectedMidCompositionPtyBytes). Impl agent expands to ≥ 18 total per EPIC-E acceptance.
- [ ] **DoD-E-03** — Recording schema v1 frozen: each file round-trips through the JSON parser with `expectedMidCompositionPtyBytes: []` asserted as an empty array (the anti-regression signal for RFC §22 #1).

### 13.2 Encoder semantics

- [ ] **DoD-E-04** — `KeyEncoder.encode(event, snapshot): EncoderOutput` returns `{ bytes: Uint8Array, diagnostics: EncoderDiagnostic[] }`. Snapshot is passed by value; the encoder never reads `GridMirror` or any ambient state mid-encode (I-6 + ADR 0017 §4).
- [ ] **DoD-E-05** — `event.isComposing === true` short-circuits the encoder: returns `bytes=[]` plus a `diagnostics: [{ kind: 'SuppressedForComposition' }]`. Unit-tested with jsdom `KeyboardEvent` carrying `isComposing=true`.
- [ ] **DoD-E-06** — Three encoding modes implemented and selectable via `snapshot.keyboard.encoding`: `legacy-xterm` (default), `modify-other-keys-v2`, `kitty-keyboard-L1` / `L2` / `L3`. Mode selection drives per-key byte output end-to-end.
- [ ] **DoD-E-07** — Kitty keyboard levels 1, 2, and 3 produce distinct byte outputs for modifier+letter / Shift+Enter / repeat-press. Each level has ≥ 50 matrix cases; no TODO byte rows.
- [ ] **DoD-E-08** — `modifyOtherKeys=2` encoding correct: `Ctrl+A` in legacy mode → `0x01`; in mkeys=2 mode → `CSI 27;5;97~` = `1b 5b 32 37 3b 35 3b 39 37 7e`. At least 30 matrix cases cover the `27;modifiers;code~` shape across ASCII letters, symbols, and function keys.
- [ ] **DoD-E-09** — Mouse SGR 1006 encoding: button, modifier bitmap, 1-based cell col/row, `M` (press/drag) or `m` (release) final byte. `htop` click at PID row 5 produces `CSI < 0 ; col ; 5 M` exactly (byte-parity with recorded fixture).
- [ ] **DoD-E-10** — Mouse wheel with mouse tracking **off** falls back to DECCKM-aware cursor-key sequences (`ESC [ A/B` in normal, `ESC O A/B` in application); with mouse tracking **on**, emits SGR button 64/65. Covered in `MouseEncoder.test.ts`.
- [ ] **DoD-E-11** — Bracketed paste: when DECSET 2004 is on, `Paste.encode(text, snapshot)` wraps with `ESC [ 200 ~` / `ESC [ 201 ~` sentinels; when off, raw bytes pass through. Embedded sentinel sequences inside the payload are filtered per xterm convention.
- [ ] **DoD-E-12** — Focus events: `Focus.encode(focused, snapshot)` emits `ESC [ I` on focus and `ESC [ O` on blur iff DECSET 1004 is on; otherwise empty bytes.

### 13.3 IME state machine

- [ ] **DoD-E-13** — State machine implements transitions **T1-T18** per §5.3 exhaustively. `ImeStateMachine.test.ts` has one test case per row; no "TODO" or `.skip` markers.
- [ ] **DoD-E-14** — PTY bytes are emitted ONLY on the `Composing → Committed` transition (T3). Asserted across all 6+ recordings via `expectedMidCompositionPtyBytes === []`.
- [ ] **DoD-E-15** — Preedit text never enters the grid. `PreeditOverlay.tsx` does NOT import from `packages/ui/src/shared/lib/grid-mirror/**`; CI grep rule `tools/check-ui-no-grid-import-in-overlay/` asserts this — failure breaks the build (I-7).
- [ ] **DoD-E-16** — `keydown` events during `Composing` are fully suppressed upstream of `KeyEncoder`: `input-host.ts` routes composing keydowns to `ImeStateMachine` only, and the encoder's `isComposing` short-circuit is the final guardrail (T5/T6 + DoD-E-05).
- [ ] **DoD-E-17** — Esc during composition: overlay clears, zero PTY bytes, Esc byte itself NOT forwarded (I-5 / T5).
- [ ] **DoD-E-18** — Korean 2-set double-input bug (RFC §22 #1) reproducibly absent. `korean-2set-commit.json` replay produces exactly 3 bytes (`ed 95 9c` for `한`) and zero mid-composition bytes.

### 13.4 Blur policy & sidecar restart

- [ ] **DoD-E-19** — macOS blur during composition → immediate cancel (T7); overlay unmounts, zero PTY bytes.
- [ ] **DoD-E-20** — Linux / Windows blur during composition → overlay dimmed (T8), 1000 ms preservation timer starts. Focus-return before expiry → un-dim and resume (T9). Timer expiry → cancel (T10). Fake-timer test covers all three.
- [ ] **DoD-E-21** — Sidecar restart during composition (T12/T13) forces state to `Cancelled`: overlay unmounts, zero partial PTY bytes, `ime.abnormal_termination` counter incremented, banner effect dispatched. Asserted in `sidecar-restart.test.ts`.

### 13.5 Contracts & ADR

- [ ] **DoD-E-22** — ADR 0018 status line reads `Accepted` (verify via grep against `docs/adr/0018-ime-state-machine.md`, line 3).
- [ ] **DoD-E-23** — `ModeSnapshot.read()` returns a deep-frozen object per §7. Mutation attempts throw in strict mode; successive calls return independent frozen objects (never aliased).
- [ ] **DoD-E-24** — `KeyEvent`, `MouseEvent`, `PasteEvent`, `FocusEvent`, `TerminalModeSnapshot`, `EncoderOutput`, `EncodingMode` types frozen per §11 checklist; no breaking changes after freeze without RFC bump.

### 13.6 CI & tooling

- [ ] **DoD-E-25** — `pnpm --filter @quanta/ui test` green on the EPIC-E test subset (all files under `packages/ui/src/features/input/__tests__/**`).
- [ ] **DoD-E-26** — `pnpm typecheck` passes with zero errors in `packages/ui/src/features/input/**`.
- [ ] **DoD-E-27** — Line coverage on `packages/ui/src/features/input/**` ≥ 90% measured by Vitest c8; branch coverage ≥ 85%.
- [ ] **DoD-E-28** — Grep rule `tools/check-ui-no-ansi/` confirms no `\x1b` ANSI parsing outside `crates/quanta-vt/`; zero hits in `packages/ui/src/features/input/**`.
- [ ] **DoD-E-29** — Grep rule `tools/check-ui-no-direct-pty-from-keyboard/` confirms the only call-site reaching the PTY write bridge is `input-host.ts` / `KeyEncoder`; no `KeyboardEvent` handler writes bytes directly.
- [ ] **DoD-E-30** — Telemetry counters from ADR 0018 §9 (`ime.lifecycle_start`, `ime.lifecycle_commit`, `ime.lifecycle_cancel{reason}`, `ime.abnormal_termination`, `ime.composition_duration_ms`, `ime.stray_end`, `ime.stray_nested_start`, `ime.stray_transition`) all wired and emitted by `ImeStateMachine` on the relevant transitions.

### 13.7 Release-gate coordination

- [ ] **DoD-E-31** — `Ctrl+C` / `Ctrl+D` / `Ctrl+Z` produce exactly `0x03` / `0x04` / `0x1a` in every encoding mode (legacy, mkeys=2, kitty levels 1-3). Hard-coded anti-regression case.
- [ ] **DoD-E-32** — No `PreeditOverlay` import from `grid-mirror/**`, verified by the check rule in DoD-E-15 AND a separate vitest assertion that imports the overlay module and walks its static `import.meta`-resolvable dependency set.

---

## 14. Quality Gates

Each gate is a CI job and must be green for `EPIC-E` to exit. "Enforced-by" names either a workflow, a script, or a test file; "Failure behavior" names what happens when the gate is red.

| Gate | Enforced by | Failure behavior |
|---|---|---|
| G-E-01 Unit tests green | `.github/workflows/ui-renderer.yml` → `pnpm --filter @quanta/ui test` | PR blocked; red-check on commit. |
| G-E-02 Typecheck clean | `.github/workflows/ui-renderer.yml` → `pnpm typecheck` | PR blocked. |
| G-E-03 Line coverage ≥ 90% on `features/input/**` | Vitest c8 threshold in `packages/ui/vitest.config.ts` | Vitest exits non-zero; PR blocked. |
| G-E-04 Input-matrix corpus ≥ 800 cases | `KeyEncoder.test.ts` assertion: `expect(corpus.length).toBeGreaterThanOrEqual(800)` | Test fails loudly; PR blocked. |
| G-E-05 IME recording count ≥ 6 seed / ≥ 18 full | Fixture-directory size check in `ime/recording-count.test.ts` | Test fails; PR blocked. |
| G-E-06 No preedit→grid import | `tools/check-ui-no-grid-import-in-overlay/check.ts` run under `.github/workflows/ci.yml` | Script exits 1; PR blocked with diff pointing at offending import. |
| G-E-07 No direct PTY from KeyboardEvent | `tools/check-ui-no-direct-pty-from-keyboard/check.ts` | Same as G-E-06. |
| G-E-08 No ANSI parsing in UI | `tools/check-ui-no-ansi/check.ts` (EPIC-K) | Same. |
| G-E-09 Kitty level 1-3 matrix all-green | `KeyEncoder.test.ts` — kitty suite must run with no `.skip` | Skipped tests fail the PR via the `forbid-skip-in-kitty-suite` lint rule. |
| G-E-10 Korean double-input anti-regression | `korean-2set.recording.test.ts` asserts `expectedMidCompositionPtyBytes === []` | Test red; PR blocked. |
| G-E-11 ADR 0018 Accepted | `tools/check-adr-accepted/check.sh 0018` | Script exits 1; PR blocked. |
| G-E-12 Schema-parity Rust↔TS mode types | `packages/host-common/src/__tests__/schema-parity.test.ts` | Vitest red; PR blocked. |
| G-E-13 IME telemetry wired | `ime/telemetry-wiring.test.ts` subscribes to the recorder and replays each transition; asserts every §9 counter fires at least once | Test red; PR blocked. |

Gates G-E-06 / G-E-07 / G-E-08 are owned by the cross-cutting EPIC-K agent but listed here so EPIC-E exit checks them explicitly.

---

## 15. E2E scenarios

Each scenario runs under `tests/integration/` or the Playwright equivalent (`pnpm --filter @quanta/ui test:e2e`) against a real sidecar with a real shell. "Pass" = both the expected PTY byte trace AND the expected UI observable (overlay presence, banner, etc.) match.

- **E2E-E1 — Korean 2-set single commit**: focus terminal, compose `ㅎ` → `하` → `한`, press Enter (commit). Assert: exactly one PTY write of `ed 95 9c` (한 UTF-8), zero mid-composition writes, zero bytes between `compositionstart` and `compositionend`. Retires RFC §22 #1.
- **E2E-E2 — Korean 2-set Esc cancel**: compose `ㅎ`, press Esc. Assert: overlay unmounts, zero PTY bytes (neither the partial `ㅎ` nor the Esc byte). Retires I-5.
- **E2E-E3 — macOS blur cancel**: on macOS platform, compose `한`, focus another window. Assert: overlay unmounts immediately (T7), zero PTY bytes, `ime.lifecycle_cancel{reason=blur}` counter +1.
- **E2E-E4 — Linux blur preserve**: on Linux platform, compose `한`, focus another window. After 500 ms refocus terminal. Resume composition, press Enter. Assert: overlay dimmed during blur window (T8), un-dimmed on refocus (T9), commit emits exactly 3 PTY bytes `ed 95 9c` at commit time.
- **E2E-E5 — Ctrl+A encoding-mode dispatch**: legacy mode → `0x01`; mkeys=2 mode → `CSI 27;5;97~` = `1b 5b 32 37 3b 35 3b 39 37 7e`; kitty L1 → appropriate CSI-u form. Run the same user action in each mode with the mode mutated via the `mode-harness` test helper; assert byte parity. Retires RFC §22 #2.
- **E2E-E6 — fzf Alt+Enter under kitty level 1**: launch `fzf`, negotiate kitty level 1 via DECSET, press Alt+Enter. Assert: CSI-u encoding emitted matches kitty spec `ESC [ 13 ; 3 u`. Retires RFC §22 #3.
- **E2E-E7 — tmux prefix across three encoding modes**: scripted test boots a tmux session, sends `Ctrl+b`, and walks through legacy → mkeys=2 → kitty L1 encoding. Assert: each mode delivers the expected prefix byte sequence and tmux reacts correctly (status bar + command prompt visible). Retires RFC §22 #4.
- **E2E-E8 — Bracketed paste into vim insert mode**: DECSET 2004 on (vim enables bracketed paste by default). Paste a 3-line buffer via `document.execCommand('paste')` (or jsdom ClipboardEvent). Assert: PTY write is `ESC [ 200 ~ <3-line-bytes> ESC [ 201 ~`; vim shows the raw text with newlines preserved (no auto-indent chaos). Retires RFC §22 #13.
- **E2E-E9 — htop mouse click on PID row**: launch `htop`, click on row 5. Assert: PTY write is exactly `CSI < 0 ; col ; 5 M` (byte-parity; `;` not `:`). Retires RFC §22 #12.
- **E2E-E10 — Sidecar crash mid-IME compose**: start composing `ㅎ`, `kill -9` the quanta-core process. Assert: within 200 ms the UI detects sidecar disconnect, overlay unmounts, `ime.abnormal_termination` counter +1, banner "session restarted; re-enter text" surfaces. Next `keydown` after the sidecar reconnects routes through Idle state. Retires RFC §22 #18.
- **E2E-E11 — Dead-key Opt+e+e → é on macOS**: press Option+e then e. Assert: composition lifecycle (T1→T2→T3) completes < 200 ms, PTY write is `c3 a9` (é UTF-8), overlay visible for < 200 ms.
- **E2E-E12 — Focus reporting gated by DECSET 1004**: toggle 1004 off → focus/blur emit zero bytes; toggle 1004 on → focus emits `ESC [ I`, blur emits `ESC [ O`. One mode-toggle test per direction.

---

## 16. Test coverage targets

| Surface | Metric | Target |
|---|---|---|
| `packages/ui/src/features/input/**` | Line coverage | **≥ 90%** |
| `packages/ui/src/features/input/**` | Branch coverage | **≥ 85%** |
| Input-matrix fixture | Case count | **≥ 800** |
| IME recordings (seed) | Recording count | **≥ 6** |
| IME recordings (full, post-dogfood) | Recording count | **≥ 18** (3 IMEs × 6 scenarios) |
| IME state-machine transitions | Coverage | **100%** of rows T1-T18 in `ImeStateMachine.test.ts`; zero `.skip` |
| E2E scenarios | Count | **≥ 10** passing under Playwright |
| Per encoding mode | Matrix subset | **≥ 50** cases each (legacy, mkeys=2, kitty-L1, kitty-L2, kitty-L3) |
| Dead-key composition | Case count | **≥ 3** (Opt+e+e, Opt+e+a, Opt+e+Esc) |
| Blur-policy cases | Case count | **≥ 5** (macOS cancel, Linux preserve-then-resume, Linux preserve-then-timeout, Windows parity, preference-override) |

Coverage delta tracking: a PR that reduces line coverage below the threshold fails the `pnpm --filter @quanta/ui test:coverage` job. Thresholds are codified in `packages/ui/vitest.config.ts` under the `coverage.thresholds` key so there is no floor erosion.

