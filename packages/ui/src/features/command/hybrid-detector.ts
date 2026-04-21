/**
 * Hybrid boundary detector — P1-A implementation.
 *
 * Fuses four independent boundary signals into a single confidence-stamped
 * event stream that downstream chrome (P1-C) and the block store consume:
 *
 *   1. OSC 133 A/B/C/D markers (authoritative, confidence 1.0).
 *   2. Heuristic prompt-regex at column 0 after LF (0.6–0.8).
 *   3. Cursor-home + erase-line pattern (0.5).
 *   4. Idle timeout backstop (0.1).
 *
 * Only signal #1 can carry exit code, cwd, and duration. The other tiers
 * cannot observe command completion authoritatively — they only observe a
 * prompt-looking pattern or silence — so the event's `kind` is inferred
 * from the signal's semantic position and consumers that need the full
 * A/B/C/D lifecycle gate on `source === 'osc133'`.
 *
 * Arbitration
 * -----------
 * When two signals emit the same `kind` within `suppressionWindowMs`, the
 * lower-confidence event is suppressed (the surviving higher-confidence
 * event is what the caller sees). This is the "OSC 133 retracts heuristic"
 * semantic from the P1-A plan: if the heuristic fires first and OSC 133 D
 * arrives 40 ms later for the same boundary, the heuristic event is dropped
 * from the public event stream and the OSC 133 event is emitted with full
 * authority. Suppressed events are reported to `onSuppressed` for telemetry.
 *
 * Order of ops inside `feed`
 * --------------------------
 * 1. Byte-level scan emits OSC 133 raw signals.
 * 2. Line-tracker updates for CR/LF/cursor-home detection.
 * 3. Regex matcher runs on any line completed during this feed.
 * 4. Idle timer is (re)armed — any byte pushes the idle deadline out.
 *
 * Steps 1-3 all produce candidate events; step 4 only produces an event on
 * tick. Candidates are ordered by emission time and run through arbitration
 * before returning.
 */

import type {
  BoundaryEvent,
  BoundaryEventKind,
  BoundarySource,
  HybridBoundaryDetector,
  HybridBoundaryDetectorOptions,
} from './hybrid-detector-types.js';

// ----- Byte constants -----

const BEL = 0x07;
const BS = 0x08;
const HT = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const ESC = 0x1b;
// Numerics used by the parser — `0'` and `9'` are inclusive.
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const CHAR_SEMI = 0x3b;
const CHAR_EQ = 0x3d;
const CHAR_BACKSLASH = 0x5c;

// Default prompt regexes — matched against decoded line text. Each must
// anchor at start (`^`) because the matcher only tests text that began at
// column 0. See `DEFAULT_PROMPT_PATTERNS` docstring above the constant.
const DEFAULT_PROMPT_PATTERNS: readonly RegExp[] = [
  // Bash/sh: `$ `, `$\t`, or `$` at EOL.
  /^\$[ \t]?$/,
  // Zsh: `% ` or `%` at EOL.
  /^%[ \t]?$/,
  // Root: `# ` or `#` at EOL.
  /^#[ \t]?$/,
  // Continuation / nushell / powershell: `> ` or `>` at EOL.
  /^>[ \t]?$/,
  // Themed prompts that END with the glyph+space pattern. Anchored at the
  // last token to avoid matching `ls -l | grep foo $ bar` (not at EOL) but
  // still allow `~/src (main) $ `.
  /[$#%>][ \t]$/,
];

const DEFAULT_IDLE_TIMEOUT_MS = 400;
const DEFAULT_SUPPRESSION_WINDOW_MS = 200;

// Confidence tiers — see `hybrid-detector-types.ts` for the full table.
const CONF_OSC133 = 1.0;
const CONF_REGEX_INSTALLED = 0.8;
const CONF_REGEX_DEFAULT = 0.6;
const CONF_CURSOR_HOME = 0.5;
const CONF_IDLE = 0.1;

// ----- OSC 133 parser state machine -----
//
// Accepts:
//   ESC ] 133 ; (A|B|C|D) [ ; payload ] (BEL | ESC \)
//
// The payload on D may look like `D;2` or `D;2;aid=sess;duration=123` —
// we parse `2` as the exit code, any `key=value` pairs via split-scan for
// `duration_ms` / `cwd` / `exit`, and silently ignore unknowns. Malformed
// payloads fall back to `exitCode: null` and still emit the event (P1-A
// contract: graceful degrade, never drop an authoritative kind).

/**
 * Unified escape-sequence parser. The byte loop routes every byte through
 * one of these states — we do NOT have separate OSC vs CSI parsers racing
 * for ESC consumption (a prior iteration did, and the OSC branch would
 * swallow `ESC [ H` before CSI saw it, producing wrong cursor-home
 * detection). This is a classical VT parser skeleton trimmed to the
 * subset we care about:
 *
 *   normal → saw_esc → {
 *     saw_csi (`[`),
 *     saw_osc (`]`),
 *     back to normal on anything else
 *   }
 *   saw_csi → in_csi_params → final (0x40..0x7e) → normal
 *   saw_osc → reading OSC code (digits) → `;` → payload → BEL | ESC\
 *
 * `idle` is the state outside any escape sequence — regular bytes flow
 * to the line tracker.
 */
type EscState =
  | 'normal'
  | 'saw_esc'
  | 'in_csi'
  | 'in_osc_code'
  | 'in_osc_payload'
  | 'in_osc_payload_esc';

interface OscPayload {
  /** Accumulated OSC code bytes (digits) — read as decimal integer. */
  code: number[];
  /** Accumulated payload bytes (after the `;` following the code). */
  payload: number[];
  /** True once `;` has been seen — we're past the code, collecting payload. */
  sawSemi: boolean;
  /** Cap to bail on runaway OSCs without a terminator. */
  cap: number;
}

function newOscPayload(): OscPayload {
  return { code: [], payload: [], sawSemi: false, cap: 4096 };
}

// ----- Line tracker (for regex + cursor-home detection) -----
//
// We keep a rolling "current line" decoded-as-UTF-8 buffer, reset on LF.
// When LF is seen, we push the completed line into `completedLines`, and
// the regex matcher fires on each completed line. Cursor-home (ESC [ H)
// and erase-line (ESC [ K or ESC [ 2 J) are tracked as a short temporal
// window: a cursor-home followed within a handful of bytes by an erase
// counts as a "prompt redraw" signal.

interface LineTracker {
  /** Bytes of the current (incomplete) line. */
  line: number[];
  /** Column cursor within the current line — advanced by printable bytes
   *  and reset to 0 by CR / LF / cursor-home. */
  col: number;
  /** True when the last non-CSI byte brought us to column 0 — used by the
   *  regex path to gate matches to actual prompt positions. */
  atCol0: boolean;
  /** Recent cursor-home (ESC [ H) emission timestamp. Used to correlate
   *  with a following ESC [ K / 2 J within a short window. */
  cursorHomeAtMs: number;
  /** Recent erase-line / erase-screen emission timestamp. */
  eraseAtMs: number;
}

function newLineTracker(): LineTracker {
  return {
    line: [],
    col: 0,
    atCol0: true,
    cursorHomeAtMs: -Infinity,
    eraseAtMs: -Infinity,
  };
}

// ----- Utilities -----

function decodeUtf8(bytes: readonly number[]): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return '';
  }
}

function parseOsc133Payload(payload: string): {
  kind: BoundaryEventKind;
  exitCode?: number | null;
  cwd?: string;
  durationMs?: number;
} | null {
  // Expected shapes:
  //   A                 → prompt_start
  //   B                 → command_start
  //   C                 → output_start
  //   D                 → command_end, exit unknown
  //   D;<int>           → command_end, exit code
  //   D;<int>;key=val;…
  //   Any of the above with trailing `;key=val` we also honour.
  if (payload.length === 0) return null;
  const marker = payload.charCodeAt(0);
  let kind: BoundaryEventKind;
  switch (marker) {
    case 0x41: // 'A'
      kind = 'prompt_start';
      break;
    case 0x42: // 'B'
      kind = 'command_start';
      break;
    case 0x43: // 'C'
      kind = 'output_start';
      break;
    case 0x44: // 'D'
      kind = 'command_end';
      break;
    default:
      return null;
  }
  if (kind !== 'command_end') return { kind };
  const rest = payload.slice(1);
  if (rest.length === 0) return { kind, exitCode: null };
  // Strip leading `;` if present.
  const body = rest.startsWith(';') ? rest.slice(1) : rest;
  const parts = body.split(';').filter((p) => p.length > 0);
  const out: {
    kind: BoundaryEventKind;
    exitCode: number | null;
    cwd?: string;
    durationMs?: number;
  } = { kind, exitCode: null };
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i] as string;
    // First positional segment with no `=` is the exit code (POSIX contract).
    if (i === 0 && !p.includes('=')) {
      const n = Number.parseInt(p, 10);
      if (Number.isFinite(n)) out.exitCode = n;
      continue;
    }
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const key = p.slice(0, eq);
    const value = p.slice(eq + 1);
    if (key === 'cwd') out.cwd = value;
    else if (key === 'duration_ms' || key === 'duration') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) out.durationMs = n;
    } else if (key === 'exit' || key === 'exitcode' || key === 'exit_code') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) out.exitCode = n;
    }
  }
  return out;
}

// ----- Factory -----

export function createHybridBoundaryDetector(
  options: HybridBoundaryDetectorOptions,
): HybridBoundaryDetector {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const suppressionWindowMs =
    options.suppressionWindowMs ?? DEFAULT_SUPPRESSION_WINDOW_MS;
  const promptPatterns = options.promptPatterns ?? DEFAULT_PROMPT_PATTERNS;
  const now = options.now ?? Date.now;
  const integration = options.shellIntegration;
  const regexConfidence =
    integration === 'installed' || integration === 'detected'
      ? CONF_REGEX_INSTALLED
      : CONF_REGEX_DEFAULT;

  // Signal enable flags. OSC 133 is watched unconditionally because shells
  // may emit it on a `missing`-status session (user-supplied rc); the
  // router uses `setSignals` to turn off tiers if desired.
  const enabled: Record<BoundarySource, boolean> = {
    osc133: true,
    heuristic_regex: true,
    cursor_home: true,
    idle: true,
  };

  // Parser / tracker state — one unified escape-sequence FSM (see EscState).
  let esc: EscState = 'normal';
  let osc: OscPayload = newOscPayload();
  // CSI param buffer — digits + `;`, bounded to prevent unbounded growth
  // on malformed streams. Params are interpreted on the CSI final byte.
  let csiParams: number[] = [];
  let lineTracker = newLineTracker();

  // Arbitration: remember the most recent emission timestamp per kind so
  // suppression can be computed without holding a full event buffer.
  const lastEmittedByKind: Map<BoundaryEventKind, BoundaryEvent> = new Map();

  // Idle-timer bookkeeping. We do not rely on `setTimeout` inside `feed`
  // (that couples emission to the event loop and makes tests flaky).
  // Instead we record "the latest signal seen" and emit on `tick` when
  // the elapsed time exceeds the threshold. `feed` also calls the same
  // tick logic to surface idle events whose deadlines have been crossed
  // by wall-clock drift between feeds.
  let lastByteAtMs = now();
  let idleEmittedForBurst = false; // fires once per quiet window

  function resetIdle(t: number): void {
    lastByteAtMs = t;
    idleEmittedForBurst = false;
  }

  /**
   * Arbitrate a candidate event. Returns whether the event should surface
   * to the caller. Updates `lastEmittedByKind` as a side-effect when the
   * event wins.
   */
  function arbitrate(candidate: BoundaryEvent): boolean {
    const existing = lastEmittedByKind.get(candidate.kind);
    if (!existing) {
      lastEmittedByKind.set(candidate.kind, candidate);
      return true;
    }
    const dt = candidate.at_ms - existing.at_ms;
    if (dt < 0 || dt > suppressionWindowMs) {
      // Outside window — candidate wins regardless of confidence because
      // it represents a new boundary opportunity.
      lastEmittedByKind.set(candidate.kind, candidate);
      return true;
    }
    // Within window: highest confidence wins. On tie, the FIRST one (the
    // already-emitted `existing`) remains; the candidate is suppressed.
    if (candidate.confidence > existing.confidence) {
      // Upgrade: the prior event was speculative. The candidate replaces
      // it in `lastEmittedByKind`; the prior is reported to the suppressed
      // sink so telemetry can count "OSC 133 upgraded a heuristic".
      options.onSuppressed?.(existing);
      lastEmittedByKind.set(candidate.kind, candidate);
      return true;
    }
    // Suppressed.
    options.onSuppressed?.(candidate);
    return false;
  }

  function emit(candidate: BoundaryEvent, out: BoundaryEvent[]): void {
    if (!enabled[candidate.source]) {
      // Source disabled at feed-time — drop silently. The arbitration map
      // does not update, so a future higher-tier event still lands fresh.
      return;
    }
    if (arbitrate(candidate)) {
      out.push(candidate);
      options.onEvent?.(candidate);
    }
  }

  /**
   * Unified escape-sequence state machine. Returns true when the byte was
   * consumed by an escape sequence; returns false when the byte is "plain"
   * content and should be forwarded to the line tracker.
   *
   * Dispatches to OSC and CSI branches via the `esc` state variable; OSC
   * 133 markers produce boundary events (emit into `out`) and cursor-home
   * + erase patterns produce cursor_home source boundary events.
   */
  function feedEscape(
    byte: number,
    at_ms: number,
    out: BoundaryEvent[],
  ): boolean {
    switch (esc) {
      case 'normal':
        if (byte === ESC) {
          esc = 'saw_esc';
          return true;
        }
        return false;
      case 'saw_esc':
        if (byte === 0x5b /* '[' */) {
          esc = 'in_csi';
          csiParams = [];
          return true;
        }
        if (byte === 0x5d /* ']' */) {
          esc = 'in_osc_code';
          osc = newOscPayload();
          return true;
        }
        // Other ESC-prefixed sequences (DCS `ESC P`, PM `ESC ^`, etc.) —
        // we don't parse them; treat this byte as the end of a one-byte
        // ESC dispatch and return to normal. The byte is consumed.
        esc = 'normal';
        return true;
      case 'in_csi':
        if (
          (byte >= DIGIT_0 && byte <= DIGIT_9) ||
          byte === CHAR_SEMI ||
          byte === CHAR_EQ ||
          byte === 0x3f /* ? */
        ) {
          if (csiParams.length < 32) csiParams.push(byte);
          return true;
        }
        // Intermediate bytes 0x20..0x2f (space, !, etc.) — ignored but
        // still inside the sequence.
        if (byte >= 0x20 && byte < 0x30) {
          return true;
        }
        // Final byte 0x40..0x7e.
        handleCsiFinal(byte, at_ms, out);
        esc = 'normal';
        return true;
      case 'in_osc_code':
        if (byte >= DIGIT_0 && byte <= DIGIT_9) {
          osc.code.push(byte);
          if (osc.code.length > 5) {
            // Runaway numeric code — abandon.
            esc = 'in_osc_payload';
          }
          return true;
        }
        if (byte === CHAR_SEMI) {
          osc.sawSemi = true;
          esc = 'in_osc_payload';
          return true;
        }
        if (byte === BEL) {
          // Degenerate: no `;`, no payload. Ignore.
          esc = 'normal';
          osc = newOscPayload();
          return true;
        }
        if (byte === ESC) {
          esc = 'in_osc_payload_esc';
          return true;
        }
        // Non-digit before `;` — treat rest as payload-ish so we still
        // terminate on BEL/ST without polluting the line.
        esc = 'in_osc_payload';
        return true;
      case 'in_osc_payload':
        if (byte === BEL) {
          finalizeOsc(at_ms, out);
          esc = 'normal';
          return true;
        }
        if (byte === ESC) {
          esc = 'in_osc_payload_esc';
          return true;
        }
        if (osc.payload.length >= osc.cap) {
          // Runaway payload — abandon. The next ESC/BEL will resync us.
          osc = newOscPayload();
          esc = 'normal';
          return true;
        }
        osc.payload.push(byte);
        return true;
      case 'in_osc_payload_esc':
        if (byte === CHAR_BACKSLASH) {
          finalizeOsc(at_ms, out);
          esc = 'normal';
          return true;
        }
        // Not ST — the ESC was literal payload. Revert and re-process.
        osc.payload.push(ESC);
        esc = 'in_osc_payload';
        return feedEscape(byte, at_ms, out);
    }
    return false;
  }

  function finalizeOsc(at_ms: number, out: BoundaryEvent[]): void {
    const codeText = decodeUtf8(osc.code);
    const payloadText = decodeUtf8(osc.payload);
    osc = newOscPayload();
    // We only emit events for OSC 133 — other codes (OSC 7 cwd, OSC 1337
    // metadata, etc.) are parsed and discarded silently so they cannot
    // contaminate regex matching or idle-timer state.
    if (codeText !== '133') return;
    if (payloadText.length === 0) return;
    const firstChar = payloadText.charCodeAt(0);
    if (
      firstChar !== 0x41 &&
      firstChar !== 0x42 &&
      firstChar !== 0x43 &&
      firstChar !== 0x44
    ) {
      return;
    }
    const parsed = parseOsc133Payload(payloadText);
    if (!parsed) return;
    const event: BoundaryEvent = {
      kind: parsed.kind,
      source: 'osc133',
      confidence: CONF_OSC133,
      at_ms,
      ...(parsed.kind === 'command_end'
        ? {
            exitCode: parsed.exitCode ?? null,
            ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
            ...(parsed.durationMs !== undefined
              ? { durationMs: parsed.durationMs }
              : {}),
          }
        : {}),
    };
    emit(event, out);
  }

  function handleCsiFinal(
    final: number,
    at_ms: number,
    out: BoundaryEvent[],
  ): void {
    // Decode params as a list of semicolon-separated integers (default 0).
    const paramsText = decodeUtf8(csiParams);
    const nums = paramsText
      .split(';')
      .map((s) => (s === '' ? 0 : Number.parseInt(s, 10)))
      .map((n) => (Number.isFinite(n) ? n : 0));
    switch (final) {
      case 0x48 /* 'H' */:
      case 0x66 /* 'f' */: {
        // Cursor position. `ESC [ H`, `ESC [ 1;1 H`, `ESC [ H f` all home.
        // Row/col default 1; anything else is a navigation away from home.
        const row = nums[0] ?? 1;
        const col = nums[1] ?? 1;
        if (row <= 1 && col <= 1) {
          lineTracker.cursorHomeAtMs = at_ms;
          lineTracker.col = 0;
          lineTracker.atCol0 = true;
          maybeEmitCursorHome(at_ms, out);
        }
        break;
      }
      case 0x4b /* 'K' */:
        // Erase in line. Any variant (0, 1, 2) hints at prompt redraw.
        lineTracker.eraseAtMs = at_ms;
        maybeEmitCursorHome(at_ms, out);
        break;
      case 0x4a /* 'J' */: {
        // Erase in display. `2J` / `3J` wipe the screen → classic prompt
        // redraw. `0J` and `1J` are partial; we accept them as hints too.
        const mode = nums[0] ?? 0;
        if (mode >= 0) {
          lineTracker.eraseAtMs = at_ms;
          maybeEmitCursorHome(at_ms, out);
        }
        break;
      }
      default:
        break;
    }
  }

  function maybeEmitCursorHome(
    at_ms: number,
    out: BoundaryEvent[],
  ): void {
    // Require BOTH a cursor-home AND an erase in a close window. Either
    // alone is too noisy (any redraw uses cursor-home; any line-edit
    // uses erase). Together they are the classic prompt-redraw pattern.
    if (
      lineTracker.cursorHomeAtMs === -Infinity ||
      lineTracker.eraseAtMs === -Infinity
    ) {
      return;
    }
    const gap = Math.abs(lineTracker.cursorHomeAtMs - lineTracker.eraseAtMs);
    if (gap > 50) return;
    const event: BoundaryEvent = {
      kind: 'prompt_start',
      source: 'cursor_home',
      confidence: CONF_CURSOR_HOME,
      at_ms,
    };
    emit(event, out);
    // Reset so a later home/erase pair must be observed again.
    lineTracker.cursorHomeAtMs = -Infinity;
    lineTracker.eraseAtMs = -Infinity;
  }

  /**
   * Feed a printable (non-escape) byte through the line tracker.
   */
  function feedLineByte(byte: number, at_ms: number, out: BoundaryEvent[]): void {
    if (byte === LF) {
      // Line complete. Run regex against it.
      const text = decodeUtf8(lineTracker.line);
      lineTracker.line = [];
      lineTracker.col = 0;
      lineTracker.atCol0 = true;
      maybeEmitRegex(text, at_ms, out);
      return;
    }
    if (byte === CR) {
      // CR resets column without flushing — next bytes overwrite the
      // current line. We keep the buffer so a bare `\r` doesn't lose
      // prompt text but reset atCol0.
      lineTracker.col = 0;
      lineTracker.atCol0 = true;
      return;
    }
    if (byte === BS) {
      // Backspace: retreat column.
      if (lineTracker.col > 0) lineTracker.col -= 1;
      if (lineTracker.line.length > 0) lineTracker.line.pop();
      return;
    }
    if (byte === HT) {
      // Tab — advance to next 8-col stop. Don't add to line bytes (tabs
      // don't survive regex matching anyway).
      lineTracker.col = (Math.floor(lineTracker.col / 8) + 1) * 8;
      lineTracker.atCol0 = false;
      return;
    }
    if (byte < 0x20) {
      // Other control bytes — skip.
      return;
    }
    lineTracker.line.push(byte);
    lineTracker.col += 1;
    lineTracker.atCol0 = false;
    // Partial-line match: most interactive prompts hang on the same line
    // waiting for user input, so we fire on trailing `<glyph> ` / `<glyph>\t`
    // as soon as that token arrives. We only test when the LATEST byte is
    // space or tab AND the preceding byte is one of `$ % # >` — anything
    // else cannot possibly satisfy the anchored prompt patterns so the
    // test is skipped. This avoids the `foo $ bar baz` false positive
    // (the prompt glyph isn't adjacent to the trailing space).
    if (
      (byte === 0x20 /* ' ' */ || byte === HT) &&
      lineTracker.line.length >= 2
    ) {
      const prev = lineTracker.line[lineTracker.line.length - 2];
      if (prev === 0x24 || prev === 0x25 || prev === 0x23 || prev === 0x3e) {
        const text = decodeUtf8(lineTracker.line);
        maybeEmitRegex(text, at_ms, out);
      }
    }
  }

  function maybeEmitRegex(
    text: string,
    at_ms: number,
    out: BoundaryEvent[],
  ): void {
    if (text.length === 0) return;
    for (const pattern of promptPatterns) {
      if (pattern.test(text)) {
        const event: BoundaryEvent = {
          kind: 'prompt_start',
          source: 'heuristic_regex',
          confidence: regexConfidence,
          at_ms,
        };
        emit(event, out);
        return;
      }
    }
  }

  /**
   * Main feed entry point.
   */
  function feed(chunk: Uint8Array): BoundaryEvent[] {
    const out: BoundaryEvent[] = [];
    if (chunk.length === 0) return out;
    // Check for idle-deadline crossings since the last feed. A burst of
    // bytes arriving well after `idleTimeoutMs` should emit the idle
    // event for the prior quiet window BEFORE processing the new bytes.
    const t0 = now();
    if (enabled.idle && !idleEmittedForBurst) {
      const elapsed = t0 - lastByteAtMs;
      if (elapsed >= idleTimeoutMs) {
        const event: BoundaryEvent = {
          kind: 'command_end',
          source: 'idle',
          confidence: CONF_IDLE,
          at_ms: t0,
          exitCode: null,
        };
        emit(event, out);
        idleEmittedForBurst = true;
      }
    }

    for (let i = 0; i < chunk.length; i += 1) {
      const byte = chunk[i] as number;
      const t = now();
      // Unified escape FSM (OSC + CSI). Returns true when the byte was
      // absorbed — such bytes must NOT reach the line tracker, else OSC
      // payload contents would pollute the regex matcher (see the
      // `$ ` inside OSC 133 D cwd= payload test case).
      if (feedEscape(byte, t, out)) continue;
      feedLineByte(byte, t, out);
    }
    resetIdle(now());
    return out;
  }

  /**
   * Advance the idle timer without feeding bytes. Emits one idle event
   * when the silence threshold has elapsed; subsequent ticks in the same
   * quiet window are no-ops (guarded by `idleEmittedForBurst`).
   */
  function tick(nowMs: number): BoundaryEvent[] {
    const out: BoundaryEvent[] = [];
    if (!enabled.idle) return out;
    if (idleEmittedForBurst) return out;
    const elapsed = nowMs - lastByteAtMs;
    if (elapsed < idleTimeoutMs) return out;
    const event: BoundaryEvent = {
      kind: 'command_end',
      source: 'idle',
      confidence: CONF_IDLE,
      at_ms: nowMs,
      exitCode: null,
    };
    emit(event, out);
    idleEmittedForBurst = true;
    return out;
  }

  function setSignals(patch: Partial<Record<BoundarySource, boolean>>): void {
    for (const key of Object.keys(patch) as BoundarySource[]) {
      const value = patch[key];
      if (value === undefined) continue;
      enabled[key] = value;
    }
  }

  function reset(): void {
    esc = 'normal';
    osc = newOscPayload();
    csiParams = [];
    lineTracker = newLineTracker();
    lastEmittedByKind.clear();
    lastByteAtMs = now();
    idleEmittedForBurst = false;
  }

  return { feed, tick, setSignals, reset };
}
