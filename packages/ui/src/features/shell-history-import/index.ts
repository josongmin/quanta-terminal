/**
 * Public surface of the shell-history import feature.
 *
 * Callers (TerminalPage boot, Settings panel, autosuggest source hook)
 * should only import from here — the individual files are implementation
 * detail.
 */

export {
  parseZshHistory,
  parseBashHistory,
  parseFishHistory,
  MAX_ENTRIES_PER_FILE,
} from './parse.js';
export type { ShellHistorySource } from './parse.js';

export {
  useImportedHistoryStore,
  useImportedEntries,
  readStoredImportedHistory,
  IMPORT_STORAGE_KEY,
  _resetImportedHistoryForTests,
} from './import-store.js';
export type {
  ImportedHistoryState,
  ImportedHistoryStore,
} from './import-store.js';

export { runAutoImport, runImportForce } from './auto-import.js';
export type { RunImportArgs, RunImportResult } from './auto-import.js';

export {
  buildImportedHistoryEntries,
  useImportedHistoryEntries,
  mergeHistoryEntries,
  IMPORTED_ENTRY_BACKSTOP_AGE_MS,
} from './query.js';
