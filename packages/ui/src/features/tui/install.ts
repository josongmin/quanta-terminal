/**
 * TUI alt-screen detector installer.
 *
 * Wires a byte-level detector into the command router's raw-chunk
 * side-channel. On `alt_screen_enter` it calls `useTuiStore.getState().enter()`;
 * on `alt_screen_exit` it calls `exit()`. The store internally manages the
 * depth counter (ADR 0008 "outermost enter/exit count" + EPIC-H §4.2 nested
 * depth API), so this installer is purely a shim from "raw bytes" to
 * "store actions".
 *
 * Chosen integration point: `features/command/addRouterRawObserver`. This is
 * Path 2 from the Phase-3 brief — a parallel detector that avoids having to
 * factor every existing `new AnsiParser()` site into a factory. The parser's
 * own `onMode` callback still works; it's just not the one we wire for the
 * page-level swap because BlockCard owns its parser instance and we don't
 * want the TUI feature to reach across into widgets.
 *
 * EPIC-H notes:
 *   - Depth is now tracked inside the store (see `entities/tui/model.ts`).
 *   - This installer forwards raw enter/exit events; the store handles the
 *     outer-only transition + nested label-update semantics.
 *   - `ModeChanged(AltScreen, payload)` from the EPIC-C mirror will
 *     replace this byte-level path once all call sites consume the
 *     mirror's mode-event stream directly; until then the two paths
 *     must produce identical store transitions. xterm is gone (EPIC-I);
 *     the byte-level detector stays because it is a cheap side-channel
 *     the existing detectors already rely on.
 */

// Cross-slice: the TUI feature observes the command router's raw byte
// stream to detect alt-screen transitions. `route-output` is the only
// UI-layer surface that sees every PTY chunk in order. Moving the observer
// API to shared/ would pull bridge semantics down a layer; keeping it in
// features/command with a cross-slice hop is the smaller compromise.
// FIXME(fsd-layer-skip): tui detector taps the command router's raw observer channel
import { addRouterRawObserver } from '../command/index.js';
import { useTuiStore } from '../../entities/tui/index.js';
import { createLogger } from '../../shared/lib/logger.js';
import { createAltScreenDetector } from './detect.js';

const log = createLogger('tui.install');

export interface TuiInstallHandle {
  readonly unsubscribe: () => void;
}

/**
 * Start the detector. Returns an unsubscribe that detaches from the router
 * and resets the store to `inactive`. Safe to call more than once — each
 * call gets its own detector and observer registration.
 */
export function installTuiDetector(): TuiInstallHandle {
  const detector = createAltScreenDetector((ev) => {
    if (ev.kind === 'alt_screen_enter') {
      log.debug('tui: alt-screen enter');
      useTuiStore.getState().enter();
      return;
    }
    log.debug('tui: alt-screen exit');
    useTuiStore.getState().exit();
  });

  const disposer = addRouterRawObserver((chunk) => {
    detector.feed(chunk);
  });

  return {
    unsubscribe: () => {
      disposer();
      detector.reset();
      // Reset completely so re-install starts fresh.
      useTuiStore.getState().reset();
    },
  };
}
