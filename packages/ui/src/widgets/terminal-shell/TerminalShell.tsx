/**
 * TerminalShell — xterm.js surface wired to the HostBridge.
 *
 * SRP: this component owns *only* the container element and the hook
 * invocation. All xterm.js lifecycle (construct/open/dispose, addons, fit,
 * resize-observe, host subscription) lives in `useTerminalSurface`.
 *
 * DIP: the bridge is injected. A caller may pass `bridge` as a prop for tests
 * or embeds; otherwise the widget falls back to the single accessor in
 * `shared/api/host-bridge.ts`, which is the only place in the UI that reads
 * `window.__QUANTA_HOST__`.
 */

import { useRef } from 'react';
import type { HostBridge } from '@quanta/host-common';

import { getHostBridge } from '../../shared/api/host-bridge.js';
import { useTerminalSurface } from './useTerminalSurface.js';
import styles from './terminal-shell.module.css';

export interface TerminalShellProps {
  readonly autoFocus?: boolean;
  /**
   * Optional bridge injection. Tests and embeds pass this directly; in
   * production the widget resolves the bridge via the shared accessor.
   */
  readonly bridge?: HostBridge;
}

export function TerminalShell(props: TerminalShellProps) {
  const { autoFocus = true, bridge } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);

  const resolvedBridge = bridge ?? getHostBridge();

  useTerminalSurface({
    containerRef,
    bridge: resolvedBridge,
    autoFocus,
  });

  return (
    <div className={styles.wrap}>
      <div ref={containerRef} className={styles.surface} data-testid="terminal-surface" />
    </div>
  );
}

TerminalShell.displayName = 'TerminalShell';
