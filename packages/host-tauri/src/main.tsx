/**
 * Tauri TS entry point. Resolves a concrete `HostBridge` via the factory
 * (auto-detection picks Tauri when the webview injects `__TAURI_INTERNALS__`,
 * mock otherwise) and hands it to `@quanta/ui` to boot the React tree.
 */

import { bootstrapUi } from '@quanta/ui';
import { createHostBridge } from './bridge-factory.js';

async function main() {
  const root = document.getElementById('quanta-root');
  if (!root) {
    throw new Error(
      'host-tauri.main: mount point #quanta-root is missing from index.html. ' +
        'The React tree cannot boot. Check packages/host-tauri/index.html.',
    );
  }
  let bridge;
  try {
    bridge = await createHostBridge();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `host-tauri.main: createHostBridge() rejected — bridge construction failed. Cause: ${cause}`,
      { cause: err },
    );
  }
  bootstrapUi({ root, bridge });
}

void main();
