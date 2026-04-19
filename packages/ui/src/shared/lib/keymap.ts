/**
 * Keymap — the one place any UI code listens for global keyboard shortcuts.
 *
 * Motivation: before this module, widgets would attach ad-hoc
 * `window.addEventListener('keydown', ...)` listeners and drift out of sync
 * (Cmd vs. Ctrl, whether to respect typing state, teardown order, etc.).
 * Concentrating the listener in one place gives us:
 *   - cross-platform modifier resolution (Meta on macOS, Ctrl elsewhere)
 *   - a single precedence order (a later handler can stop earlier ones)
 *   - deterministic teardown via subscriptions
 *   - a clear place to unit-test shortcut parsing
 *
 * The module exports a React hook (`useKeymap`) for ergonomic widget use and
 * a bare `subscribeKeymap` for tests or non-React callers.
 */

import { useEffect } from 'react';

/**
 * A shortcut is a string like "mod+k", "shift+enter", "escape".
 * `mod` resolves to Meta on macOS and Ctrl elsewhere. Unknown modifiers throw.
 */
export type Shortcut = string;

export interface KeyEventLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly target: EventTarget | null;
}

export interface KeymapHandler {
  readonly shortcut: Shortcut;
  readonly handler: (event: KeyboardEvent) => void;
  /**
   * When true, the handler fires even when focus is inside a form control
   * (textarea, input, contenteditable). Default false so typing `k` in a
   * textbox doesn't open the palette.
   */
  readonly allowInEditable?: boolean;
}

export interface KeymapSubscription {
  readonly unsubscribe: () => void;
}

interface ParsedShortcut {
  readonly key: string;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly mod: boolean;
}

/**
 * Parse a shortcut string into structured flags. Exported for tests.
 * Throws on unknown modifiers so typos fail fast.
 */
export function parseShortcut(shortcut: Shortcut): ParsedShortcut {
  const parts = shortcut
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error(`keymap: empty shortcut "${shortcut}"`);
  }
  const rawKey = parts[parts.length - 1];
  if (rawKey === undefined) {
    throw new Error(`keymap: empty key in shortcut "${shortcut}"`);
  }
  const mods = parts.slice(0, -1);
  let meta = false;
  let ctrl = false;
  let shift = false;
  let alt = false;
  let mod = false;
  for (const m of mods) {
    switch (m) {
      case 'mod':
        mod = true;
        break;
      case 'meta':
      case 'cmd':
      case 'super':
        meta = true;
        break;
      case 'ctrl':
      case 'control':
        ctrl = true;
        break;
      case 'shift':
        shift = true;
        break;
      case 'alt':
      case 'option':
      case 'opt':
        alt = true;
        break;
      default:
        throw new Error(`keymap: unknown modifier "${m}" in shortcut "${shortcut}"`);
    }
  }
  return { key: normalizeKey(rawKey), meta, ctrl, shift, alt, mod };
}

function normalizeKey(k: string): string {
  switch (k) {
    case 'escape':
      return 'escape';
    case 'esc':
      return 'escape';
    case 'enter':
    case 'return':
      return 'enter';
    case 'up':
      return 'arrowup';
    case 'down':
      return 'arrowdown';
    case 'left':
      return 'arrowleft';
    case 'right':
      return 'arrowright';
    case 'space':
      return ' ';
    case 'backtick':
    case 'grave':
      return '`';
    default:
      return k;
  }
}

/** True when running on macOS. Falls back to false outside browsers. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/u.test(navigator.platform);
}

/**
 * `formatShortcutHint` — renders a shortcut spec (as consumed by
 * `useKeymap`) into the user-visible label we show in menus / tooltips.
 *
 * Rules
 * -----
 *   - `mod` resolves to `⌘` on macOS, `Ctrl` elsewhere.
 *   - `shift` → `⇧` on macOS, `Shift` elsewhere.
 *   - `alt` → `⌥` on macOS, `Alt` elsewhere.
 *   - On macOS, parts are joined with no separator (Apple HIG). On other
 *     platforms they are joined with `+`.
 *   - Single letters are upper-cased; named keys pass through the same
 *     normalization `parseShortcut` uses (so `enter` renders as `↵` on Mac).
 *
 * Limitation — layout awareness
 * -----------------------------
 * This helper formats the SHORTCUT HINT but does NOT remap the key for
 * non-QWERTY layouts. The runtime matcher (`matchesShortcut`) matches on
 * `event.key` which is the physical key the OS reports, so the UI hint and
 * the actual trigger can drift on AZERTY / Dvorak layouts. A full fix would
 * need `navigator.keyboard.getLayoutMap()` (Chrome-only) or a per-key
 * remap table. For now we document the limitation; most tools take the
 * same shortcut.
 */
export function formatShortcutHint(spec: Shortcut): string {
  const parsed = parseShortcut(spec);
  const mac = isMac();
  const parts: string[] = [];
  if (parsed.mod || (parsed.ctrl && !mac)) {
    parts.push(mac ? '⌘' : 'Ctrl');
  } else if (parsed.ctrl) {
    parts.push(mac ? '⌃' : 'Ctrl');
  }
  if (parsed.meta && !parsed.mod) {
    parts.push(mac ? '⌘' : 'Win');
  }
  if (parsed.alt) parts.push(mac ? '⌥' : 'Alt');
  if (parsed.shift) parts.push(mac ? '⇧' : 'Shift');

  parts.push(prettyKey(parsed.key, mac));
  return mac ? parts.join('') : parts.join('+');
}

function prettyKey(key: string, mac: boolean): string {
  switch (key) {
    case 'escape':
      return 'Esc';
    case 'enter':
      return mac ? '↵' : 'Enter';
    case 'arrowup':
      return '↑';
    case 'arrowdown':
      return '↓';
    case 'arrowleft':
      return '←';
    case 'arrowright':
      return '→';
    case ' ':
      return 'Space';
    case ',':
      return ',';
    case '`':
      return '`';
    default:
      return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
  }
}

/**
 * Check whether a keyboard event matches a parsed shortcut. Exported for
 * tests; the runtime listener calls this inline.
 */
export function matchesShortcut(event: KeyEventLike, shortcut: ParsedShortcut): boolean {
  const eventKey = event.key.toLowerCase();
  if (eventKey !== shortcut.key) return false;

  // Resolve `mod`: Meta on macOS, Ctrl elsewhere.
  const modSatisfied = shortcut.mod
    ? isMac()
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey
    : true;
  if (!modSatisfied) return false;

  // Explicit modifier flags must match exactly (no extras, none missing).
  if (!shortcut.mod) {
    if (shortcut.meta !== event.metaKey) return false;
    if (shortcut.ctrl !== event.ctrlKey) return false;
  }
  if (shortcut.shift !== event.shiftKey) return false;
  if (shortcut.alt !== event.altKey) return false;

  return true;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return false;
}

// Ordered list so handlers can be removed cheaply and precedence is stable.
const handlers: Array<{ id: symbol; parsed: ParsedShortcut; entry: KeymapHandler }> = [];
let windowListener: ((e: KeyboardEvent) => void) | null = null;

function attachListener(): void {
  if (windowListener || typeof window === 'undefined') return;
  windowListener = (event: KeyboardEvent) => {
    // Snapshot so a handler unsubscribing mid-dispatch doesn't skip siblings.
    const snapshot = handlers.slice();
    for (const h of snapshot) {
      if (!matchesShortcut(event, h.parsed)) continue;
      if (!h.entry.allowInEditable && isEditableTarget(event.target)) continue;
      h.entry.handler(event);
      if (event.defaultPrevented) break;
    }
  };
  window.addEventListener('keydown', windowListener, { capture: false });
}

function detachIfEmpty(): void {
  if (handlers.length > 0) return;
  if (windowListener && typeof window !== 'undefined') {
    window.removeEventListener('keydown', windowListener);
  }
  windowListener = null;
}

/** Framework-agnostic subscription. Returns an unsubscribe handle. */
export function subscribeKeymap(entry: KeymapHandler): KeymapSubscription {
  const id = Symbol('keymap');
  const parsed = parseShortcut(entry.shortcut);
  handlers.push({ id, parsed, entry });
  attachListener();
  return {
    unsubscribe: () => {
      const i = handlers.findIndex((h) => h.id === id);
      if (i >= 0) handlers.splice(i, 1);
      detachIfEmpty();
    },
  };
}

/**
 * React hook. Registers a shortcut for the lifetime of the component. The
 * handler should be stable (wrap in `useCallback` if the closure is expensive)
 * — the hook re-subscribes whenever it changes, which is cheap but not free.
 */
export function useKeymap(
  shortcut: Shortcut,
  handler: (event: KeyboardEvent) => void,
  options?: { readonly allowInEditable?: boolean; readonly enabled?: boolean },
): void {
  const enabled = options?.enabled ?? true;
  const allowInEditable = options?.allowInEditable ?? false;
  useEffect(() => {
    if (!enabled) return;
    const sub = subscribeKeymap({ shortcut, handler, allowInEditable });
    return () => sub.unsubscribe();
  }, [shortcut, handler, enabled, allowInEditable]);
}

/** Test-only: clear all handlers. Not exported from index. */
export function __resetKeymapForTests(): void {
  handlers.length = 0;
  detachIfEmpty();
}
