/**
 * Top-level key encoder dispatcher — EPIC-E §3.1.
 *
 * Flow:
 *   1. `event.isComposing` → return empty bytes + `suppressedForComposition`.
 *   2. Select mode from snapshot (kitty > mkeys2 > legacy).
 *   3. Delegate to the chosen sub-encoder.
 *   4. Compare snapshot epoch vs live mirror epoch → `modeReadInconsistency`.
 *
 * `KeyEncoder` never reaches the DOM or the bridge; it produces bytes
 * only. `input-host.ts` is the sole wiring between DOM events and the
 * bridge (invariant I-6).
 */
import type { ModeSnapshot } from './ModeSnapshot';
import { encodeKitty } from './encoders/kitty';
import { encodeLegacy } from './encoders/legacy';
import { encodeModifyOtherKeysV1 } from './encoders/modify-other-keys-v1';
import { encodeModifyOtherKeysV2 } from './encoders/modify-other-keys-v2';
import type { EncoderOutput, EncodingMode, KeyEvent, TerminalModeSnapshot } from './types';

/** Pick the encoding mode according to the precedence in §3.1. */
export function selectEncodingMode(snapshot: TerminalModeSnapshot): {
  mode: EncodingMode;
  deprecatedFallback: boolean;
} {
  if (snapshot.kittyKeyboard >= 1) {
    const level = Math.min(snapshot.kittyKeyboard, 3) as 1 | 2 | 3;
    const fallback = snapshot.kittyKeyboard > 3;
    const mode = (`kitty-${level}`) as EncodingMode;
    return { mode, deprecatedFallback: fallback };
  }
  if (snapshot.modifyOtherKeys === 2) {
    return { mode: 'modify-other-keys-v2', deprecatedFallback: false };
  }
  if (snapshot.modifyOtherKeys === 1) {
    return { mode: 'modify-other-keys-v1', deprecatedFallback: false };
  }
  return { mode: 'legacy', deprecatedFallback: false };
}

export interface KeyEncoderOptions {
  /** Supplies the frozen snapshot; usually `ModeSnapshot` but tests can stub. */
  modeSnapshot: ModeSnapshot | { read(): TerminalModeSnapshot; peekEpoch(): bigint };
}

export class KeyEncoder {
  readonly #modeSnapshot: KeyEncoderOptions['modeSnapshot'];

  constructor(opts: KeyEncoderOptions) {
    this.#modeSnapshot = opts.modeSnapshot;
  }

  /**
   * Encode a single key event. If `snapshot` is omitted, it is read once
   * from the provided `ModeSnapshot`.
   */
  encode(event: KeyEvent, snapshot?: TerminalModeSnapshot): EncoderOutput {
    const used = snapshot ?? this.#modeSnapshot.read();

    // I-7: IME composing → suppress PTY emission.
    if (event.isComposing) {
      return {
        bytes: new Uint8Array(0),
        diagnostics: {
          modeReadInconsistency: false,
          deprecatedFallback: false,
          snapshotEpoch: used.snapshotEpoch,
          suppressedForComposition: true,
        },
      };
    }

    const { mode, deprecatedFallback } = selectEncodingMode(used);

    let bytes: Uint8Array;
    switch (mode) {
      case 'legacy':
        bytes = encodeLegacy(event, used);
        break;
      case 'modify-other-keys-v1':
        bytes = encodeModifyOtherKeysV1(event, used);
        break;
      case 'modify-other-keys-v2':
        bytes = encodeModifyOtherKeysV2(event, used);
        break;
      case 'kitty-1':
        bytes = encodeKitty(event, used, 1);
        break;
      case 'kitty-2':
        bytes = encodeKitty(event, used, 2);
        break;
      case 'kitty-3':
        bytes = encodeKitty(event, used, 3);
        break;
    }

    const liveEpoch = this.#modeSnapshot.peekEpoch();
    const modeReadInconsistency = liveEpoch !== used.snapshotEpoch;

    return {
      bytes,
      diagnostics: {
        modeReadInconsistency,
        deprecatedFallback,
        snapshotEpoch: used.snapshotEpoch,
      },
    };
  }
}
