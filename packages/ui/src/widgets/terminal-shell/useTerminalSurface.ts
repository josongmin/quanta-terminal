/**
 * useTerminalSurface — widget-internal hook that encapsulates the xterm.js
 * lifecycle. Per ADR 0014 and the FSD structure, xterm-specific attach logic
 * lives inside the `terminal-shell` widget slice, not in shared.
 *
 * Phase 3 note: xterm only mounts when the page detects an alt-screen
 * application (see `alt-screen-stream.ts` + `TerminalPage.tsx`). This hook
 * therefore does NOT own the PTY subscription — the page does, via
 * `features/session/connectSession`. The hook instead receives:
 *
 *   - a live `ConnectedSession` (for `write` on keystrokes and `resize` on
 *     layout changes);
 *   - a byte stream via `attachXtermListener`, which flushes any bytes
 *     buffered since the alt-screen enter before switching to live feed.
 *
 * Responsibilities (in order):
 *   1. Construct a `Terminal` with the Quanta theme/font.
 *   2. Load addons (fit, web-links, webgl when viable).
 *   3. Open the terminal into the provided container.
 *   4. Subscribe to the alt-screen byte stream; every chunk → `term.write`.
 *   5. Forward user input (`term.onData`) to the session `write`.
 *   6. Observe container resize and forward to the session `resize` —
 *      debounced + coalesced.
 *   7. Teardown: every subscription/observer/addon must be disposed here in
 *      the correct order (webgl addon → data handler → byte subscription →
 *      resize observer → debouncer → write batcher → terminal).
 */

import { useEffect } from 'react';
import type { RefObject } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { createDebouncer } from '../../shared/lib/debounce.js';
import { createLogger } from '../../shared/lib/logger.js';
import { mark, measure } from '../../shared/lib/perf.js';
import { createWriteBatcher } from '../../shared/lib/write-batcher.js';
import { TERMINAL_FONT, buildXtermTheme } from '../../shared/config/theme.js';
import type { ConnectedSession } from '../../features/session/index.js';

import { attachXtermListener } from './alt-screen-stream.js';

const log = createLogger('term.surface');

/** Minimum interval between fit/resize invocations — ADR brief: ~60ms. */
const RESIZE_DEBOUNCE_MS = 60;
/** Hard cap so a continuous drag still emits at least one resize per ~250ms. */
const RESIZE_MAX_WAIT_MS = 250;

export interface UseTerminalSurfaceOptions {
  /** Container element; the hook no-ops until `current` is set. */
  readonly containerRef: RefObject<HTMLElement>;
  /** Currently connected session handle. When null, xterm renders inert —
   *  user input is swallowed and no resize RPC is sent. The page is expected
   *  to remount the widget once the session is established. */
  readonly session: ConnectedSession | null;
  readonly autoFocus?: boolean;
}

export function useTerminalSurface(options: UseTerminalSurfaceOptions): void {
  const { containerRef, session, autoFocus = true } = options;

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const term = createTerminal();
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());

    term.open(host);

    // WebGL is loaded after `open` because the addon needs a DOM context.
    const webgl = tryLoadWebgl(term);

    fit.fit();
    if (autoFocus) term.focus();

    // Write pipeline: coalesce bursts of alt-screen bytes into one term.write
    // per animation frame. xterm.write accepts Uint8Array natively so we hand
    // it the raw bytes — no string round-trip.
    const writeBatcher = createWriteBatcher({
      write: (data) => {
        term.write(data);
      },
    });

    // Subscribe to the alt-screen byte stream. `attachXtermListener`
    // flushes any bytes retained since the alt-screen enter BEFORE it
    // returns, so xterm's very first write includes the enter sequence and
    // puts the terminal in alt-screen mode — without that xterm would render
    // the TUI on the main screen.
    const detachBytes = attachXtermListener((chunk) => {
      writeBatcher.enqueue(chunk);
    });

    let cancelled = false;
    const userInput = session
      ? term.onData((data) => {
          void session.write(data);
        })
      : undefined;

    let lastCols = term.cols;
    let lastRows = term.rows;

    // Resize pipeline: a ResizeObserver fires up to 60x/sec during a window
    // drag. We debounce both the fit() and the outgoing bridge.resize() RPC,
    // AND we coalesce: if fit() produces the same cols/rows as last time, we
    // skip the RPC entirely. Without this the host sees hundreds of resizes
    // during a single drag.
    //
    // Resize failures get one silent retry with exponential backoff (100ms,
    // 300ms). After two failures we stop — the host PTY is likely gone and
    // a future successful resize will reset the counter. A crash during
    // resize must NEVER propagate because it runs on a ResizeObserver tick
    // and there's no React boundary above us there.
    let resizeRetryCount = 0;
    const scheduleResizeRetry = (cols: number, rows: number): void => {
      if (cancelled) return;
      if (resizeRetryCount >= 2) {
        log.warn('term.surface: session.resize failed twice; giving up until next change');
        return;
      }
      const delay = resizeRetryCount === 0 ? 100 : 300;
      resizeRetryCount += 1;
      setTimeout(() => {
        if (cancelled || !session) return;
        void doResize(cols, rows);
      }, delay);
    };
    const doResize = async (cols: number, rows: number): Promise<void> => {
      if (!session) return;
      try {
        await session.resize(cols, rows);
        resizeRetryCount = 0;
      } catch (err) {
        log.warn('term.surface: session.resize rejected; will retry with backoff', err);
        scheduleResizeRetry(cols, rows);
      }
    };

    const resizeDebouncer = createDebouncer(
      () => {
        if (cancelled) return;
        mark('term.resize-start');
        try {
          fit.fit();
        } catch {
          // fit can throw if the host is detached; safe to ignore.
        }
        const { cols, rows } = term;
        if (session && (cols !== lastCols || rows !== lastRows)) {
          lastCols = cols;
          lastRows = rows;
          void doResize(cols, rows);
        }
        mark('term.resize-end');
        measure('term.resize', 'term.resize-start', 'term.resize-end');
      },
      { wait: RESIZE_DEBOUNCE_MS, maxWait: RESIZE_MAX_WAIT_MS },
    );

    const resizeObserver = new ResizeObserver(() => {
      resizeDebouncer.schedule();
    });
    resizeObserver.observe(host);

    // Emit an initial resize now that xterm has measured: the page only
    // mounts us in alt-screen mode, and the TUI needs to know the grid
    // right away so its first redraw uses the correct cols/rows.
    if (session) {
      const { cols, rows } = term;
      lastCols = cols;
      lastRows = rows;
      void doResize(cols, rows);
    }

    return () => {
      cancelled = true;
      // Order: stop new observations first, then flush pending debounced
      // calls, then tear down the write pipeline before disposing the
      // terminal. The WebGL addon must be disposed BEFORE the terminal per
      // its known lifecycle.
      resizeObserver.disconnect();
      resizeDebouncer.cancel();
      if (userInput) userInput.dispose();
      detachBytes();
      writeBatcher.dispose();
      if (webgl) {
        try {
          webgl.dispose();
        } catch {
          // already disposed on context loss; ignore.
        }
      }
      term.dispose();
    };
  }, [containerRef, session, autoFocus]);
}

function createTerminal(): Terminal {
  return new Terminal({
    theme: buildXtermTheme(),
    fontFamily: TERMINAL_FONT.family,
    fontSize: TERMINAL_FONT.size,
    lineHeight: TERMINAL_FONT.lineHeight,
    letterSpacing: TERMINAL_FONT.letterSpacing,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 2,
    allowProposedApi: true,
    scrollback: 10_000,
    convertEol: false,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 4,
    smoothScrollDuration: 80,
    macOptionIsMeta: true,
    rightClickSelectsWord: true,
  });
}

function tryLoadWebgl(term: Terminal): WebglAddon | undefined {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      // On context loss, dispose the addon; xterm automatically falls back to
      // the canvas renderer. Do NOT re-create here — a repeated create/dispose
      // cycle leaks GPU resources (known xterm webgl addon issue).
      try {
        webgl.dispose();
      } catch {
        /* already disposed */
      }
    });
    term.loadAddon(webgl);
    return webgl;
  } catch {
    // Non-fatal; fall back to canvas renderer.
    return undefined;
  }
}
