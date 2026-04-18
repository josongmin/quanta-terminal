/**
 * TerminalShell — xterm.js surface wired to an already-connected session.
 *
 * SRP: this component owns *only* the container element and the hook
 * invocation. All xterm.js lifecycle (construct/open/dispose, addons, fit,
 * resize-observe, byte subscription) lives in `useTerminalSurface`.
 *
 * Ownership: the page creates the session via `connectSession` and passes
 * the handle here. TerminalShell does NOT manage PTY lifecycle — it is a
 * surface subscriber that mounts only while alt-screen is active.
 *
 * Imperative handle: the TUI feature needs to focus the xterm textarea
 * synchronously once it swaps in. We expose `focus()` / `blur()` through a
 * forwarded ref so the caller does not have to reach into internals.
 */

import { forwardRef, useImperativeHandle, useRef } from 'react';

import { useTerminalSurface } from './useTerminalSurface.js';
import type { ConnectedSession } from '../../features/session/index.js';
import styles from './terminal-shell.module.css';

export interface TerminalShellProps {
  readonly autoFocus?: boolean;
  /** Connected session handle from the page. Null disables write/resize — the
   *  surface still renders but user input is swallowed. */
  readonly session: ConnectedSession | null;
}

/**
 * Imperative handle surfaced to callers via `ref`. Keep it minimal —
 * only add methods the TUI feature actually needs.
 */
export interface TerminalShellHandle {
  /** Move browser focus into the xterm textarea. Safe to call before
   *  xterm has finished mounting (becomes a no-op). */
  focus(): void;
  /** Release focus from the xterm textarea. */
  blur(): void;
}

export const TerminalShell = forwardRef<TerminalShellHandle, TerminalShellProps>(
  function TerminalShell(props, ref) {
    // Default to NOT auto-focusing the xterm textarea: the Composer is the
    // primary input surface and its textarea has the browser's native IME
    // handling (essential for Korean / Japanese / Chinese). xterm's own IME
    // path has documented issues with CJK composition; routing input through
    // the composer avoids them entirely. A TUI that needs raw terminal focus
    // still gets it when the user clicks the surface OR when the TUI feature
    // calls `focus()` on our forwarded handle.
    const { autoFocus = false, session } = props;
    const containerRef = useRef<HTMLDivElement | null>(null);

    useTerminalSurface({
      containerRef,
      session,
      autoFocus,
    });

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          const host = containerRef.current;
          if (!host) return;
          // xterm writes a `textarea.xterm-helper-textarea` child under the
          // surface container for keyboard input. Focusing it is equivalent
          // to calling `term.focus()` but avoids routing through the hook.
          const ta = host.querySelector<HTMLTextAreaElement>(
            'textarea.xterm-helper-textarea',
          );
          if (ta) {
            ta.focus();
            return;
          }
          // Fallback: focus the container itself. xterm may not have
          // finished opening yet (or the selector may not match under the
          // test stub). Focusing the container is a safe no-op in jsdom.
          if (typeof host.focus === 'function') host.focus();
        },
        blur: () => {
          const host = containerRef.current;
          if (!host) return;
          const ta = host.querySelector<HTMLTextAreaElement>(
            'textarea.xterm-helper-textarea',
          );
          if (ta) {
            ta.blur();
            return;
          }
          if (typeof host.blur === 'function') host.blur();
        },
      }),
      [],
    );

    return (
      <div className={styles.wrap}>
        <div
          ref={containerRef}
          className={styles.surface}
          data-testid="terminal-surface"
        />
      </div>
    );
  },
);

TerminalShell.displayName = 'TerminalShell';
