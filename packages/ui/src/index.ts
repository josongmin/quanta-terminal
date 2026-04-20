/**
 * Public entry for `@quanta/ui`. Hosts depend on `bootstrapUi` and the
 * `HostBridge` re-exports; everything else is internal.
 */

export { bootstrapUi } from './app/bootstrap.js';
export type { BootstrapOptions } from './app/bootstrap.js';

export { setHostBridge, getHostBridge, tryGetHostBridge } from './shared/api/host-bridge.js';

// Composer text-insertion bus. Hosts use this to wire OS-level affordances
// (e.g. external file drag-and-drop on Tauri) into the composer input
// without reaching into widget internals.
export {
  dispatchComposerInsertText,
  shellQuotePath,
} from './features/composer/index.js';
export type { InsertMode, InsertTextOptions } from './features/composer/index.js';
