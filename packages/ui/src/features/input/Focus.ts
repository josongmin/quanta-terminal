/**
 * Focus in/out encoder — EPIC-E §5 (Focus.ts).
 *
 * Emits `ESC [ I` (focus-in) / `ESC [ O` (focus-out) iff DECSET 1004 is on.
 */
import type { ModeSnapshot } from './ModeSnapshot';
import type { EncoderOutput, FocusEvent, TerminalModeSnapshot } from './types';

const FOCUS_IN = Uint8Array.of(0x1b, 0x5b, 0x49); // ESC [ I
const FOCUS_OUT = Uint8Array.of(0x1b, 0x5b, 0x4f); // ESC [ O

export class Focus {
  readonly #modeSnapshot: ModeSnapshot | { read(): TerminalModeSnapshot; peekEpoch(): bigint };

  constructor(opts: { modeSnapshot: ModeSnapshot | { read(): TerminalModeSnapshot; peekEpoch(): bigint } }) {
    this.#modeSnapshot = opts.modeSnapshot;
  }

  encode(event: FocusEvent, snapshot?: TerminalModeSnapshot): EncoderOutput {
    const used = snapshot ?? this.#modeSnapshot.read();
    const empty: EncoderOutput = {
      bytes: new Uint8Array(0),
      diagnostics: {
        modeReadInconsistency: false,
        deprecatedFallback: false,
        snapshotEpoch: used.snapshotEpoch,
      },
    };
    if (!used.focusReporting) return empty;
    const bytes = event.focused ? FOCUS_IN : FOCUS_OUT;
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
