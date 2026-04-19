/**
 * `features/navigation` — error-to-code navigation (Phase 3).
 *
 * Public surface:
 *   - `openInEditor(input)`: resolve a detected `path:line:col` click against
 *     the session cwd and dispatch to the host bridge.
 *   - `resolveAbsolutePath(path, cwd)`: pure helper reused by tests.
 *   - `isAbsolutePath(path)`: predicate reused by tests.
 */

export {
  openInEditor,
  openInEditorOrThrow,
  openInEditorMessageForReason,
  resolveAbsolutePath,
  isAbsolutePath,
  validatePathForNav,
} from './open-in-editor.js';
export type { OpenInEditorInput, OpenInEditorResult } from './open-in-editor.js';
