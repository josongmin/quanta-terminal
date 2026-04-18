/**
 * bootstrap — mounts the React tree into a provided host element.
 *
 * Hosts call `bootstrapUi({ root, bridge })` after installing their
 * `HostBridge` implementation. The UI package never calls `createRoot`
 * itself in the module scope so hosts keep control of the React root.
 */

import { createRoot } from 'react-dom/client';
import type { HostBridge } from '@quanta/host-common';

import { setHostBridge } from '../shared/api/host-bridge.js';
import { AppProviders } from './providers/index.js';
import { TerminalPage } from '../pages/terminal-page/index.js';

// Styles: tokens first, then font faces, then application resets.
import '../shared/config/tokens.css';
import '../shared/config/fonts.css';
import '../shared/config/app.css';

export interface BootstrapOptions {
  readonly root: HTMLElement;
  readonly bridge: HostBridge;
}

export function bootstrapUi(options: BootstrapOptions): { unmount: () => void } {
  setHostBridge(options.bridge);
  const root = createRoot(options.root);
  root.render(
    <AppProviders>
      <TerminalPage />
    </AppProviders>,
  );
  return {
    unmount: () => root.unmount(),
  };
}
