/**
 * backpressure-classifier — Plan 0005 P2-C.
 *
 * Classifies a PTY byte frame into one of four priority classes the priority
 * batcher (`write-batcher-priority.ts`) uses to decide what to drop first
 * under sustained load:
 *
 *   control     — OSC 133 (shell integration), OSC 7 (cwd), OSC 8 (hyperlink),
 *                 DEC private mode sets/resets (DECSET/DECRST), DCS
 *                 "synchronized update" (mode 2026), and lone signal bytes
 *                 (ENQ, BEL). These MUST NEVER be dropped — losing them
 *                 breaks prompts, link targets, and alt-screen state.
 *
 *   visible     — Bytes whose print position falls inside the current viewport.
 *                 Highest priority among the data classes: dropping any of
 *                 these is a user-visible glitch.
 *
 *   scrollback  — Bytes that will scroll off the viewport before the next
 *                 frame paint (e.g. `yes`, `find /`, CI log floods). These
 *                 are user-invisible in the steady state and can be
 *                 subsampled under pressure — the VT engine still needs a
 *                 contiguous stream, but we may skip whole byte-frames so
 *                 long as each dropped frame starts and ends at Ground.
 *
 *   verbose     — Explicit opt-in traffic the user flagged as noisy.
 *                 Activated either by the process-wide env `QUANTA_VERBOSE=1`
 *                 OR by a sentinel marker sequence: `ESC ] 4242 ; 1 BEL`
 *                 opens verbose classification, `ESC ] 4242 ; 0 BEL` closes
 *                 it. The marker is parsed out of band by the priority
 *                 batcher; this classifier only needs to answer "if the
 *                 verbose gate is already open, is this byte-frame pure
 *                 data?". The marker OSC itself stays `control` so it is
 *                 never dropped.
 *
 * FSM policy
 * ----------
 * The classifier does NOT do full VT parsing. It peeks at CSI/OSC/DCS
 * *starts* — enough to distinguish a control-class escape from a visible
 * run of text. A frame is inspected byte-by-byte under a small state
 * machine; the highest-priority class it touched wins:
 *
 *   control > visible > scrollback > verbose
 *
 * (Higher-priority means "protected from drop".) That ordering is
 * intentional: a single OSC 7 buried in a megabyte of scrollback text
 * pins the whole frame to `control`, which is the safe choice — the
 * batcher will not drop that frame even if every other byte in it is
 * cheap log noise. The frame boundaries are chosen upstream (the priority
 * batcher splits the queue at Ground, matching the sequence-safe boundary
 * detector in `write-batcher-frame-skip.ts`), so a "frame" passed in here
 * is always self-contained — any escape that opens inside the frame also
 * closes inside the frame.
 *
 * Why FSM and not regex: regex over binary streams is both slow and
 * error-prone on CSI/OSC parameter byte ranges. The FSM is ~25 lines and
 * runs in O(n) with zero allocation.
 */

export type PriorityClass = 'control' | 'visible' | 'scrollback' | 'verbose';

export interface ClassifyContext {
  /**
   * Whether the terminal is currently on the alternate screen (set by
   * DEC mode 1049/47/1047). When true, scrollback cannot accumulate —
   * anything non-visible is still overwritten in place, so we classify
   * all data bytes as `visible` by default.
   */
  readonly inAltScreen: boolean;
  /** Current cursor row (0-indexed). */
  readonly cursorY: number;
  /** Viewport height in rows. */
  readonly viewportRows: number;
  /**
   * Whether the verbose gate is currently open (set by
   * `ESC ] 4242 ; 1 BEL` and cleared by `ESC ] 4242 ; 0 BEL`, OR by the
   * `QUANTA_VERBOSE=1` env). The priority batcher owns this flag and
   * forwards it verbatim; defaults to false.
   */
  readonly verboseGateOpen?: boolean;
}

// ---------- Byte constants ----------

const ESC = 0x1b;
const BEL = 0x07;
const LF = 0x0a;
const CR = 0x0d;
const ENQ = 0x05;

// ---------- Classifier ----------

type State =
  | 'Ground'
  | 'Esc'
  | 'Csi'
  | 'CsiQuestion' // CSI ? — DEC private mode
  | 'Osc'
  | 'OscNumber' // collecting the leading numeric parameter of an OSC
  | 'Dcs'
  | 'DcsParams' // collecting the DCS final-letter prefix (mode 2026)
  | 'Apc'
  | 'Pm'
  | 'EscInString';

/** Minimum-priority merge: keep the HIGHER-priority (more protected) class. */
function mergePriority(a: PriorityClass, b: PriorityClass): PriorityClass {
  const rank: Record<PriorityClass, number> = {
    control: 3,
    visible: 2,
    scrollback: 1,
    verbose: 0,
  };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Classify a byte frame.
 *
 * Contract:
 *   - `bytes` is a self-contained frame: any CSI/OSC/DCS that starts inside
 *     it also ends inside it. (The priority batcher enforces this by cutting
 *     only at Ground.)
 *   - Returns exactly one class; ties broken by the priority merge above.
 *   - Pure function — no mutation of the context.
 */
export function classifyByteFrame(
  bytes: Uint8Array,
  context: ClassifyContext,
): PriorityClass {
  if (bytes.byteLength === 0) {
    // An empty frame is a no-op; treat as scrollback so an upstream caller
    // doesn't accidentally pin the queue to `control` on a zero-length poke.
    return 'scrollback';
  }

  // Start optimistic: a pure-data frame's default class depends on where the
  // cursor lives. On the alt-screen there IS no scrollback, so everything
  // below that is user-visible; on the normal screen, writes at or past the
  // last visible row will scroll the top off, so we tentatively call them
  // `scrollback`. If we see an escape that promotes us to `control`, we keep
  // the promoted value.
  const defaultDataClass: PriorityClass = computeDefaultDataClass(context);

  // Verbose subclass only applies when the gate is open AND the frame is
  // pure data (no control escapes). We downgrade the default to `verbose`
  // up front; any control escape below re-promotes it.
  let current: PriorityClass =
    context.verboseGateOpen === true ? 'verbose' : defaultDataClass;

  let state: State = 'Ground';
  // Short parameter buffer for OSC/DCS numeric prefixes. We only care about
  // the first ~4 numeric chars — enough for "133", "4242", "2026".
  let paramBuf = '';

  for (let i = 0; i < bytes.byteLength; i += 1) {
    const byte = bytes[i]!;
    switch (state) {
      case 'Ground':
        if (byte === ESC) {
          state = 'Esc';
        } else if (byte === ENQ) {
          // ENQ is a classic "answerback" signal byte. Keep as control.
          current = mergePriority(current, 'control');
        }
        // Most printable bytes fall through and do not change the class.
        // LF/CR don't change the class — they just advance the cursor, which
        // is why we base the default on the CALLER'S cursorY; the batcher
        // updates the context between frames.
        break;

      case 'Esc':
        if (byte === 0x5b /* [ */) {
          state = 'Csi';
        } else if (byte === 0x5d /* ] */) {
          state = 'Osc';
          paramBuf = '';
        } else if (byte === 0x50 /* P */) {
          state = 'Dcs';
          paramBuf = '';
        } else if (byte === 0x5f /* _ */) {
          state = 'Apc';
        } else if (byte === 0x5e /* ^ */) {
          state = 'Pm';
        } else {
          // Other escapes (single-shifts, charset selects, RIS 'c', 7/8,
          // DECSC/DECRC) dispatch in one byte. They can affect cursor/mode
          // but are rare and small; classify conservatively as visible.
          current = mergePriority(current, 'visible');
          state = 'Ground';
        }
        break;

      case 'Csi':
        // `?` immediately after CSI marks a DEC-private parameter — the
        // sequences that change alt-screen / cursor-mode / mouse tracking.
        if (byte === 0x3f /* ? */) {
          state = 'CsiQuestion';
        } else if (isCsiFinal(byte)) {
          // Generic CSI (SGR, cursor move, erase). Visible, not control.
          current = mergePriority(current, 'visible');
          state = 'Ground';
        }
        // else: still collecting params/intermediates — stay in Csi.
        break;

      case 'CsiQuestion':
        if (isCsiFinal(byte)) {
          // DEC private mode — `?...h` set, `?...l` reset. These include
          // alt-screen, cursor visibility, bracketed paste, mouse on/off —
          // all protocol state.
          current = mergePriority(current, 'control');
          state = 'Ground';
        }
        // else: stay collecting params.
        break;

      case 'Osc':
        // First OSC byte starts the numeric prefix (or, rarely, goes
        // straight to string body). Collect the leading digits into
        // paramBuf; stop on ';', BEL, ESC, or overflow.
        if (byte >= 0x30 && byte <= 0x39 /* 0..9 */) {
          state = 'OscNumber';
          paramBuf = String.fromCharCode(byte);
        } else if (byte === BEL) {
          // Empty OSC — treat as visible (no meaningful protocol).
          current = mergePriority(current, 'visible');
          state = 'Ground';
        } else if (byte === ESC) {
          state = 'EscInString';
        }
        // else: OSC body without a numeric prefix (very rare); stay in Osc.
        break;

      case 'OscNumber':
        if (byte >= 0x30 && byte <= 0x39 && paramBuf.length < 5) {
          paramBuf += String.fromCharCode(byte);
        } else {
          // End of numeric prefix. Decide by the prefix.
          if (isControlOscNumber(paramBuf)) {
            current = mergePriority(current, 'control');
          } else {
            current = mergePriority(current, 'visible');
          }
          // The current byte is a ';', BEL, ESC, or data; fall through by
          // swapping to the generic Osc-body handling.
          if (byte === BEL) {
            state = 'Ground';
          } else if (byte === ESC) {
            state = 'EscInString';
          } else {
            state = 'Osc';
          }
        }
        break;

      case 'Dcs':
        // DCS can carry many sub-protocols; we're specifically interested
        // in "2026" (synchronized update). Its final-letter prefix begins
        // with `=1s` or `=2s` per the mode 2026 spec, but in practice the
        // param buffer carries the mode number first.
        if (byte >= 0x30 && byte <= 0x39 /* digit */) {
          state = 'DcsParams';
          paramBuf = String.fromCharCode(byte);
        } else if (byte === BEL) {
          current = mergePriority(current, 'visible');
          state = 'Ground';
        } else if (byte === ESC) {
          state = 'EscInString';
        }
        break;

      case 'DcsParams':
        if (byte >= 0x30 && byte <= 0x39 && paramBuf.length < 5) {
          paramBuf += String.fromCharCode(byte);
        } else {
          if (isControlDcsNumber(paramBuf)) {
            current = mergePriority(current, 'control');
          } else {
            current = mergePriority(current, 'visible');
          }
          if (byte === BEL) {
            state = 'Ground';
          } else if (byte === ESC) {
            state = 'EscInString';
          } else {
            state = 'Dcs';
          }
        }
        break;

      case 'Apc':
      case 'Pm':
        if (byte === BEL) {
          state = 'Ground';
          // APC/PM carry vendor-specific stuff (e.g. terminal capability
          // probes). Treat as visible — not protocol-critical for our VT.
          current = mergePriority(current, 'visible');
        } else if (byte === ESC) {
          state = 'EscInString';
        }
        break;

      case 'EscInString':
        if (byte === 0x5c /* \\ */) {
          // ESC \ — String Terminator. Close the string at whatever class
          // we previously resolved.
          state = 'Ground';
        } else {
          // Bogus ESC mid-string — xterm aborts; we continue collecting.
          state = 'Osc';
        }
        break;
    }

    // Early-exit optimisation: `control` is the top class. Once we've seen
    // one, no subsequent byte can raise priority higher.
    if (current === 'control') break;
  }

  return current;
}

// ---------- Helpers ----------

function isCsiFinal(byte: number): boolean {
  return byte >= 0x40 && byte <= 0x7e;
}

/**
 * OSC numeric prefixes we consider control-class. The full list lives in
 * xterm's ctlseqs manual; we pick the ones that carry *state* the UI
 * depends on.
 */
function isControlOscNumber(num: string): boolean {
  switch (num) {
    case '7': // cwd (current working directory)
    case '8': // hyperlink
    case '133': // shell integration (prompt markers)
    case '4242': // quanta verbose gate marker
      return true;
    default:
      return false;
  }
}

/**
 * DCS numeric prefixes we consider control-class. Today only "2026"
 * (synchronized update).
 */
function isControlDcsNumber(num: string): boolean {
  return num === '2026';
}

/**
 * Default class for a frame whose bytes are all plain data (no promotions).
 *
 *   - Alt-screen: everything is `visible` (no scrollback exists).
 *   - Normal screen with cursor above the last row: `visible`.
 *   - Normal screen with cursor at/below the last row: `scrollback`
 *     (subsequent newlines push the top off).
 */
function computeDefaultDataClass(ctx: ClassifyContext): PriorityClass {
  if (ctx.inAltScreen) return 'visible';
  if (ctx.viewportRows <= 0) return 'visible';
  // Cursor is zero-indexed; the last visible row is viewportRows - 1. A
  // cursor "at" the last row with inbound bytes is typically doing log
  // scrolling, so we bias toward scrollback.
  return ctx.cursorY >= ctx.viewportRows - 1 ? 'scrollback' : 'visible';
}

// ---------- Test-only exports ----------

export const __testing = {
  mergePriority,
  computeDefaultDataClass,
  isControlOscNumber,
  isControlDcsNumber,
  ENQ,
  LF,
  CR,
};
