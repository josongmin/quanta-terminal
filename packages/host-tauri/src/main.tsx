/**
 * Tauri TS entry point. Creates the host bridge, then hands it to
 * `@quanta/ui` to boot the React tree.
 */

import { bootstrapUi } from '@quanta/ui';
import { createTauriHostBridge } from './bridge.js';

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
    bridge = await createTauriHostBridge();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `host-tauri.main: createTauriHostBridge() rejected — Tauri IPC unavailable. Cause: ${cause}`,
      { cause: err },
    );
  }
  bootstrapUi({ root, bridge });
}

void main();
