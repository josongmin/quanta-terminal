/**
 * Mouse encoder — SGR 1006 primary path, wheel fallback to cursor keys
 * when mouse tracking is off. EPIC-E §4.
 */
import type { ModeSnapshot } from './ModeSnapshot';
import type {
  EncoderOutput,
  MouseEvent,
  TerminalModeSnapshot,
} from './types';

const utf8Encoder = new TextEncoder();

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
  const params = `<${cb};${xCell + 1};${yCell + 1}`;
  const encoded = utf8Encoder.encode(params);
  const out = new Uint8Array(2 + encoded.length + 1);
  out[0] = 0x1b;
  out[1] = 0x5b;
  out.set(encoded, 2);
  out[out.length - 1] = terminator === 'M' ? 0x4d : 0x6d;
  return out;
}

function wheelFallbackBytes(button: 'wheel-up' | 'wheel-down', snapshot: TerminalModeSnapshot): Uint8Array {
  const final = button === 'wheel-up' ? 0x41 /* A */ : 0x42; /* B */
  const intro = snapshot.decckm ? [0x1b, 0x4f] : [0x1b, 0x5b]; // ESC O / ESC [
  const single = Uint8Array.of(intro[0]!, intro[1]!, final);
  const out = new Uint8Array(single.length * 3);
  out.set(single, 0);
  out.set(single, single.length);
  out.set(single, single.length * 2);
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

    // Tracking off → wheel falls back to cursor keys; clicks no-op.
    if (tracking === 'off') {
      if (event.kind === 'wheel' && (event.button === 'wheel-up' || event.button === 'wheel-down')) {
        return {
          bytes: wheelFallbackBytes(event.button, used),
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
