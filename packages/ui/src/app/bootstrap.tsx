/**
 * bootstrap — mounts the React tree into a provided host element.
 *
 * Hosts call `bootstrapUi({ root, bridge })` after installing their
 * `HostBridge` implementation. The UI package never calls `createRoot`
 * itself in the module scope so hosts keep control of the React root.
 */

import { createRoot } from 'react-dom/client';
import type { HostBridge } from '@quanta/host-common';
import type { ErrorInfo } from 'react';

import { setHostBridge } from '../shared/api/host-bridge.js';
import { AppProviders } from './providers/index.js';
import { TerminalPage } from '../pages/terminal-page/index.js';
import { ErrorBoundary } from '../shared/ui/error-boundary/index.js';
import { createLogger } from '../shared/lib/logger.js';

// Styles: tokens first, then font faces, then application resets.
import '../shared/config/tokens.css';
import '../shared/config/fonts.css';
import '../shared/config/app.css';

const log = createLogger('bootstrap');

export interface BootstrapOptions {
  readonly root: HTMLElement;
  readonly bridge: HostBridge;
  /**
   * Optional error reporter. Invoked when a render-time error is caught by
   * the top-level boundary AND the user clicks "Report" in the fallback.
   * Hosts wire this to their crash-reporting transport.
   */
  readonly onReport?: (error: Error, info: ErrorInfo) => void;
}

export function bootstrapUi(options: BootstrapOptions): { unmount: () => void } {
  setHostBridge(options.bridge);
  const root = createRoot(options.root);
  const handleError = (error: Error, info: ErrorInfo): void => {
    log.error('ui.bootstrap: render-time crash reached the root boundary', {
      message: error.message,
      componentStack: info.componentStack,
    });
  };
  root.render(
    <AppProviders>
      <ErrorBoundary
        subject="terminal"
        onError={handleError}
        {...(options.onReport ? { onReport: options.onReport } : {})}
      >
        <TerminalPage />
      </ErrorBoundary>
    </AppProviders>,
  );
  return {
    unmount: () => root.unmount(),
  };
}
