/**
 * TUI alt-screen detector installer.
 *
 * Wires a byte-level detector into the command router's raw-chunk
 * side-channel. On `alt_screen_enter` it flips the tui store's `active`
 * flag (which the TerminalPage reads to swap layout); on `alt_screen_exit`
 * it flips it back.
 *
 * Chosen integration point: `features/command/addRouterRawObserver`. This
 * is Path 2 from the Phase-3 brief — a parallel detector that avoids
 * having to factor every existing `new AnsiParser()` site into a factory.
 * The parser's own `onMode` callback still works; it's just not the one
 * we wire for the page-level swap because BlockCard owns its parser
 * instance and we don't want the TUI feature to reach across into widgets.
 *
 * Nesting policy (Phase 3 minimum):
 *   - Enter while active → no-op at the store level (store's `enter()` is
 *     idempotent).
 *   - Exit while inactive → no-op.
 *   - Nested enters (alt-screen inside alt-screen) stay active through
 *     both exits — the store only flips on the first enter and the matched
 *     final exit. ADR 0008 marks this as "outermost enter/exit count";
 *     we implement that via a local nesting counter so a nested tmux→vim
 *     session doesn't prematurely drop back to BlockList on vim's `:q`.
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
  // Nesting depth tracks alt-screen enter/exit pairs. Only the outer
  // transition flips the store; inner pairs increment/decrement the
  // counter and leave `active` alone (ADR 0008 §Nested TUIs).
  let depth = 0;

  const detector = createAltScreenDetector((ev) => {
    if (ev.kind === 'alt_screen_enter') {
      if (depth === 0) {
        log.debug('tui: alt-screen enter — swapping to xterm surface');
        useTuiStore.getState().enter();
      }
      depth += 1;
      return;
    }
    // alt_screen_exit
    if (depth === 0) {
      // Stray exit (e.g. a TUI that emits `?1049l` without a prior enter).
      // Flip the store defensively so the page does not get stuck on a
      // hidden xterm, but avoid going negative on depth.
      log.debug('tui: alt-screen exit without matching enter — resetting');
      useTuiStore.getState().exit();
      return;
    }
    depth -= 1;
    if (depth === 0) {
      log.debug('tui: alt-screen exit — returning to BlockList');
      useTuiStore.getState().exit();
    }
  });

  const disposer = addRouterRawObserver((chunk) => {
    detector.feed(chunk);
  });

  return {
    unsubscribe: () => {
      disposer();
      detector.reset();
      depth = 0;
      // Clear any active TUI flag so a re-install starts fresh.
      useTuiStore.getState().exit();
    },
  };
}
