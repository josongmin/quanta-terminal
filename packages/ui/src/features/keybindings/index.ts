/**
 * Public surface for the `keybindings` feature — customizable keyboard
 * shortcuts for app-level actions.
 */

export {
  KEYBINDING_REGISTRY,
  findKeybinding,
} from './registry.js';
export type { KeybindingDefinition, KeybindingScope } from './registry.js';
export {
  useKeybindingsStore,
  resolveShortcut,
  getEffectiveShortcuts,
  __resetKeybindingsForTests,
  KEYBINDINGS_STORAGE_KEY,
} from './store.js';
export type { KeybindingOverrides, KeybindingsStore } from './store.js';
export { captureNextShortcut, canonicalizeKeyEvent } from './record.js';
export type { CaptureOptions, CaptureResult } from './record.js';
export {
  detectConflicts,
  conflictsFor,
  canonicalizeShortcut,
} from './conflicts.js';
export type { ConflictMap, DetectConflictsOptions } from './conflicts.js';
export { KeybindingsSection } from './KeybindingsSection.js';
export { KeybindingRow } from './KeybindingRow.js';
