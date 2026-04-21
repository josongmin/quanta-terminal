import { describe, expect, it } from 'vitest';

import { canonicalizeShortcut, conflictsFor, detectConflicts } from '../conflicts.js';
import type { KeybindingDefinition } from '../registry.js';

const defs: ReadonlyArray<KeybindingDefinition> = [
  { id: 'a', labelKey: 'settings.sections.keybindings', defaultShortcut: 'mod+k', scope: 'global' },
  { id: 'b', labelKey: 'settings.sections.keybindings', defaultShortcut: 'mod+t', scope: 'global' },
  { id: 'c', labelKey: 'settings.sections.keybindings', defaultShortcut: 'mod+shift+f', scope: 'global' },
];

describe('canonicalizeShortcut', () => {
  it('sorts modifiers into canonical order', () => {
    expect(canonicalizeShortcut('shift+mod+a')).toBe('mod+shift+a');
    expect(canonicalizeShortcut('alt+shift+mod+k')).toBe('mod+alt+shift+k');
  });

  it('lowercases parts', () => {
    expect(canonicalizeShortcut('MOD+Shift+A')).toBe('mod+shift+a');
  });
});

describe('detectConflicts', () => {
  it('returns an empty map when the set is clean', () => {
    expect(detectConflicts({}, { defaults: defs }).size).toBe(0);
  });

  it('flags a conflict between an override and a default', () => {
    // Override `a` to collide with `b`'s default.
    const c = detectConflicts({ a: 'mod+t' }, { defaults: defs });
    expect(c.size).toBe(1);
    const ids = [...c.values()][0]!;
    expect(new Set(ids)).toEqual(new Set(['a', 'b']));
  });

  it('flags a conflict between two overrides', () => {
    const c = detectConflicts({ a: 'mod+shift+x', b: 'mod+shift+x' }, { defaults: defs });
    expect(c.size).toBe(1);
    const ids = [...c.values()][0]!;
    expect(new Set(ids)).toEqual(new Set(['a', 'b']));
  });

  it('ignores equivalent shortcuts with different modifier order', () => {
    // shift+mod+f === mod+shift+f after canonicalization → conflict with c.
    const c = detectConflicts({ a: 'shift+mod+f' }, { defaults: defs });
    expect(c.size).toBe(1);
    const ids = [...c.values()][0]!;
    expect(new Set(ids)).toEqual(new Set(['a', 'c']));
  });
});

describe('conflictsFor', () => {
  it('returns the other ids, excluding self', () => {
    const c = detectConflicts({ a: 'mod+t' }, { defaults: defs });
    expect(conflictsFor('a', c)).toEqual(['b']);
    expect(conflictsFor('b', c)).toEqual(['a']);
    expect(conflictsFor('c', c)).toEqual([]);
  });

  it('returns an empty array when there are no conflicts', () => {
    expect(conflictsFor('a', new Map())).toEqual([]);
  });
});
