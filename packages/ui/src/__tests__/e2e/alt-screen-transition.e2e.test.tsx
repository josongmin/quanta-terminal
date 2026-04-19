/**
 * **Final E2E — alt-screen UI pipeline, byte-driven**
 *
 * Every layer on the real production path:
 *
 *     raw PTY bytes → `features/command` raw-chunk observer →
 *     `installTuiDetector()`'s detector consumes the chunk →
 *     detector emits `alt_screen_enter` / `alt_screen_exit` →
 *     `useTuiStore.enter()` / `exit()` fires →
 *     `useAltScreenMode()` re-renders →
 *     the mounted chrome component reflects the new state.
 *
 * The only test seam is `__emitRawChunkForTests(bytes)` on
 * `features/command/route-output`, which walks the same internal
 * `rawChunkObservers` set that `appendToActiveBlock` fires from. That
 * lets us feed bytes without standing up the session + block-store +
 * router pipeline, while keeping every UI-layer module (detector, store,
 * selector hook) exactly as production runs it.
 *
 * Retires RFC §22 #8 (alt-screen enter race) and EPIC-H §4.2 (nested
 * depth) at the UI observation point.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useAltScreenMode, useTuiStore } from '../../entities/tui/index.js';
import {
  __emitRawChunkForTests,
  __resetRawObserversForTests,
} from '../../features/command/route-output.js';
import {
  installTuiDetector,
  type TuiInstallHandle,
} from '../../features/tui/install.js';

// Byte sequences as they appear in real TUI programs (vim, less, htop,
// tmux, ...). We spell them out with numeric ESC so any drift in encoding
// breaks the test loudly.
const ESC = 0x1b;
const ENTER_1049 = new Uint8Array([ESC, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]); // ESC[?1049h
const EXIT_1049 = new Uint8Array([ESC, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x6c]); // ESC[?1049l
const ENTER_1047 = new Uint8Array([ESC, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x37, 0x68]); // ESC[?1047h
const ENTER_47 = new Uint8Array([ESC, 0x5b, 0x3f, 0x34, 0x37, 0x68]); // ESC[?47h
const CURSOR_SHOW = new Uint8Array([ESC, 0x5b, 0x3f, 0x32, 0x35, 0x68]); // ESC[?25h

/**
 * Chrome probe that reads alt-screen state through the production
 * `useAltScreenMode()` selector — the same hook `TerminalPage` uses.
 */
function ChromeProbe(): JSX.Element {
  const alt = useAltScreenMode();
  return (
    <div data-testid="chrome" data-hidden={alt.active ? 'true' : 'false'}>
      <button data-testid="chrome-button" aria-hidden={alt.active}>
        actions
      </button>
      {alt.active ? (
        <div data-testid="status-bar" data-depth={String(alt.depth)}>
          alt
        </div>
      ) : null}
    </div>
  );
}

let tui: TuiInstallHandle;

beforeEach(() => {
  __resetRawObserversForTests();
  useTuiStore.getState().reset();
  tui = installTuiDetector();
});

afterEach(() => {
  // Unmount mounted trees BEFORE touching the store — `tui.unsubscribe()`
  // calls `useTuiStore.reset()`, which triggers a re-render. If the tree
  // is still mounted, that re-render fires outside React's `act` scope
  // and trips the "state update not wrapped in act" warning.
  cleanup();
  tui.unsubscribe();
  __resetRawObserversForTests();
  useTuiStore.getState().reset();
});

describe('alt-screen transition (e2e, byte-driven)', () => {
  it('ESC[?1049h flips chrome to collapsed via the detector → store → selector chain', () => {
    render(<ChromeProbe />);
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('false');
    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('true');
    expect(screen.getByTestId('status-bar').dataset['depth']).toBe('1');
  });

  it('ESC[?1049l after enter re-expands chrome and removes the status bar', () => {
    render(<ChromeProbe />);
    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('true');
    act(() => {
      __emitRawChunkForTests(EXIT_1049);
    });
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('false');
    expect(screen.queryByTestId('status-bar')).toBeNull();
    expect(useTuiStore.getState().depth).toBe(0);
  });

  it('two consecutive ESC[?1049h chunks increment depth (detector does not dedup)', () => {
    render(<ChromeProbe />);
    act(() => {
      __emitRawChunkForTests(ENTER_1049);
      __emitRawChunkForTests(ENTER_1049);
    });
    expect(screen.getByTestId('status-bar').dataset['depth']).toBe('2');
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('true');
  });

  it('a single exit from depth 2 leaves chrome collapsed; depth drops to 1', () => {
    render(<ChromeProbe />);
    act(() => {
      __emitRawChunkForTests(ENTER_1049);
      __emitRawChunkForTests(ENTER_1049);
    });
    expect(screen.getByTestId('status-bar').dataset['depth']).toBe('2');
    act(() => {
      __emitRawChunkForTests(EXIT_1049);
    });
    expect(screen.getByTestId('status-bar').dataset['depth']).toBe('1');
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('true');
  });

  it('legacy ESC[?1047h and ESC[?47h also enter alt-screen (DEC private-mode compat)', () => {
    render(<ChromeProbe />);
    act(() => {
      __emitRawChunkForTests(ENTER_1047);
    });
    expect(screen.getByTestId('status-bar').dataset['depth']).toBe('1');
    act(() => {
      __emitRawChunkForTests(ENTER_47);
    });
    expect(screen.getByTestId('status-bar').dataset['depth']).toBe('2');
  });

  it('an unrelated DEC private mode (ESC[?25h) does not disturb chrome', () => {
    render(<ChromeProbe />);
    act(() => {
      __emitRawChunkForTests(CURSOR_SHOW);
    });
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('false');
    expect(screen.queryByTestId('status-bar')).toBeNull();
    expect(useTuiStore.getState().depth).toBe(0);
  });

  it('an escape sequence split mid-parameter across two chunks still fires exactly once', () => {
    render(<ChromeProbe />);
    const first = new Uint8Array([ESC, 0x5b, 0x3f, 0x31, 0x30, 0x34]); // ESC[?104
    const second = new Uint8Array([0x39, 0x68]); // 9h
    act(() => {
      __emitRawChunkForTests(first);
    });
    // Parameter still incomplete — no transition yet.
    expect(useTuiStore.getState().depth).toBe(0);
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('false');
    act(() => {
      __emitRawChunkForTests(second);
    });
    expect(useTuiStore.getState().depth).toBe(1);
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('true');
  });

  it('a compound CSI with multiple private params (ESC[?1049;25h) fires a single enter', () => {
    render(<ChromeProbe />);
    // ESC[?1049;25h — enter alt-screen AND show cursor in one CSI.
    const combined = new Uint8Array([
      ESC, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x3b, 0x32, 0x35, 0x68,
    ]);
    act(() => {
      __emitRawChunkForTests(combined);
    });
    expect(useTuiStore.getState().depth).toBe(1);
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('true');
  });

  it('unsubscribe detaches the detector; later ESC[?1049h is a no-op and the store is reset', () => {
    render(<ChromeProbe />);
    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('true');
    act(() => {
      tui.unsubscribe();
    });
    // unsubscribe() resets the store — chrome is back.
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('false');
    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });
    // Detector is gone; store stays at zero.
    expect(useTuiStore.getState().depth).toBe(0);
    // Re-install so the afterEach teardown is idempotent-safe.
    tui = installTuiDetector();
  });
});
