/**
 * Alt-screen byte-stream tests.
 *
 * The module is the only thing that decides whether xterm gets mounted at
 * all, so these tests pin the contract tightly:
 *
 *   - enter sequences (CSI ?1049h / ?1047h / ?47h) flip needsAltScreen=true
 *   - corresponding `l` sequences flip needsAltScreen=false
 *   - random bytes never flip (no false positives)
 *   - sequences straddling chunk boundaries are still detected via the
 *     tail buffer
 *   - the xterm byte pipeline retains bytes since the enter sequence until
 *     a subscriber attaches, then flushes them synchronously
 *   - ordinary block output bytes (no alt-screen sequence) do not trigger
 *     a flip, even when they contain CSI-like fragments
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAltScreenStreamForTests,
  attachXtermListener,
  feedAltScreenStreamBytes,
  getNeedsAltScreen,
  subscribeNeedsAltScreen,
} from '../alt-screen-stream.js';

function bytes(...args: number[]): Uint8Array {
  return new Uint8Array(args);
}

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('alt-screen-stream: detection', () => {
  beforeEach(() => {
    __resetAltScreenStreamForTests();
  });

  it('starts with needsAltScreen=false', () => {
    expect(getNeedsAltScreen()).toBe(false);
  });

  it('flips to true on ESC[?1049h', () => {
    const states: boolean[] = [];
    const dispose = subscribeNeedsAltScreen((v) => states.push(v));
    feedAltScreenStreamBytes(ascii('\u001b[?1049h'));
    expect(getNeedsAltScreen()).toBe(true);
    expect(states).toEqual([true]);
    dispose();
  });

  it('flips to true on ESC[?1047h', () => {
    feedAltScreenStreamBytes(ascii('\u001b[?1047h'));
    expect(getNeedsAltScreen()).toBe(true);
  });

  it('flips to true on ESC[?47h', () => {
    feedAltScreenStreamBytes(ascii('\u001b[?47h'));
    expect(getNeedsAltScreen()).toBe(true);
  });

  it('flips back to false on ESC[?1049l after enter', () => {
    feedAltScreenStreamBytes(ascii('\u001b[?1049h'));
    expect(getNeedsAltScreen()).toBe(true);
    feedAltScreenStreamBytes(ascii('\u001b[?1049l'));
    expect(getNeedsAltScreen()).toBe(false);
  });

  it('random bytes with no sequence stay false', () => {
    feedAltScreenStreamBytes(ascii('hello world\n$ ls\n'));
    feedAltScreenStreamBytes(bytes(0x00, 0x7f, 0xaa, 0x55));
    // A CSI-like byte that is NOT the alt-screen pattern: cursor show
    // (`\u001b[?25h`) must not trigger — 25 is not 47/1047/1049.
    feedAltScreenStreamBytes(ascii('\u001b[?25h'));
    // SGR reset.
    feedAltScreenStreamBytes(ascii('\u001b[0m'));
    // Move cursor absolute.
    feedAltScreenStreamBytes(ascii('\u001b[10;20H'));
    expect(getNeedsAltScreen()).toBe(false);
  });

  it('does NOT fire on arbitrary block output bytes', () => {
    // Representative block output: prompt + ls listing + ansi colors.
    feedAltScreenStreamBytes(ascii('\u001b[36m$\u001b[0m '));
    feedAltScreenStreamBytes(ascii('ls -la\r\n'));
    feedAltScreenStreamBytes(
      ascii(
        'total 24\r\n' +
          'drwxr-xr-x  3 user  staff   96 Apr 19 10:00 .\r\n' +
          'drwxr-xr-x  8 user  staff  256 Apr 19 10:00 ..\r\n' +
          '-rw-r--r--  1 user  staff   42 Apr 19 10:00 README.md\r\n',
      ),
    );
    feedAltScreenStreamBytes(ascii('\u001b[36m$\u001b[0m '));
    expect(getNeedsAltScreen()).toBe(false);
  });

  it('detects a sequence split across two chunks via the tail buffer', () => {
    // Split at index 4: first chunk "ESC [ ? 1", second chunk "0 4 9 h".
    feedAltScreenStreamBytes(bytes(0x1b, 0x5b, 0x3f, 0x31));
    expect(getNeedsAltScreen()).toBe(false);
    feedAltScreenStreamBytes(bytes(0x30, 0x34, 0x39, 0x68));
    expect(getNeedsAltScreen()).toBe(true);
  });

  it('detects a sequence split at every internal position (fuzz)', () => {
    const seq = ascii('\u001b[?1049h');
    for (let split = 1; split < seq.length; split += 1) {
      __resetAltScreenStreamForTests();
      feedAltScreenStreamBytes(seq.slice(0, split));
      feedAltScreenStreamBytes(seq.slice(split));
      expect(getNeedsAltScreen()).toBe(true);
    }
  });

  it('handles noisy context around the enter sequence', () => {
    feedAltScreenStreamBytes(
      ascii('some prefix text\u001b[?1049hand more output after'),
    );
    expect(getNeedsAltScreen()).toBe(true);
  });

  it('idempotent: a second enter without exit keeps value true but notifies only once', () => {
    const listener = vi.fn();
    const dispose = subscribeNeedsAltScreen(listener);
    feedAltScreenStreamBytes(ascii('\u001b[?1049h'));
    feedAltScreenStreamBytes(ascii('some output'));
    feedAltScreenStreamBytes(ascii('\u001b[?1049h')); // Stray re-enter
    expect(getNeedsAltScreen()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('exit without prior enter is a no-op', () => {
    const listener = vi.fn();
    const dispose = subscribeNeedsAltScreen(listener);
    feedAltScreenStreamBytes(ascii('\u001b[?1049l'));
    expect(getNeedsAltScreen()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    dispose();
  });
});

describe('alt-screen-stream: xterm byte pipe', () => {
  beforeEach(() => {
    __resetAltScreenStreamForTests();
  });

  it('retains bytes from alt-screen enter onward, flushes on attach', () => {
    const received: Uint8Array[] = [];
    feedAltScreenStreamBytes(ascii('pre-alt noise')); // dropped, alt-screen off
    feedAltScreenStreamBytes(ascii('\u001b[?1049hvim redraw 1'));
    feedAltScreenStreamBytes(ascii('vim redraw 2'));
    // Attach AFTER alt-screen is on and bytes have piled up.
    const detach = attachXtermListener((chunk) => received.push(chunk));
    // Subsequent chunks go live.
    feedAltScreenStreamBytes(ascii('vim redraw 3'));
    detach();
    const joined = received.map((c) => new TextDecoder().decode(c)).join('');
    expect(joined).toContain('\u001b[?1049h');
    expect(joined).toContain('vim redraw 1');
    expect(joined).toContain('vim redraw 2');
    expect(joined).toContain('vim redraw 3');
    expect(joined).not.toContain('pre-alt noise');
  });

  it('drops retained bytes when alt-screen exits before attach', () => {
    const received: Uint8Array[] = [];
    feedAltScreenStreamBytes(ascii('\u001b[?1049h'));
    feedAltScreenStreamBytes(ascii('flash of tui'));
    feedAltScreenStreamBytes(ascii('\u001b[?1049l')); // exit before xterm mounts
    const detach = attachXtermListener((chunk) => received.push(chunk));
    expect(received).toHaveLength(0);
    detach();
  });

  it('live bytes reach the listener while attached', () => {
    const received: Uint8Array[] = [];
    feedAltScreenStreamBytes(ascii('\u001b[?1049h'));
    const detach = attachXtermListener((chunk) => received.push(chunk));
    feedAltScreenStreamBytes(ascii('hello'));
    feedAltScreenStreamBytes(ascii(' world'));
    const joined = received.map((c) => new TextDecoder().decode(c)).join('');
    expect(joined).toContain('hello world');
    detach();
  });

  it('after detach, further bytes are retained for the next attach', () => {
    feedAltScreenStreamBytes(ascii('\u001b[?1049h'));
    const detach1 = attachXtermListener(() => undefined);
    feedAltScreenStreamBytes(ascii('chunk-while-attached'));
    detach1();
    feedAltScreenStreamBytes(ascii('chunk-after-detach'));
    const received: Uint8Array[] = [];
    const detach2 = attachXtermListener((c) => received.push(c));
    const joined = received.map((c) => new TextDecoder().decode(c)).join('');
    expect(joined).toContain('chunk-after-detach');
    detach2();
  });
});
