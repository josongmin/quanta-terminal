/**
 * Tauri TS entry point. Creates the host bridge, then hands it to
 * `@quanta/ui` to boot the React tree.
 */

import { bootstrapUi } from '@quanta/ui';
import { createTauriHostBridge } from './bridge.js';

async function main() {
  const root = document.getElementById('quanta-root');
  if (!root) {
    throw new Error('Quanta mount point #quanta-root not found.');
  }
  const bridge = await createTauriHostBridge();
  bootstrapUi({ root, bridge });
}

void main();
