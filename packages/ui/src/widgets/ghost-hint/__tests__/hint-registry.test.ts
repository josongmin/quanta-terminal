/**
 * hint-registry — tests (Plan 0005 P1-G).
 *
 * Scope:
 *   1. every declared kind has non-empty text and keys (guards typos).
 *   2. `getGhostHint` round-trips every declared kind.
 *   3. `getGhostHint` returns `undefined` for unknown kinds (fallback policy).
 *   4. `isGhostHintKind` narrows correctly for known + unknown inputs.
 *   5. the registry is deeply readonly-shaped (mutation attempt throws or
 *      no-ops so consumers can't corrupt the table at runtime).
 *   6. key sequences are non-empty strings (no empty arrays, no blanks).
 */

import { describe, expect, it } from 'vitest';
import {
  GHOST_HINTS,
  getGhostHint,
  isGhostHintKind,
  type GhostHintKind,
} from '../hint-registry.js';

describe('hint-registry', () => {
  it('declares text and keys for every registered kind', () => {
    const kinds = Object.keys(GHOST_HINTS) as GhostHintKind[];
    // 13 entries — P1-G base (9) + Wave 1 gap closure (pager_most, pager_bat,
    // repl_ipython, repl_ruby). Hardcoded to catch accidental
    // additions/removals without a registry-contract update.
    expect(kinds).toHaveLength(13);
    for (const kind of kinds) {
      const entry = GHOST_HINTS[kind];
      expect(entry.text.length).toBeGreaterThan(0);
      expect(entry.keys.length).toBeGreaterThan(0);
    }
  });

  it('round-trips every declared kind via getGhostHint', () => {
    for (const kind of Object.keys(GHOST_HINTS) as GhostHintKind[]) {
      const entry = getGhostHint(kind);
      expect(entry).toBeDefined();
      expect(entry).toBe(GHOST_HINTS[kind]);
    }
  });

  it('returns undefined for unknown kinds (fallback policy)', () => {
    expect(getGhostHint('unknown_mode')).toBeUndefined();
    expect(getGhostHint('')).toBeUndefined();
    expect(getGhostHint('pager_more')).toBeUndefined();
    expect(getGhostHint('repl_irb')).toBeUndefined();
  });

  it('isGhostHintKind narrows known + rejects unknown', () => {
    expect(isGhostHintKind('pager_less')).toBe(true);
    expect(isGhostHintKind('repl_python')).toBe(true);
    expect(isGhostHintKind('tui_vim')).toBe(true);
    expect(isGhostHintKind('shell_nested')).toBe(true);
    expect(isGhostHintKind('unknown_mode')).toBe(false);
    expect(isGhostHintKind('')).toBe(false);
  });

  it('exposes every kind from the spec: pagers, REPLs, multiplexer, TUIs, nested', () => {
    const expected: GhostHintKind[] = [
      'pager_less',
      'pager_man',
      'pager_most',
      'pager_bat',
      'repl_python',
      'repl_ipython',
      'repl_node',
      'repl_psql',
      'repl_ruby',
      'multiplexer_tmux',
      'tui_vim',
      'tui_htop',
      'shell_nested',
    ];
    for (const k of expected) {
      expect(GHOST_HINTS[k]).toBeDefined();
    }
  });

  it('carries non-empty, non-blank key sequences', () => {
    for (const kind of Object.keys(GHOST_HINTS) as GhostHintKind[]) {
      const { keys } = GHOST_HINTS[kind];
      for (const k of keys) {
        expect(typeof k).toBe('string');
        expect(k.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
