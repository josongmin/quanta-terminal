/**
 * SessionTabs — multi-session tab row.
 *
 * Renders one chip per session, plus a `+` new-tab button. The active tab is
 * underlined in the accent color; inactive tabs render at reduced opacity.
 * Each tab carries:
 *   - the shell basename (readable at a glance);
 *   - a short cwd label (home dirs rendered as `~/...`);
 *   - a health pulse dot that mirrors the per-session `health` value;
 *   - a `×` close button that fades in on hover / focus.
 *
 * Keyboard:
 *   - Tabs are focusable (native `<button>`); Enter/Space activate via the
 *     default button click behavior, so we only need `onClick` here.
 *   - Delete / Backspace on a focused tab closes it — matches Chrome's tab
 *     affordance. We listen via `onKeyDown` on the tab element (scoped, not
 *     global) so it doesn't leak outside the tabstrip.
 *
 * Overflow:
 *   - Phase-4 minimum ships horizontal scroll. The row has `overflow-x: auto`
 *     and the tabs are non-shrinking; beyond the container width the user
 *     scrolls. A scroll-into-view on the active tab keeps the focused session
 *     on-screen after switching.
 *
 * Callers provide the action trio (`onCreate`, `onClose`, `onSelect`) so the
 * widget stays a pure presentation surface — test without wiring a real PTY
 * and easy to reuse in a palette or command-menu later.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

import { useSessionTabs, type SessionTabView } from '../../entities/session/index.js';
import type { SessionId } from '../../shared/types/generated/index.js';
import { cx } from '../../shared/lib/cx.js';
import styles from './session-tabs.module.css';

export interface SessionTabsProps {
  /** Handler for the `+` new-tab button. Cmd+T calls the same handler. */
  readonly onCreate?: () => void;
  /** Click handler for a tab. Does NOT fire for × clicks; those call onClose. */
  readonly onSelect?: (id: SessionId) => void;
  /**
   * Close handler — invoked by the `×` button and by Delete/Backspace on a
   * focused tab. Parent decides whether to confirm, terminate the PTY, etc.
   */
  readonly onClose?: (id: SessionId) => void;
}

export function SessionTabs(props: SessionTabsProps) {
  const tabs = useSessionTabs();
  const { onCreate, onSelect, onClose } = props;

  // Empty collection: render a single disabled chip so the chrome keeps its
  // shape while the first session is still spawning (`health: 'booting'`).
  // Keeps the visible layout stable with pre-Phase-4 behavior.
  if (tabs.length === 0) {
    return (
      <div className={styles.row} role="tablist" aria-label="Sessions">
        <button
          type="button"
          role="tab"
          aria-selected="true"
          aria-label="No active session"
          className={cx(styles.tab, styles.active)}
          disabled
        >
          <span className={cx(styles.pulse)} aria-hidden />
          <span className={styles.label}>session</span>
        </button>
        {onCreate && <NewTabButton onCreate={onCreate} />}
      </div>
    );
  }

  return (
    <div className={styles.row} role="tablist" aria-label="Sessions">
      {tabs.map((tab) => (
        <SessionTab
          key={tab.id}
          tab={tab}
          {...(onSelect ? { onSelect } : {})}
          {...(onClose ? { onClose } : {})}
        />
      ))}
      {onCreate && <NewTabButton onCreate={onCreate} />}
    </div>
  );
}

SessionTabs.displayName = 'SessionTabs';

interface SessionTabProps {
  readonly tab: SessionTabView;
  readonly onSelect?: (id: SessionId) => void;
  readonly onClose?: (id: SessionId) => void;
}

function SessionTab({ tab, onSelect, onClose }: SessionTabProps) {
  const btnRef = useRef<HTMLButtonElement | null>(null);

  // Keep the active tab on-screen when the tab row overflows. Scroll-into-view
  // only runs when `isActive` flips true — not on every render — so clicking
  // an already-visible tab doesn't jitter.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (tab.isActive && !wasActiveRef.current) {
      // jsdom lacks `scrollIntoView`; guard the call so unit tests don't
      // throw while still getting the effect in browsers.
      const el = btnRef.current;
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
    wasActiveRef.current = tab.isActive;
  }, [tab.isActive]);

  const handleSelect = useCallback(() => {
    onSelect?.(tab.id);
  }, [onSelect, tab.id]);

  const handleClose = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      // The × sits inside the tab button. Stop the click from bubbling into
      // the tab's own onClick, which would first activate the tab we're
      // about to close. No confirm — policy lives on the parent.
      e.stopPropagation();
      e.preventDefault();
      onClose?.(tab.id);
    },
    [onClose, tab.id],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onClose?.(tab.id);
      }
    },
    [onClose, tab.id],
  );

  const label = buildLabel(tab);
  const ariaLabel = buildAriaLabel(tab);

  return (
    <button
      type="button"
      role="tab"
      ref={btnRef}
      aria-selected={tab.isActive}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cx(
        styles.tab,
        tab.isActive && styles.active,
        !tab.isActive && styles.inactive,
      )}
      data-testid={`session-tab-${tab.id}`}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
    >
      <span
        className={cx(
          styles.pulse,
          tab.health === 'ready' && styles.pulseOn,
          tab.health === 'error' && styles.pulseError,
          tab.health === 'exited' && styles.pulseExited,
        )}
        aria-hidden
      />
      <span className={styles.label}>{label}</span>
      {onClose && (
        <span
          role="button"
          // The close affordance sits INSIDE the outer tab button because the
          // hover-fade animation is positioned relative to the tab chrome.
          // Nested interactive elements are technically invalid HTML, but this
          // pattern is widespread (Chrome tabs, Terminal.app tabs) and every
          // current browser dispatches click events to the inner target as
          // long as we stopPropagation on click AND mousedown — which we do.
          // For keyboard access we expose the close as tabbable (tabIndex=0)
          // and handle Enter/Space locally so screen-reader + keyboard users
          // can close a tab without relying on Delete/Backspace on the parent.
          tabIndex={0}
          aria-label={`Close ${label}`}
          data-testid={`session-tab-close-${tab.id}`}
          className={styles.close}
          onClick={handleClose}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onClose?.(tab.id);
            }
          }}
        >
          {'\u00D7'}
        </span>
      )}
    </button>
  );
}

interface NewTabButtonProps {
  readonly onCreate: () => void;
}

function NewTabButton({ onCreate }: NewTabButtonProps) {
  return (
    <button
      type="button"
      aria-label="New session"
      title="New session (\u2318T)"
      className={cx(styles.tab, styles.newTab)}
      data-testid="session-tab-new"
      onClick={onCreate}
    >
      <span className={styles.label}>{'+'}</span>
    </button>
  );
}

function buildLabel(tab: SessionTabView): string {
  const shell = basename(tab.shell) || tab.shell || 'session';
  const cwd = shortCwd(tab.cwd);
  if (shell && cwd) return `${shell}  ${cwd}`;
  return shell || cwd || 'session';
}

function buildAriaLabel(tab: SessionTabView): string {
  const base = buildLabel(tab);
  return tab.isActive ? `Active session ${base}` : `Session ${base}`;
}

function basename(p: string): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function shortCwd(cwd: string): string {
  if (!cwd) return '';
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/u.exec(cwd);
  if (m) return '~' + (m[2] ?? '');
  return cwd;
}
