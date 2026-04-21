/**
 * Mouse encoder — SGR 1006 primary path. When mouse tracking is off,
 * clicks and wheel are no-ops on the wire: wheel delegates to the
 * browser's native scroll (input-host does not preventDefault), in
 * line with xterm's standard where wheel is a mouse-tracking-only
 * event. EPIC-E §4.
 *
 * Alt-screen wheel fallback
 * -------------------------
 * Alt-screen programs (less / man / vim) render via the canvas grid
 * with `overflow:hidden` — the browser's native scroll has nothing to
 * scroll. When mouse tracking is OFF (the program didn't DECSET
 * 1000/1002/1003) AND alt-screen is active, a wheel event would
 * otherwise emit zero bytes and the user could not page through the
 * content. To keep those programs usable we translate wheel events to
 * arrow-up / arrow-down keystrokes, honoring DECCKM (ESC [ A/B vs
 * ESC O A/B). The count is approximated from `wheelLines` on the
 * event when provided, else a single press per wheel tick.
 */
import type { ModeSnapshot } from './ModeSnapshot';
import type {
  EncoderOutput,
  MouseEvent,
  TerminalModeSnapshot,
} from './types';

const utf8Encoder = new TextEncoder();

// Escape sequences for arrow-up / arrow-down under legacy CSI vs DECCKM SS3.
const ARROW_UP_CSI = new Uint8Array([0x1b, 0x5b, 0x41]); // ESC [ A
const ARROW_DOWN_CSI = new Uint8Array([0x1b, 0x5b, 0x42]); // ESC [ B
const ARROW_UP_SS3 = new Uint8Array([0x1b, 0x4f, 0x41]); // ESC O A
const ARROW_DOWN_SS3 = new Uint8Array([0x1b, 0x4f, 0x42]); // ESC O B

const BUTTON_BASE: Readonly<Record<MouseEvent['button'], number | null>> = {
  left: 0,
  middle: 1,
  right: 2,
  'wheel-up': 64,
  'wheel-down': 65,
  none: 3, // no-button; used for `any_event` hover-move
};

/** Build <Cb> for an SGR 1006 event. Returns null if not encodable. */
function buildCb(event: MouseEvent): number | null {
  const base = BUTTON_BASE[event.button];
  if (base === null) return null;

  let cb = base;

  // Drag: button codes 0-2 become 32-34.
  if (event.kind === 'drag' && (event.button === 'left' || event.button === 'middle' || event.button === 'right')) {
    cb = 32 + base;
  }
  // Hover-move with no button: emit 35 (drag-form with +3 → 32+3).
  if (event.kind === 'move' && event.button === 'none') {
    cb = 35;
  }

  // Modifier OR-ins: +4 Shift, +8 Meta/Alt (xterm collapses Opt/Alt/Meta into
  // one bit per ADR 0009), +16 Ctrl.
  if (event.modifiers.shift) cb |= 4;
  if (event.modifiers.alt || event.modifiers.meta) cb |= 8;
  if (event.modifiers.ctrl) cb |= 16;

  return cb;
}

function buildSgr(cb: number, xCell: number, yCell: number, terminator: 'M' | 'm'): Uint8Array {
  // xterm SGR 1006 columns/rows are 1-based with a minimum of 1.
  // Negative cell coords (e.g. clicks dispatched outside the grid) are
  // nonsense on the wire; clamp to 0 before the +1 so the wire value
  // bottoms out at 1. Upper bound is the caller's responsibility
  // (input-host clamps to cols/rows via `screenToCell`).
  const safeX = xCell < 0 ? 0 : xCell;
  const safeY = yCell < 0 ? 0 : yCell;
  const params = `<${cb};${safeX + 1};${safeY + 1}`;
  const encoded = utf8Encoder.encode(params);
  const out = new Uint8Array(2 + encoded.length + 1);
  out[0] = 0x1b;
  out[1] = 0x5b;
  out.set(encoded, 2);
  out[out.length - 1] = terminator === 'M' ? 0x4d : 0x6d;
  return out;
}

export class MouseEncoder {
  readonly #modeSnapshot: ModeSnapshot | { read(): TerminalModeSnapshot; peekEpoch(): bigint };

  constructor(opts: { modeSnapshot: ModeSnapshot | { read(): TerminalModeSnapshot; peekEpoch(): bigint } }) {
    this.#modeSnapshot = opts.modeSnapshot;
  }

  encode(event: MouseEvent, snapshot?: TerminalModeSnapshot): EncoderOutput {
    const used = snapshot ?? this.#modeSnapshot.read();
    const empty = (fallback = false) => ({
      bytes: new Uint8Array(0),
      diagnostics: {
        modeReadInconsistency: false,
        deprecatedFallback: fallback,
        snapshotEpoch: used.snapshotEpoch,
      },
    });

    const tracking = used.mouseTracking;

    // Tracking off → clicks and wheel are both no-ops on the wire.
    // Per xterm, wheel is a mouse-tracking-only event; when tracking is
    // off we emit zero bytes and input-host leaves the DOM event un-
    // prevented so the browser's native scroll handles it.
    //
    // EXCEPTION: alt-screen is active AND the event is a wheel tick.
    // Alt-screen renders with `overflow:hidden` and native scroll does
    // nothing, so we fall back to synthesizing arrow-key bytes so that
    // pagers (less / man / vim) can be driven by the wheel. DECCKM
    // switches between legacy CSI and SS3.
    if (tracking === 'off') {
      if (
        used.altScreen &&
        event.kind === 'wheel' &&
        (event.button === 'wheel-up' || event.button === 'wheel-down')
      ) {
        const count = Math.max(1, Math.floor(event.wheelLines ?? 1));
        const up = event.button === 'wheel-up';
        const seq = used.decckm
          ? (up ? ARROW_UP_SS3 : ARROW_DOWN_SS3)
          : (up ? ARROW_UP_CSI : ARROW_DOWN_CSI);
        const bytes = new Uint8Array(seq.length * count);
        for (let i = 0; i < count; i += 1) bytes.set(seq, i * seq.length);
        return {
          bytes,
          diagnostics: {
            modeReadInconsistency: false,
            deprecatedFallback: true,
            snapshotEpoch: used.snapshotEpoch,
          },
        };
      }
      return empty(false);
    }

    // Gate kinds per tracking mode.
    if (tracking === 'x10') {
      if (event.kind !== 'press') return empty(false);
    }
    if (tracking === 'button_event') {
      if (event.kind === 'move' && event.button === 'none') return empty(false);
    }
    // any_event allows all kinds.

    // Require SGR encoding in v1.
    if (used.mouseEncoding !== 'sgr' && used.mouseEncoding !== 'default') {
      return empty(true);
    }
    // `default` without SGR negotiation: treat as SGR for v1 (matches
    // EPIC-C wire default when no DECSET has been received yet).

    const cb = buildCb(event);
    if (cb === null) return empty(false);

    // Release uses `m`. Wheel has no release event by convention.
    const isRelease = event.kind === 'release';
    const terminator = isRelease ? 'm' : 'M';

    // Use the raw button base for release (SGR encodes which button
    // released via the <Cb>).
    const bytes = buildSgr(cb, event.xCell, event.yCell, terminator);
    return {
      bytes,
      diagnostics: {
        modeReadInconsistency: false,
        deprecatedFallback: false,
        snapshotEpoch: used.snapshotEpoch,
      },
    };
  }
}
