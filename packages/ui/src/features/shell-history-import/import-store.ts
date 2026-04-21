/**
 * Imported-history store.
 *
 * A small Zustand store that remembers the commands we scraped out of the
 * user's existing shell history on first launch. Persisted to localStorage
 * under its own key so the bulk of the entries doesn't collide with other
 * preference stores and can be cleared independently.
 *
 * Shape (all frozen / readonly from the consumer side):
 *   - entries:    chronological (oldest first) list of command strings
 *   - source:     which dotfile the entries came from (or null on reset)
 *   - importedAt: wall-clock ms of the last successful ingest (or null)
 *   - ranOnce:    set to true the first time auto-import runs, whether or
 *                 not it found any file. Used by {@link runAutoImport} to
 *                 avoid re-scanning on every boot.
 *
 * The store is intentionally NOT subscribed to by hot-path hooks —
 * rendering components should read the entries once per mount via the
 * `useImportedEntries` selector exposed here. The autosuggest merge path
 * (`features/shell-history-import/query.ts`) pulls `entries` by reference
 * and memoises downstream so keystrokes do not re-fan through the store.
 *
 * Scope discipline: no parsing, no I/O. The store is a pure state holder;
 * the parsers live in `./parse.ts` and the auto-import orchestration in
 * `./auto-import.ts`.
 */

import { create } from 'zustand';
import type { ShellHistorySource } from './parse.js';

/** localStorage key. Namespaced like the other Quanta preference stores. */
export const IMPORT_STORAGE_KEY = 'quanta.shell-history-import';

/**
 * On-disk schema version. Bumping this invalidates existing persisted
 * payloads, which is fine — a re-import is cheap and the user never sees
 * the import storm (auto-import on next boot will re-seed).
 */
const SCHEMA_VERSION = 1;

/** Reasonable ceiling on total stored entries across the lifetime of the
 *  app. The largest single file we accept is 5 000 per the parser cap; we
 *  double that so two re-imports (e.g. zsh then bash) don't blow the
 *  budget. localStorage on all major browsers gives each origin ≥ 5 MiB,
 *  so ~10 000 × 80 bytes = ~800 KiB is well within the envelope. */
const MAX_TOTAL_ENTRIES = 10_000;

export interface ImportedHistoryState {
  readonly entries: readonly string[];
  readonly source: ShellHistorySource | null;
  readonly importedAt: number | null;
  readonly ranOnce: boolean;
}

export interface ImportedHistoryStore extends ImportedHistoryState {
  /** Replace the current entry list with a fresh ingest. Sets `ranOnce`
   *  and `importedAt`. */
  readonly ingest: (input: {
    readonly entries: readonly string[];
    readonly source: ShellHistorySource;
    readonly now?: number;
  }) => void;
  /** Remove the imported corpus entirely. Retains `ranOnce = true` so
   *  the Settings "Clear imported" button does not trigger a re-import
   *  on the next mount — a user who cleared probably meant it. */
  readonly clear: () => void;
  /** Mark `ranOnce = true` without ingesting anything (used by the
   *  auto-import flow when no history file was readable). */
  readonly markRan: () => void;
}

interface PersistedPayload {
  readonly v: number;
  readonly entries: readonly string[];
  readonly source: ShellHistorySource | null;
  readonly importedAt: number | null;
  readonly ranOnce: boolean;
}

function emptyState(): ImportedHistoryState {
  return {
    entries: Object.freeze<string[]>([]),
    source: null,
    importedAt: null,
    ranOnce: false,
  };
}

/**
 * Read the persisted payload from localStorage. Returns the empty state
 * when storage is unavailable, the payload is missing, or the payload
 * fails validation.
 *
 * Exposed (not just internal) so tests can exercise the round-trip path
 * without reaching through the live storage globals.
 */
export function readStoredImportedHistory(
  getItem?: (key: string) => string | null,
): ImportedHistoryState {
  const get =
    getItem ??
    (typeof localStorage !== 'undefined'
      ? (k: string): string | null => localStorage.getItem(k)
      : null);
  if (!get) return emptyState();
  let raw: string | null;
  try {
    raw = get(IMPORT_STORAGE_KEY);
  } catch {
    return emptyState();
  }
  if (raw === null) return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedPayload> | null;
    if (!parsed || typeof parsed !== 'object') return emptyState();
    if (parsed.v !== SCHEMA_VERSION) return emptyState();
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter((e): e is string => typeof e === 'string')
      : [];
    const source: ShellHistorySource | null =
      parsed.source === 'zsh' ||
      parsed.source === 'bash' ||
      parsed.source === 'fish'
        ? parsed.source
        : null;
    const importedAt =
      typeof parsed.importedAt === 'number' && Number.isFinite(parsed.importedAt)
        ? parsed.importedAt
        : null;
    const ranOnce = parsed.ranOnce === true;
    return {
      entries: Object.freeze(entries),
      source,
      importedAt,
      ranOnce,
    };
  } catch {
    return emptyState();
  }
}

function writeStored(next: ImportedHistoryState): void {
  if (typeof localStorage === 'undefined') return;
  const payload: PersistedPayload = {
    v: SCHEMA_VERSION,
    entries: next.entries,
    source: next.source,
    importedAt: next.importedAt,
    ranOnce: next.ranOnce,
  };
  try {
    localStorage.setItem(IMPORT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage full / private mode. The in-memory store still works;
    // the user will just lose the import on reload. Better than
    // crashing the settings panel.
  }
}

export const useImportedHistoryStore = create<ImportedHistoryStore>(
  (set, get) => {
    const initial = readStoredImportedHistory();
    return {
      ...initial,
      ingest: ({ entries, source, now }) => {
        // Defensively clone + cap. The parser already capped per file,
        // but we re-apply the total cap here in case callers ever
        // combine multiple files.
        const clipped =
          entries.length <= MAX_TOTAL_ENTRIES
            ? entries.slice()
            : entries.slice(entries.length - MAX_TOTAL_ENTRIES);
        const next: ImportedHistoryState = {
          entries: Object.freeze(clipped),
          source,
          importedAt: now ?? Date.now(),
          ranOnce: true,
        };
        writeStored(next);
        set(next);
      },
      clear: () => {
        const prev = get();
        const next: ImportedHistoryState = {
          entries: Object.freeze<string[]>([]),
          source: null,
          importedAt: null,
          // Preserve the ranOnce flag so a user who explicitly clears
          // is not re-prompted with an auto-import on next boot.
          ranOnce: prev.ranOnce,
        };
        writeStored(next);
        set(next);
      },
      markRan: () => {
        if (get().ranOnce) return;
        const next: ImportedHistoryState = {
          ...get(),
          ranOnce: true,
        };
        writeStored(next);
        set({ ranOnce: true });
      },
    };
  },
);

/** Selector: stable reference to the entry list. Use with `useImportedHistoryStore(useImportedEntries)`
 *  if you only need the array — saves a re-render when unrelated fields change. */
export function useImportedEntries(state: ImportedHistoryState): readonly string[] {
  return state.entries;
}

/** Test-only reset hook — restores the empty state without touching
 *  localStorage. Tests that want to reset both the in-memory state and
 *  storage should also call `localStorage.removeItem(IMPORT_STORAGE_KEY)`. */
export function _resetImportedHistoryForTests(): void {
  useImportedHistoryStore.setState(emptyState());
}
