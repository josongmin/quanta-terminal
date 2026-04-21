/**
 * Conflict detection — two keybindings collide when their EFFECTIVE shortcut
 * (override or default) is identical.
 *
 * Normalization: shortcuts are lowercased and the modifier order is
 * canonicalized (`mod+shift+k`, not `shift+mod+k`) before comparison so
 * semantically-equal user input is treated as equal.
 *
 * We intentionally do NOT treat cross-platform `cmd+k` vs `ctrl+k` as a
 * conflict: both resolve to the same physical combination on their
 * respective platforms but shipping a binding that only works on one
 * platform is a valid, supported pattern. If the user wants portable
 * shortcuts they should use `mod`.
 */

import { KEYBINDING_REGISTRY, type KeybindingDefinition } from './registry.js';
import type { KeybindingOverrides } from './store.js';

const MOD_ORDER: ReadonlyArray<string> = ['mod', 'meta', 'cmd', 'ctrl', 'control', 'alt', 'option', 'opt', 'shift'];

/**
 * Canonicalize a shortcut string to a stable form so `mod+shift+a` and
 * `shift+mod+a` compare equal. Exported for tests.
 */
export function canonicalizeShortcut(shortcut: string): string {
  const parts = shortcut
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return '';
  const key = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  const sorted = mods.slice().sort((a, b) => {
    const ai = MOD_ORDER.indexOf(a);
    const bi = MOD_ORDER.indexOf(b);
    // unknown modifiers sort after known ones, alphabetically
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return [...sorted, key].join('+');
}

/**
 * Map from canonical shortcut to the ids of every binding that resolves to
 * that shortcut. An entry is a "conflict" when the id list length is > 1.
 */
export type ConflictMap = Map<string, string[]>;

export interface DetectConflictsOptions {
  /** Override the registry (for tests). Defaults to `KEYBINDING_REGISTRY`. */
  readonly defaults?: ReadonlyArray<KeybindingDefinition>;
}

/**
 * Scan every binding's effective shortcut (override → default) and group by
 * canonical form. The returned map contains ONLY entries with > 1 id — i.e.
 * true conflicts. Keys are the canonical shortcut; values are ids.
 *
 * Runtime is O(n) over the registry; n is small (≈10–30) so we don't bother
 * caching. Callers can re-run on every override change.
 */
export function detectConflicts(
  overrides: KeybindingOverrides,
  options: DetectConflictsOptions = {},
): ConflictMap {
  const defs = options.defaults ?? KEYBINDING_REGISTRY;
  const buckets = new Map<string, string[]>();
  for (const def of defs) {
    const raw = overrides[def.id] ?? def.defaultShortcut;
    const key = canonicalizeShortcut(raw);
    if (!key) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(def.id);
    else buckets.set(key, [def.id]);
  }
  // Prune non-conflicts.
  const out: ConflictMap = new Map();
  for (const [shortcut, ids] of buckets) {
    if (ids.length > 1) out.set(shortcut, ids);
  }
  return out;
}

/**
 * For a given binding id, return the ids of any OTHER bindings it collides
 * with (empty array when there is no conflict). Convenience wrapper around
 * `detectConflicts` for per-row UI rendering.
 */
export function conflictsFor(
  id: string,
  conflicts: ConflictMap,
): string[] {
  for (const ids of conflicts.values()) {
    if (ids.includes(id)) return ids.filter((other) => other !== id);
  }
  return [];
}
