/**
 * useTerminalSurface — widget-internal hook that encapsulates the xterm.js
 * lifecycle. Per ADR 0014 and the FSD structure, xterm-specific attach logic
 * lives inside the `terminal-shell` widget slice, not in shared.
 *
 * Responsibilities (in order):
 *   1. Construct a `Terminal` with the Quanta theme/font.
 *   2. Load addons (fit, web-links, webgl when viable).
 *   3. Open the terminal into the provided container.
 *   4. Connect to the host session via the `connect-session` feature.
 *   5. Observe container resize and forward to the PTY — debounced.
 *   6. Batch `pty_data` writes per animation frame.
 *   7. Teardown: every subscription/observer/addon must be disposed here in
 *      the correct order (webgl addon → data handler → connection → resize
 *      observer → debouncer → write batcher → terminal).
 *
 * Only this hook imports `@xterm/*`. The `TerminalShell` widget becomes a
 * pure renderer whose only responsibility is the container element and
 * calling this hook with a ref.
 */

import { useEffect } from 'react';
import type { RefObject } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import type { HostBridge } from '@quanta/host-common';
import { base64ToBytes } from '../../shared/lib/base64.js';
import { createDebouncer } from '../../shared/lib/debounce.js';
import { createLogger } from '../../shared/lib/logger.js';
import { mark, measure } from '../../shared/lib/perf.js';
import { createWriteBatcher } from '../../shared/lib/write-batcher.js';
import { TERMINAL_FONT, buildXtermTheme } from '../../shared/config/theme.js';
import { connectSession } from '../../features/session/index.js';
import type { ConnectedSession } from '../../features/session/index.js';

const log = createLogger('term.surface');

/** Minimum interval between fit/resize invocations — ADR brief: ~60ms. */
const RESIZE_DEBOUNCE_MS = 60;
/** Hard cap so a continuous drag still emits at least one resize per ~250ms. */
const RESIZE_MAX_WAIT_MS = 250;

export interface UseTerminalSurfaceOptions {
  /** Container element; the hook no-ops until `current` is set. */
  readonly containerRef: RefObject<HTMLElement>;
  /** Host bridge. Injected — the hook itself never touches globals. */
  readonly bridge: HostBridge;
  readonly autoFocus?: boolean;
}

export function useTerminalSurface(options: UseTerminalSurfaceOptions): void {
  const { containerRef, bridge, autoFocus = true } = options;

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

    // Write pipeline: coalesce bursts of pty_data into one term.write per
    // animation frame. xterm.write accepts Uint8Array natively so we hand it
    // the raw decoded bytes — no string round-trip.
    const writeBatcher = createWriteBatcher({
      write: (data) => {
        term.write(data);
      },
    });

    const writeChunk = (bytesB64: string): void => {
      writeBatcher.enqueue(base64ToBytes(bytesB64));
    };

    let connected: ConnectedSession | undefined;
    let cancelled = false;
    let dataHandler: { dispose(): void } | undefined;
    let lastCols = term.cols;
    let lastRows = term.rows;

    // Resize pipeline: a ResizeObserver fires up to 60x/sec during a window
    // drag. We debounce both the fit() and the outgoing bridge.resize() RPC,
    // AND we coalesce: if fit() produces the same cols/rows as last time, we
    // skip the RPC entirely. Without this the host sees hundreds of resizes
    // during a single drag.
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
        if (connected && (cols !== lastCols || rows !== lastRows)) {
          lastCols = cols;
          lastRows = rows;
          void connected.resize(cols, rows);
        }
        mark('term.resize-end');
        measure('term.resize', 'term.resize-start', 'term.resize-end');
      },
      { wait: RESIZE_DEBOUNCE_MS, maxWait: RESIZE_MAX_WAIT_MS },
    );

    void (async () => {
      try {
        const conn = await connectSession({
          bridge,
          cols: term.cols,
          rows: term.rows,
          onData: writeChunk,
        });
        if (cancelled) {
          await conn.close();
          return;
        }
        connected = conn;
        lastCols = term.cols;
        lastRows = term.rows;
        dataHandler = term.onData((data) => {
          void conn.write(data);
        });
      } catch (err) {
        log.error('failed to attach to host bridge', err);
        term.writeln(
          '\u001b[31mquanta: failed to attach to host bridge:\u001b[0m ' +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    })();

    const resizeObserver = new ResizeObserver(() => {
      resizeDebouncer.schedule();
    });
    resizeObserver.observe(host);

    return () => {
      cancelled = true;
      // Order matters: stop new observations first, then flush pending
      // debounced calls (no-op if none), then tear down the write pipeline
      // before disposing the terminal. The WebGL addon must be disposed
      // BEFORE the terminal per its known lifecycle (see @xterm/addon-webgl
      // README: "dispose the addon before disposing the terminal").
      resizeObserver.disconnect();
      resizeDebouncer.cancel();
      if (dataHandler) dataHandler.dispose();
      if (connected) {
        void connected.close();
      }
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
  }, [containerRef, bridge, autoFocus]);
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
