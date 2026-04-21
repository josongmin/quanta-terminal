/**
 * ModeStack installer — wires the five drivers to a session's VT engine.
 *
 * Plan 0005 §P1-D integration step. The installer is the bridge between:
 *
 *   - `features/session/engine.ts` — owns the raw PTY byte stream and exposes
 *     `onRawByte(listener)` for synchronous, chunk-ordered observation
 *     (fires BEFORE the frame-skip batcher); AND
 *   - `features/mode-stack/drivers/*` — stateful FSMs that push/pop one
 *     layer kind each on the `useModeStackStore` singleton.
 *
 * The installer creates one driver per kind (optionally skipping any via the
 * `flags` arg), subscribes each driver's `feed()` method to `engine.onRawByte`,
 * and returns a `dispose()` that unsubscribes every driver AND calls each
 * driver's own `dispose()` so any in-flight layers pop cleanly.
 *
 * Design notes:
 *   - The installer uses the GLOBAL `useModeStackStore` — the ModeStack is a
 *     process-wide singleton (matches the existing `entities/tui` store and
 *     every other zustand store in the codebase). If we ever need per-session
 *     stacks we'd pass a handle in; for now the session id is carried only as
 *     a future-proofing parameter and to keep the installer signature stable.
 *   - Drivers that need extra signals (pager's `setProcessHint`, nested
 *     shell's `setShellLevel`, multiplexer's `exit`) are returned on the
 *     store-ish `drivers` field so the caller can forward OSC 7 / OSC 1337
 *     parsed payloads. The shared installer does NOT parse those payloads;
 *     see `shared/lib/vt-emulator/osc-subscribe.ts` (P1-A §A7).
 *   - Order of subscription is irrelevant — drivers only touch their own
 *     owned ids. Chose registration order alt → multiplexer → pager → repl →
 *     nested-shell to match the doc order in `index.ts`.
 */

import type { SessionId } from '@quanta/host-common';

import {
  useModeStackStore,
  type ModeStack,
} from './mode-stack-store.js';
import { createAltScreenDriver } from './drivers/alt-screen-driver.js';
import {
  createMultiplexerDriver,
  type MultiplexerDriver,
} from './drivers/multiplexer-driver.js';
import {
  createPagerDriver,
  type PagerDriver,
} from './drivers/pager-driver.js';
import { createReplDriver } from './drivers/repl-driver.js';
import {
  createNestedShellDriver,
  type NestedShellDriver,
} from './drivers/nested-shell-driver.js';
import type { Driver, ModeStackHandle } from './drivers/types.js';
import type { VtEngineHandle } from '../session/engine.js';

export type ModeStackDriverFlag =
  | 'altScreen'
  | 'multiplexer'
  | 'pager'
  | 'repl'
  | 'nestedShell';

export interface InstallModeStackOptions {
  /** Session id — carried for future per-session stacks / logging. */
  readonly sessionId: SessionId;
  /** VT engine whose raw byte stream will drive the FSMs. */
  readonly engine: VtEngineHandle;
  /**
   * Opt-out individual drivers. Missing keys and `true` values install the
   * driver; `false` skips it. Useful for tests that only care about one
   * layer kind and for A/B flags that progressively roll out detectors.
   */
  readonly flags?: Partial<Record<ModeStackDriverFlag, boolean>>;
}

export interface InstalledDrivers {
  readonly altScreen: Driver | null;
  readonly multiplexer: MultiplexerDriver | null;
  readonly pager: PagerDriver | null;
  readonly repl: Driver | null;
  readonly nestedShell: NestedShellDriver | null;
}

export interface ModeStackInstallHandle {
  /** The store the drivers push/pop against. */
  readonly store: ModeStack;
  /** Handles to the created drivers (for forwarding signals like SHLVL). */
  readonly drivers: InstalledDrivers;
  /** Unsubscribe every driver from the engine and dispose them. */
  readonly dispose: () => void;
}

function enabled(
  flags: InstallModeStackOptions['flags'],
  key: ModeStackDriverFlag,
): boolean {
  if (!flags) return true;
  const v = flags[key];
  if (v === undefined) return true;
  return v;
}

/**
 * Wire the ModeStack drivers into `engine.onRawByte`. Returns a handle with
 * each driver, the store, and a `dispose()` that cleanly unsubscribes and
 * disposes every driver (pops any owned layers).
 *
 * Idempotent per-call: each invocation creates its own driver instances and
 * registers its own observers. Calling `installModeStack` twice against the
 * same engine installs two independent sets of drivers (they'll push
 * duplicate layers — not typically what you want, but also not broken).
 */
export function installModeStack(
  opts: InstallModeStackOptions,
): ModeStackInstallHandle {
  const { engine, flags } = opts;
  const store = useModeStackStore.getState();
  // Drivers consume `ModeStackHandle`, the narrow push/pop/popUntil/topmost
  // surface. The full store exposes those methods so it trivially conforms.
  const stack: ModeStackHandle = store;

  const altScreen = enabled(flags, 'altScreen')
    ? createAltScreenDriver({ stack })
    : null;
  const multiplexer = enabled(flags, 'multiplexer')
    ? createMultiplexerDriver({ stack })
    : null;
  const pager = enabled(flags, 'pager') ? createPagerDriver({ stack }) : null;
  const repl = enabled(flags, 'repl') ? createReplDriver({ stack }) : null;
  const nestedShell = enabled(flags, 'nestedShell')
    ? createNestedShellDriver({ stack })
    : null;

  // Collect active driver refs so the raw-byte pump doesn't have to re-check
  // the flags on every chunk.
  const active: readonly Driver[] = [
    altScreen,
    multiplexer,
    pager,
    repl,
    nestedShell,
  ].filter((d): d is Driver => d !== null);

  const unsubscribe = engine.onRawByte((chunk) => {
    for (const d of active) {
      try {
        d.feed(chunk);
      } catch {
        // A driver bug must not take down the whole feed loop. We swallow
        // per-driver; the ModeStack store is self-consistent because each
        // driver owns its own ids.
      }
    }
  });

  return {
    store,
    drivers: {
      altScreen,
      multiplexer,
      pager,
      repl,
      nestedShell,
    },
    dispose: () => {
      unsubscribe();
      for (const d of active) {
        try {
          d.dispose();
        } catch {
          // Teardown must be resilient — keep disposing the rest.
        }
      }
    },
  };
}
