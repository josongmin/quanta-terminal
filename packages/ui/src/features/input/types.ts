/**
 * Input encoder type contracts — EPIC-E §2.
 *
 * All browser DOM events land in `input-host.ts` and are normalized into
 * these shapes before hitting the encoders. The encoder layer reads a
 * one-shot `TerminalModeSnapshot` and produces `EncoderOutput` bytes.
 *
 * RFC 0001 invariants:
 *   I-6 (input encoder mandatory) — keyboard bytes go encoder → bytes,
 *       never DOM → bridge directly. `input-host.ts` is the sole DOM
 *       attach-point.
 *   I-7 (preedit never enters grid) — `isComposing=true` short-circuits
 *       `KeyEncoder.encode()` to empty bytes.
 */

/**
 * Normalized key event. Produced by `input-host.ts` from DOM KeyboardEvent.
 * When `isComposing === true` the KeyEncoder MUST return empty bytes
 * (invariant I-7).
 */
export interface KeyEvent {
  /** DOM KeyboardEvent.key — printable glyph or named key ("Enter", "ArrowUp", "F1", ...). */
  key: string;
  /** DOM KeyboardEvent.code — physical-layout key ("KeyA", "Digit1", "ArrowUp", "F1"). */
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  /** macOS Command / Windows key / Linux Super. */
  metaKey: boolean;
  shiftKey: boolean;
  /** Autorepeat; kitty L2+ distinguishes this from a fresh press. */
  repeat: boolean;
  /** DOM KeyboardEvent.isComposing. `true` during IME preedit. */
  isComposing: boolean;
  /** 'keydown' | 'keyup' — kitty L2 uses the release form. Defaults to 'keydown'. */
  kind?: 'keydown' | 'keyup';
}

/**
 * Cell-normalized mouse event. `input-host.ts` converts client coords to
 * cell coords using the renderer's `screenToCell()` hook (EPIC-D).
 */
export interface MouseEvent {
  /** 0-based cell column. Encoder adds 1 per SGR 1006. */
  xCell: number;
  /** 0-based cell row. Encoder adds 1 per SGR 1006. */
  yCell: number;
  button: 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down' | 'none';
  modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };
  kind: 'press' | 'release' | 'drag' | 'wheel' | 'move';
}

export interface PasteEvent {
  text: string;
  length: number;
}

export interface FocusEvent {
  focused: boolean;
}

/**
 * Frozen snapshot of terminal mode flags relevant to input encoding.
 * Structurally a subset of EPIC-C's `GridMirror.snapshotMode()` output.
 * Once returned by `ModeSnapshot.read()`, the object is deeply frozen.
 */
export interface TerminalModeSnapshot {
  /** DECCKM — cursor keys emit ESC O {A..D} when true, ESC [ {A..D} when false. */
  decckm: boolean;
  /** DECSET 2004 — bracketed paste sentinels. */
  bracketedPaste: boolean;
  /** DECSET 1004 — focus in/out reporting. */
  focusReporting: boolean;
  /** DECSET 1000 / 1002 / 1003. */
  mouseTracking: 'off' | 'x10' | 'button_event' | 'any_event';
  /** Mouse wire encoding. Only `sgr` supported beyond `default` today. */
  mouseEncoding: 'default' | 'utf8' | 'sgr' | 'url_xterm';
  /** xterm modifyOtherKeys: 0 off, 1 partial, 2 full. */
  modifyOtherKeys: 0 | 1 | 2;
  /** Kitty keyboard protocol level (0-3). Levels 4-5 deferred. */
  kittyKeyboard: 0 | 1 | 2 | 3;
  /** Alt-screen active. Encoder records but rarely branches on this. */
  altScreen: boolean;
  /** DECSET 2026 synchronized update in progress. Carried for parity. */
  synchronizedUpdate: boolean;
  /**
   * Monotonic counter — bumped by the mirror on every ModeChanged apply.
   * `ModeSnapshot.read()` sets this from `GridMirror.getAppliedEpoch()` at
   * read time. Used by `EncoderOutput.diagnostics.modeReadInconsistency`.
   */
  readonly snapshotEpoch: bigint;
}

/**
 * Uniform encoder result. Empty `bytes` means "suppress emission"
 * (e.g. IME composing, mouse click with tracking off).
 */
export interface EncoderOutput {
  bytes: Uint8Array;
  diagnostics: EncoderDiagnostics;
}

export interface EncoderDiagnostics {
  /**
   * True iff the snapshot's `snapshotEpoch` differs from the mirror's live
   * epoch at the time `encode()` finishes. In a single-threaded JS runtime
   * this SHOULD never fire; it exists to catch re-read bugs in tests.
   */
  modeReadInconsistency: boolean;
  /**
   * True iff the encoder fell back from the requested encoding mode (e.g.
   * kitty L5 clamped to L3, or wheel → cursor-keys when tracking off).
   */
  deprecatedFallback: boolean;
  /** Copy of the snapshot's `snapshotEpoch` for traceability. */
  snapshotEpoch: bigint;
  /**
   * True when the event was suppressed because IME composition is active.
   * I-7 guardrail — asserted by tests.
   */
  suppressedForComposition?: boolean;
}

/**
 * Key-encoder selection. Precedence:
 *   kittyKeyboard >= 1 → `kitty-${level}` (clamped to 3),
 *   else modifyOtherKeys === 2 → `modify-other-keys-v2`,
 *   else → `legacy`.
 */
export type EncodingMode =
  | 'legacy'
  | 'modify-other-keys-v2'
  | 'kitty-1'
  | 'kitty-2'
  | 'kitty-3';

/**
 * Platform identification used for IME blur policy.
 * macOS cancels preedit on blur; Linux/Windows preserve for 1s.
 */
export type Platform = 'macos' | 'linux' | 'windows';
