/**
 * ModeStack driver contract.
 *
 * Each driver is a small state machine that owns push/pop of ONE layer kind
 * on the ModeStack. Drivers receive raw PTY bytes through `feed()`; most of
 * them also expose signal hooks (OSC 7 cwd, tmux DCS replies) so integration
 * code can forward out-of-band events without re-parsing bytes.
 *
 * Design notes:
 *   - Drivers never read the full stack; they only `push`/`pop` their own
 *     layer id. That keeps the policy-resolution math centralized in the
 *     store and makes driver composition associative (installing two drivers
 *     in either order gives the same observable stack).
 *   - Byte FSMs live on the driver itself (not shared); each driver consumes
 *     the bytes it cares about and ignores the rest. The cost of running
 *     five FSMs is ~linear in total input, dwarfed by the TTY write cost.
 *   - Drivers are pure w.r.t. the store reference — pass in any compatible
 *     `ModeStackHandle` (the real zustand store, a mock, a disposable
 *     instance per test). No singletons are reached for by the drivers.
 */

import type { ModeStack } from '../mode-stack-store.js';

/**
 * Minimal subset of the store surface drivers actually use. Prevents a
 * driver from reaching into render-layer helpers like `useModeStackStore`.
 */
export interface ModeStackHandle {
  push: ModeStack['push'];
  pop: ModeStack['pop'];
  popUntil: ModeStack['popUntil'];
  topmost: ModeStack['topmost'];
}

/** Each driver returns this shape. */
export interface Driver {
  /** Feed raw PTY bytes (BE → UI direction). */
  feed(bytes: Uint8Array): void;
  /** Dispose: pops any owned layer and resets internal FSM state. */
  dispose(): void;
}
