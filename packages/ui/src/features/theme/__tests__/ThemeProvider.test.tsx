import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../ThemeProvider.js';
import { setTheme, useThemeStore } from '../theme-store.js';
import { resolveTheme } from '../use-theme.js';

interface MediaQueryListish {
  matches: boolean;
  media: string;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  // legacy Safari
  addListener: (listener: () => void) => void;
  removeListener: (listener: () => void) => void;
  onchange: null;
  dispatchEvent: () => boolean;
}

function makeMatchMedia(initial: boolean): {
  mql: MediaQueryListish;
  fn: (q: string) => MediaQueryListish;
  trigger: (v: boolean) => void;
} {
  const listeners: Array<() => void> = [];
  const mql: MediaQueryListish = {
    matches: initial,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_t, l) => void listeners.push(l),
    removeEventListener: (_t, l) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
    addListener: (l) => void listeners.push(l),
    removeListener: (l) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
    onchange: null,
    dispatchEvent: () => true,
  };
  const fn = (_q: string): MediaQueryListish => mql;
  const trigger = (v: boolean): void => {
    mql.matches = v;
    for (const l of listeners.slice()) l();
  };
  return { mql, fn, trigger };
}

/** jsdom ships without localStorage in this project's setup — shim one. */
function installStorage(): void {
  const data = new Map<string, string>();
  const api: Storage = {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(k: string) {
      return data.has(k) ? data.get(k)! : null;
    },
    key(i: number) {
      return Array.from(data.keys())[i] ?? null;
    },
    removeItem(k: string) {
      data.delete(k);
    },
    setItem(k: string, v: string) {
      data.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: api,
  });
}

beforeEach(() => {
  installStorage();
  useThemeStore.getState()._rehydrate();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ThemeProvider', () => {
  it('applies data-theme="dark" when theme is dark', () => {
    setTheme('dark');
    const { fn } = makeMatchMedia(true);
    vi.stubGlobal('matchMedia', fn);
    // Stub matchMedia on window too — jsdom reads via window.matchMedia.
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: fn });
    render(
      <ThemeProvider>
        <div>child</div>
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('applies data-theme="light" when theme is light', () => {
    setTheme('light');
    const { fn } = makeMatchMedia(false);
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: fn });
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('resolves system to the OS preference', () => {
    setTheme('system');
    const { fn } = makeMatchMedia(true);
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: fn });
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('flips when system preference changes while on system mode', () => {
    setTheme('system');
    const media = makeMatchMedia(true);
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: media.fn });
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    act(() => media.trigger(false));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('ignores system changes when an explicit theme is chosen', () => {
    setTheme('light');
    const media = makeMatchMedia(false);
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: media.fn });
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    act(() => media.trigger(true));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('updates the attribute when the store is mutated while mounted', () => {
    setTheme('light');
    const { fn } = makeMatchMedia(false);
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: fn });
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    act(() => setTheme('dark'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('resolveTheme()', () => {
  it('prefers explicit light regardless of system', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
  });
  it('prefers explicit dark regardless of system', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
  it('falls back to the system preference for system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});
