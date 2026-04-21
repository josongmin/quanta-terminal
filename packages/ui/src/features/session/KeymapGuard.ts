/**
 * KeymapGuard — registry of UI-level keyboard shortcuts that bypass the
 * encoder layer and are handled by the application chrome (command palette,
 * tab management, split-pane, settings, zoom).
 *
 * Epic β (Plan 0005 §4.β) separates the keystrokes that "belong to the
 * shell" (arrow keys, control codes, letters, mouse, IME, paste) from the
 * keystrokes that "belong to the UI" (Cmd+K, Cmd+T, Cmd+,, ...). The
 * always-on `SessionInputSurface` is always mounted while a session is
 * active; it captures EVERY event by default and routes it through the
 * `input-host` encoders. Before encoding, the surface consults
 * `defaultKeymapGuard(ev)` — when the guard returns `true`, the event is
 * claimed by the UI (e.g. the global `useKeymap('mod+k', ...)` listener)
 * and MUST NOT be forwarded to the PTY.
 *
 * Design notes
 * ------------
 * - `mod` is Cmd on macOS, Ctrl elsewhere (per `isMac()` in
 *   `shared/lib/keymap.ts`). We do NOT claim raw Ctrl-on-non-mac outside
 *   this `mod` resolution: Ctrl+C / Ctrl+D / Ctrl+Z must still reach the
 *   shell across every platform.
 * - Cmd/Ctrl+V is deliberately absent. The Paste encoder hooks the native
 *   `paste` event (via `onPasteGate`); letting the browser's clipboard
 *   pipeline run means paste-safety and bracketed-paste encoding both keep
 *   working. Claiming Cmd+V here would double-fire and drop the clipboard
 *   payload.
 * - Ctrl+C/D/R/L/A/E/Z and friends are ABSENT — those are shell keystrokes
 *   the session must see. The UI-only mod+letter set is intentionally
 *   narrow: palette, tab, close-tab, split, focus-cycle, zoom, settings.
 * - The guard is a pure function: no side effects, no listener install.
 *   The actual handlers are registered through `useKeymap(...)` by the
 *   page component. The guard only exists so the SessionInputSurface knows
 *   which events to PASS through (let the global keymap listener pick up)
 *   versus which to FORWARD to the encoder.
 */

import { isMac } from '../../shared/lib/keymap.js';

/** Modifier requirement for a pattern. */
export type KeyModifier = 'mod' | 'shift' | 'alt';

/**
 * A single UI-claimed pattern. `key` is the raw `KeyboardEvent.key`
 * (case-sensitive — use uppercase 'D' when a Shift+D pattern should match
 * the physical letter). `mods` is the list of required modifiers; any
 * modifier NOT in the list must be absent.
 */
export interface KeyPattern {
  readonly key: string;
  readonly mods: readonly KeyModifier[];
}

/**
 * P0 UI-level shortcuts. Every entry here is handled by
 * `packages/ui/src/pages/terminal-page/TerminalPage.tsx` via `useKeymap`.
 * Keep this list in sync with the keymap registrations there — the guard's
 * job is to tell the input surface "don't forward", not to execute.
 *
 * Explicitly absent (must route to the shell):
 *   - `v` with `mod`: the Paste encoder claims paste via the native event.
 *   - `c` / `d` / `r` / `l` / `a` / `e` / `z` with `ctrl` (no mod): shell
 *     control codes (SIGINT, EOF, reverse-i-search, clear, line-start,
 *     line-end, suspend). These are only dangerous to claim on non-mac
 *     where `mod` === `ctrl`; the patterns below use `mod` semantics,
 *     which on non-mac means `ctrl` is required, so `Ctrl+c` is NOT in
 *     this list (the `key` is 'c' lowercase, but there's no entry for it
 *     with `['mod']`).
 *   - Plain arrow keys, Tab, Escape, Enter, Backspace — all are shell
 *     keystrokes.
 */
export const P0_UI_SHORTCUTS: readonly KeyPattern[] = [
  { key: 'k', mods: ['mod'] },
  { key: 't', mods: ['mod'] },
  { key: 'w', mods: ['mod'] },
  { key: 'd', mods: ['mod'] },
  { key: 'D', mods: ['mod', 'shift'] },
  { key: '\\', mods: ['mod'] },
  { key: '=', mods: ['mod'] },
  { key: '-', mods: ['mod'] },
  { key: '0', mods: ['mod'] },
  { key: ',', mods: ['mod'] },
];

/**
 * Match a live KeyboardEvent against a pattern. Exported for tests; the
 * default guard iterates the P0 list and calls this for each entry.
 */
export function matchesKeyPattern(ev: KeyboardEvent, pattern: KeyPattern): boolean {
  // Key match is case-sensitive — 'D' must be distinct from 'd' so
  // Cmd+Shift+D (DOM reports key='D') doesn't also fire for Cmd+D.
  if (ev.key !== pattern.key) return false;

  const wantMod = pattern.mods.includes('mod');
  const wantShift = pattern.mods.includes('shift');
  const wantAlt = pattern.mods.includes('alt');

  // Resolve `mod`: Cmd on macOS, Ctrl elsewhere. When we require `mod`,
  // the opposite modifier must be ABSENT so a user holding Cmd+Ctrl+K
  // doesn't trigger the palette on Linux.
  if (wantMod) {
    if (isMac()) {
      if (!ev.metaKey || ev.ctrlKey) return false;
    } else {
      if (!ev.ctrlKey || ev.metaKey) return false;
    }
  } else {
    // Pattern does NOT require `mod` — both metaKey and ctrlKey must be
    // absent. (No P0 pattern uses this branch, but it's the correct
    // semantics when callers register non-mod shortcuts via a custom
    // `keymapGuard` prop.)
    if (ev.metaKey || ev.ctrlKey) return false;
  }

  // Shift and Alt must match exactly.
  if (wantShift !== ev.shiftKey) return false;
  if (wantAlt !== ev.altKey) return false;

  return true;
}

/**
 * Default guard: consults `P0_UI_SHORTCUTS`. Returns `true` when the event
 * matches any UI pattern (the input surface will then NOT encode it; the
 * global `useKeymap` listener picks it up). Returns `false` otherwise so
 * the encoder sees the event.
 */
export function defaultKeymapGuard(ev: KeyboardEvent): boolean {
  for (const pattern of P0_UI_SHORTCUTS) {
    if (matchesKeyPattern(ev, pattern)) return true;
  }
  return false;
}
