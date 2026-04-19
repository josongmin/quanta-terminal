/**
 * One-shot snapshot read of `TerminalModeState` from the EPIC-C
 * `GridMirror`. The encoder layer calls `ModeSnapshot.read()` at the
 * start of every `encode()` call; the returned value is deep-frozen and
 * never re-read mid-encode.
 *
 * EPIC-E §7 contract. The full `GridMirror` class ships in EPIC-C; we
 * accept the narrow adapter interface below so tests can stub.
 */
import type { TerminalModeSnapshot } from './types';

/**
 * Narrow structural interface matching the subset of EPIC-C's
 * `GridMirror` that `ModeSnapshot` consumes. EPIC-C's real class is
 * accepted here by structural typing without importing from
 * `shared/lib/grid-mirror/` (which is EPIC-C's scope and not yet landed).
 */
export interface GridMirrorLike {
  /** Returns the current `TerminalModeState` subset relevant to input encoding. */
  snapshotMode(): Omit<TerminalModeSnapshot, 'snapshotEpoch'>;
  /** Monotonic counter bumped on every ModeChanged apply. */
  getAppliedEpoch(): bigint;
}

/**
 * Deeply freeze a plain object. We only need single-level freezing for
 * the snapshot shape (no nested mutable members in EPIC-E's subset), but
 * the helper recurses defensively so future extensions remain immutable.
 */
function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value as object) as (keyof T)[]) {
    const v = value[key];
    if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return Object.freeze(value);
}

export class ModeSnapshot {
  readonly #mirror: GridMirrorLike;

  constructor(mirror: GridMirrorLike) {
    this.#mirror = mirror;
  }

  /** One-shot. Returns a deeply frozen `TerminalModeSnapshot`. */
  read(): TerminalModeSnapshot {
    const mode = this.#mirror.snapshotMode();
    const epoch = this.#mirror.getAppliedEpoch();
    const snapshot: TerminalModeSnapshot = {
      decckm: mode.decckm,
      bracketedPaste: mode.bracketedPaste,
      focusReporting: mode.focusReporting,
      mouseTracking: mode.mouseTracking,
      mouseEncoding: mode.mouseEncoding,
      modifyOtherKeys: mode.modifyOtherKeys,
      kittyKeyboard: mode.kittyKeyboard,
      altScreen: mode.altScreen,
      synchronizedUpdate: mode.synchronizedUpdate,
      snapshotEpoch: epoch,
    };
    return deepFreeze(snapshot);
  }

  /** Returns the current mirror epoch without building a full snapshot. */
  peekEpoch(): bigint {
    return this.#mirror.getAppliedEpoch();
  }
}

/**
 * Stub `GridMirror` for tests + downstream integration until EPIC-C lands.
 * The real mirror replaces this via structural typing.
 */
export function createStubMirror(initial?: Partial<Omit<TerminalModeSnapshot, 'snapshotEpoch'>>): GridMirrorLike & {
  applyMode(update: Partial<Omit<TerminalModeSnapshot, 'snapshotEpoch'>>): void;
} {
  const state: Omit<TerminalModeSnapshot, 'snapshotEpoch'> = {
    decckm: false,
    bracketedPaste: false,
    focusReporting: false,
    mouseTracking: 'off',
    mouseEncoding: 'default',
    modifyOtherKeys: 0,
    kittyKeyboard: 0,
    altScreen: false,
    synchronizedUpdate: false,
    ...initial,
  };
  let epoch = 0n;
  return {
    snapshotMode() {
      return { ...state };
    },
    getAppliedEpoch() {
      return epoch;
    },
    applyMode(update) {
      Object.assign(state, update);
      epoch += 1n;
    },
  };
}
