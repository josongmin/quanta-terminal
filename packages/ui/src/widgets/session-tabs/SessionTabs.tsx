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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';

import { useSessionTabs, useSessionsStore, type SessionTabView } from '../../entities/session/index.js';
import { exportSessionTranscript } from '../../features/session/export-transcript.js';
import type { SessionId } from '../../shared/types/generated/index.js';
import { cx } from '../../shared/lib/cx.js';
import { showToast } from '../../shared/ui/toast/index.js';
import { t } from '../../shared/i18n/index.js';
import styles from './session-tabs.module.css';

/** DataTransfer MIME we use for tab reorder payloads. */
const DND_TAB_MIME = 'application/x-quanta-session-tab';

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
      <div className={styles.row} role="tablist" aria-label={t('sessionTabs.rowLabel')}>
        <button
          type="button"
          role="tab"
          aria-selected="true"
          aria-label={t('sessionTabs.noActive')}
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
    <div className={styles.row} role="tablist" aria-label={t('sessionTabs.rowLabel')}>
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
  const menuRef = useRef<HTMLSpanElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropSide, setDropSide] = useState<'none' | 'left' | 'right'>('none');
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (ev: globalThis.MouseEvent) => {
      const el = menuRef.current;
      if (el && ev.target instanceof Node && el.contains(ev.target)) return;
      setMenuOpen(false);
    };
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

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

  const handleMenuToggle = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      e.preventDefault();
      setMenuOpen((v) => !v);
    },
    [],
  );

  const handleExportTranscript = useCallback(
    async (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      e.preventDefault();
      setMenuOpen(false);
      const result = exportSessionTranscript(tab.id);
      if (!result.ok) {
        showToast({
          kind: 'warning',
          message: t('sessionTabs.transcriptExportFailed', { reason: result.reason ?? 'unknown' }),
        });
        return;
      }
      const clipboard =
        typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null;
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        showToast({
          kind: 'warning',
          message: t('sessionTabs.transcriptExportFailed', { reason: 'no-clipboard' }),
        });
        return;
      }
      try {
        await clipboard.writeText(result.text);
        showToast({ kind: 'info', message: t('sessionTabs.transcriptExported') });
      } catch {
        showToast({
          kind: 'warning',
          message: t('sessionTabs.transcriptExportFailed', { reason: 'write-failed' }),
        });
      }
    },
    [tab.id],
  );

  // Drag & drop — HTML5 native. We serialize the session id on dragstart and
  // on drop we read it back and dispatch `reorderSessions` against the store.
  // The `dropSide` state tracks the visual insertion indicator.
  const handleDragStart = useCallback(
    (e: DragEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.setData(DND_TAB_MIME, tab.id);
        e.dataTransfer.setData('text/plain', tab.id);
        e.dataTransfer.effectAllowed = 'move';
      }
    },
    [tab.id],
  );
  const handleDragOver = useCallback((e: DragEvent<HTMLButtonElement>) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    // Only accept drops of our own tab payload. This guard prevents random
    // text being dropped onto the tab row from triggering a reorder.
    const hasOur =
      Array.from(dt.types).includes(DND_TAB_MIME) || Array.from(dt.types).includes('text/plain');
    if (!hasOur) return;
    e.preventDefault();
    dt.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    setDropSide(e.clientX < midpoint ? 'left' : 'right');
  }, []);
  const handleDragLeave = useCallback(() => {
    setDropSide('none');
  }, []);
  const handleDrop = useCallback(
    (e: DragEvent<HTMLButtonElement>) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const payload = dt.getData(DND_TAB_MIME) || dt.getData('text/plain');
      setDropSide('none');
      if (!payload || payload === tab.id) return;
      e.preventDefault();
      const coll = useSessionsStore.getState();
      const fromIdx = coll.order.indexOf(payload as SessionId);
      let toIdx = coll.order.indexOf(tab.id);
      if (fromIdx < 0 || toIdx < 0) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      const insertAfter = e.clientX >= midpoint;
      if (insertAfter && toIdx < fromIdx) toIdx += 1;
      else if (!insertAfter && toIdx > fromIdx) toIdx -= 1;
      coll.reorderSessions(fromIdx, toIdx);
    },
    [tab.id],
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
        dropSide === 'left' && styles.dropLeft,
        dropSide === 'right' && styles.dropRight,
      )}
      data-testid={`session-tab-${tab.id}`}
      data-drop-side={dropSide}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      draggable
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
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
      <span className={styles.menuWrap} ref={menuRef}>
        <button
          type="button"
          tabIndex={0}
          aria-label={t('sessionTabs.menuLabel')}
          title={t('sessionTabs.menuTooltip')}
          aria-haspopup="menu"
          aria-expanded={menuOpen ? 'true' : 'false'}
          className={styles.kebab}
          data-testid={`session-tab-menu-${tab.id}`}
          onClick={handleMenuToggle}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {'\u22EE'}
        </button>
        {menuOpen && (
          <div
            role="menu"
            aria-label={t('sessionTabs.menuLabel')}
            className={styles.menu}
            data-testid={`session-tab-menu-popup-${tab.id}`}
          >
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={handleExportTranscript}
              data-testid={`session-tab-export-${tab.id}`}
            >
              {t('sessionTabs.exportTranscript')}
            </button>
          </div>
        )}
      </span>
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
          aria-label={t('sessionTabs.close', { label })}
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
      aria-label={t('sessionTabs.newTab')}
      title={t('sessionTabs.newTabTitle')}
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
  return tab.isActive
    ? t('sessionTabs.ariaActive', { base })
    : t('sessionTabs.ariaInactive', { base });
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
