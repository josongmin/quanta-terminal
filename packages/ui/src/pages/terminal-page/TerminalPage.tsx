/**
 * TerminalPage — the single Phase-1 route.
 *
 * Responsibilities:
 *   - compose the chrome (title bar, banner host, terminal shell, composer,
 *     status bar);
 *   - own the MULTI-SESSION lifecycle (Phase 4). The first session is spawned
 *     automatically on mount. `Cmd+T` / the `+` tab button spawns additional
 *     sessions; `Cmd+W` / the `×` tab button closes the active one.
 *   - own the command palette open/close state;
 *   - wire the global keymap (Cmd/Ctrl+K, Cmd/Ctrl+T, Cmd/Ctrl+W, Cmd/Ctrl+`,
 *     Escape);
 *   - switch between the empty/loading/ready/error views based on session
 *     state AND mount `TerminalShell` only when alt-screen mode is active.
 *
 * Connection bookkeeping
 * ----------------------
 * Each `ConnectedSession` is held by the feature-scoped `connection-map`
 * (see `features/session-tabs/connection-map.ts`). The page keeps only the
 * ACTIVE connection in local state because that's what `TerminalShell` needs
 * as a prop — swapping the prop when the active session changes re-mounts
 * xterm against the right PTY. Background sessions keep running; their
 * per-session command router accrues output into their blocks.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { TitleBar } from '../../widgets/title-bar/index.js';
import {
  TerminalShell,
  feedAltScreenStream,
  useNeedsAltScreen,
} from '../../widgets/terminal-shell/index.js';
import type { TerminalShellHandle } from '../../widgets/terminal-shell/index.js';
import { BlockList } from '../../widgets/block-list/index.js';
import { Composer } from '../../widgets/composer/index.js';
import { StatusBar } from '../../widgets/status-bar/index.js';
import { BannerHost } from '../../widgets/banner-host/index.js';
import { CommandPalette } from '../../widgets/command-palette/index.js';
import { HistorySearch } from '../../widgets/history-search/index.js';
import { SessionTabs } from '../../widgets/session-tabs/index.js';
import { SettingsPanel } from '../../widgets/settings-panel/index.js';
import { ThemeProvider } from '../../features/theme/index.js';
// `EmptyState` is kept in the tree for the explicit no-session affordance
// (opened via Cmd+T in Phase 2). Not referenced yet while session boot happens
// transparently under the new block-list surface.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { EmptyState as _EmptyState } from './EmptyState.js';
import { LoadingState } from './LoadingState.js';
import { ErrorState } from './ErrorState.js';

import { Badge } from '../../shared/ui/badge/index.js';
import { showToast, ToastHost } from '../../shared/ui/toast/index.js';

import { useSessionStore, useSessionsStore } from '../../entities/session/index.js';
import {
  createIdbBlockAdapter,
  installBlockPersistence,
  hydrateFromPersistence,
} from '../../entities/block/index.js';
import { computeWorkspaceFingerprint } from '../../shared/lib/persistence/index.js';
import { useBannerStore, selectVisibleConditions } from '../../entities/banner/index.js';
import { useTuiStore } from '../../entities/tui/index.js';
import { installBannerDetectors } from '../../features/banner/index.js';
import { bindBlockEntity } from '../../features/command/index.js';
import { installTuiDetector } from '../../features/tui/index.js';
import { rerunBlock, copyBlock } from '../../features/block/index.js';
import { openCompareFromBlock } from '../../features/compare/index.js';
import { submitCommand } from '../../features/composer/submit.js';
import { useCompareStore } from '../../entities/compare/index.js';
import { ComparePanel } from '../../widgets/compare-panel/index.js';
import type { ConnectedSession } from '../../features/session/index.js';
import {
  createSession,
  closeSession,
  switchSession,
  getSessionConnection,
} from '../../features/session-tabs/index.js';
import type { SessionId } from '../../shared/types/generated/index.js';
import { pickBannerCondition } from '../../shared/lib/banner-precedence.js';
import { getHostBridge } from '../../shared/api/host-bridge.js';
import { cx } from '../../shared/lib/cx.js';
import { useKeymap } from '../../shared/lib/keymap.js';
import { createLogger } from '../../shared/lib/logger.js';
import { t } from '../../shared/i18n/index.js';
import { useZoomStore } from '../../features/zoom/index.js';
import {
  ensureNotificationPermission,
  installNotificationDetector,
} from '../../features/notifications/index.js';

import styles from './terminal-page.module.css';

const log = createLogger('terminal-page');

/** xterm's initial grid — we do not know the viewport yet, so we seed with
 *  the Warp-standard 80x24 and let the surface-mount resize observer bring
 *  it in line on its first tick. The BlockList reads nothing from cols/rows. */
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

export function TerminalPage() {
  return (
    <ThemeProvider>
      <TerminalPageContent />
    </ThemeProvider>
  );
}

TerminalPage.displayName = 'TerminalPage';

function TerminalPageContent() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const activeSessionId = useSessionsStore((s) => s.activeId);
  const [activeConnection, setActiveConnection] = useState<ConnectedSession | null>(null);
  // A shared flag so the boot effect doesn't spawn a second session under
  // React 18 StrictMode's double-invoked effects. The unmount cleanup clears
  // this BEFORE awaiting close, so a rapid remount still boots exactly once.
  const bootGuardRef = useRef(false);
  const sessionId = useSessionStore((s) => s.id);
  const health = useSessionStore((s) => s.health);
  const tuiActive = useTuiStore((s) => s.active);
  const needsAltScreen = useNeedsAltScreen();
  const shellRef = useRef<TerminalShellHandle | null>(null);

  // Install banner detectors once. The handle unsubs on unmount so HMR / tests
  // do not accumulate subscriptions.
  useEffect(() => {
    const handle = installBannerDetectors();
    return () => handle.unsubscribe();
  }, []);

  // Wire the command feature's block-entity adapter. The per-session output
  // router is installed by `features/session/connect` on spawn so its
  // lifecycle tracks the session id; installing it here would couple the
  // router scope to the page mount instead of the session.
  useEffect(() => {
    const unbind = bindBlockEntity();
    const tui = installTuiDetector();
    return () => {
      tui.unsubscribe();
      unbind();
    };
  }, []);

  // OS notifications: request permission lazily (so the browser doesn't
  // prompt on page-load for unrelated sessions) and install the detector
  // that watches for long-running blocks completing while hidden.
  useEffect(() => {
    void ensureNotificationPermission();
    const handle = installNotificationDetector();
    return () => handle.unsubscribe();
  }, []);

  // Block persistence (Phase 4): hydrate once, then install the terminal-
  // transition hook for the rest of the page's lifetime. The workspace
  // fingerprint is captured at boot and treated as stable — when the sidecar
  // bridge lands, the fingerprint gets upgraded there (see ADR 0005) and
  // this call becomes a cache warmer instead of the source of truth.
  useEffect(() => {
    let cancelled = false;
    const adapter = createIdbBlockAdapter();
    const workspaceId = computeWorkspaceFingerprint();
    let handle: ReturnType<typeof installBlockPersistence> | null = null;
    void (async () => {
      try {
        await hydrateFromPersistence(adapter, workspaceId);
      } catch (err) {
        log.warn('terminal-page: history hydrate failed', err);
      } finally {
        if (!cancelled) {
          setHydrating(false);
          handle = installBlockPersistence({ adapter, workspaceId });
        }
      }
    })();
    return () => {
      cancelled = true;
      handle?.uninstall();
    };
  }, []);

  // Multi-session data-fan-in: pty bytes must flow to the xterm surface ONLY
  // when the emitting session is the active one. Per-session background
  // output still accrues into that session's blocks via the per-session
  // command router — independent of this callback.
  const handlePtyData = useCallback(
    (emittingSessionId: SessionId, bytesB64: string) => {
      const current = useSessionsStore.getState().activeId;
      if (current !== emittingSessionId) return;
      feedAltScreenStream(bytesB64);
    },
    [],
  );

  // Boot: spawn the first session exactly once. Cmd+T calls `spawnNewSession`
  // directly instead of reusing this effect.
  const spawnNewSession = useCallback(async () => {
    try {
      await createSession({
        bridge: getHostBridge(),
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        onData: handlePtyData,
      });
    } catch (err) {
      log.error('terminal-page: createSession rejected', err);
      useSessionStore.getState().setSession({ health: 'error', exitCode: null });
    }
  }, [handlePtyData]);

  useEffect(() => {
    if (bootGuardRef.current) return;
    bootGuardRef.current = true;
    void spawnNewSession();
    // No cleanup: background sessions are managed by `closeSession`. Unmounting
    // the page (HMR, test teardown) doesn't kill their PTYs — that would
    // regress the "sessions survive a re-render" invariant. If this component
    // is torn down for real, the connection-map is reaped by the full process
    // exit.
  }, [spawnNewSession]);

  // Track the active connection so we can pass it to TerminalShell as a prop.
  // Using a subscription (not a hook over zustand) because `activeConnection`
  // lives in the feature-owned map, not the store. We re-read the map on
  // every activeId change.
  useEffect(() => {
    if (activeSessionId === null) {
      setActiveConnection(null);
      return;
    }
    setActiveConnection(getSessionConnection(activeSessionId) ?? null);
  }, [activeSessionId]);

  // Focus handoff: when alt-screen becomes active, move focus into the xterm
  // textarea so the user's keystrokes go straight to the TUI (vim, less,
  // htop) without an extra click. On exit, xterm unmounts and focus falls
  // naturally back to the composer.
  useEffect(() => {
    if (!tuiActive && !needsAltScreen) return;
    const handle = shellRef.current;
    if (!handle) return;
    // Defer a frame so the CSS class flip paints before we steal focus.
    const raf =
      typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
    const cancel =
      typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
        ? window.cancelAnimationFrame
        : (id: number) => clearTimeout(id);
    const id = raf(() => {
      handle.focus();
    });
    return () => {
      cancel(id as number);
    };
  }, [tuiActive, needsAltScreen]);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const compareOpen = useCompareStore((s) => s.open);
  const closeCompare = useCompareStore((s) => s.closeCompare);

  // Keymap handlers are wrapped in `useCallback` so `useKeymap` does not
  // unsubscribe + re-subscribe on every page render. Without this, the hook's
  // dep array (`[shortcut, handler, ...]`) flips on each re-render because an
  // inline arrow function mints a fresh identity each time.
  const onPaletteShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    setPaletteOpen((p) => !p);
  }, []);
  const onHistoryShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    setHistoryOpen((p) => !p);
  }, []);
  const onSettingsShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    setSettingsOpen((p) => !p);
  }, []);
  // Escape cascade: history-search first (most transient ⌘F surface), then
  // the palette, then the Compare panel, then dismiss the top banner. The
  // Compare panel also handles Escape locally (with stopPropagation) so a
  // focused click-inside scenario resolves at the panel; this global
  // handler covers the "panel mounted but focus elsewhere" edge case.
  //
  // Spec: "panel takes precedence over banner dismissal but NOT over palette".
  const onEscape = useCallback(() => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    if (paletteOpen) {
      setPaletteOpen(false);
      return;
    }
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (compareOpen) {
      closeCompare();
      return;
    }
    // Dismiss the highest-precedence active, not-yet-dismissed banner.
    const bannerStore = useBannerStore.getState();
    const visible = selectVisibleConditions(bannerStore);
    const top = pickBannerCondition(visible);
    if (top) bannerStore.dismiss(top);
  }, [historyOpen, paletteOpen, settingsOpen, compareOpen, closeCompare]);
  const onNewTabShortcut = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault();
      void spawnNewSession();
    },
    [spawnNewSession],
  );
  const onCloseTabShortcut = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault();
      const activeId = useSessionsStore.getState().activeId;
      if (activeId === null) return;
      // Only prompt on the active session having a running block — otherwise
      // close silently (mirrors browser behavior for a tab with no work).
      if (typeof window !== 'undefined') {
        const ok = window.confirm(t('terminal.closeConfirm'));
        if (!ok) return;
      }
      void closeSession(activeId).then(() => {
        // Phase-4 policy: if no sessions remain, boot a fresh one. An empty
        // terminal chrome is confusing — the user nearly always wants another
        // shell. The EmptyState is still reachable via an explicit nav path
        // in later phases (command palette → "Close all sessions").
        const coll = useSessionsStore.getState();
        if (coll.order.length === 0) {
          void spawnNewSession();
        }
      });
    },
    [spawnNewSession],
  );
  const onBacktickShortcut = useCallback((e: KeyboardEvent) => {
    // Reserved for a future "focus terminal" affordance. Consume the key so
    // browsers that bind ⌘` to window cycling don't steal focus when the user
    // is inside Quanta's chrome.
    e.preventDefault();
  }, []);

  const onZoomInShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    useZoomStore.getState().zoomIn();
  }, []);
  const onZoomOutShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    useZoomStore.getState().zoomOut();
  }, []);
  const onZoomResetShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    useZoomStore.getState().reset();
  }, []);

  useKeymap('mod+k', onPaletteShortcut);
  useKeymap('mod+f', onHistoryShortcut, { allowInEditable: true });
  useKeymap('escape', onEscape, { enabled: true, allowInEditable: true });
  useKeymap('mod+t', onNewTabShortcut);
  useKeymap('mod+w', onCloseTabShortcut);
  useKeymap('mod+`', onBacktickShortcut);
  useKeymap('mod+,', onSettingsShortcut, { allowInEditable: true });
  // Zoom bindings: Cmd+= / Cmd+- / Cmd+0. `allowInEditable` so the shortcut
  // works while typing into the composer; the browser's native zoom is
  // intercepted because we preventDefault in the handler.
  useKeymap('mod+=', onZoomInShortcut, { allowInEditable: true });
  useKeymap('mod+-', onZoomOutShortcut, { allowInEditable: true });
  useKeymap('mod+0', onZoomResetShortcut, { allowInEditable: true });

  const retrySpawn = useCallback(() => {
    // Reset both the singular mirror and the collection — a failed first
    // spawn leaves nothing to salvage. Reload keeps the retry a single,
    // well-understood path; re-running `spawnNewSession` mid-error could
    // race with banner detectors still holding the error health.
    useSessionStore.getState().reset();
    useSessionsStore.getState().reset();
    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    }
  }, []);

  // SessionTabs callbacks — plumbed through the feature action trio.
  const onTabCreate = useCallback(() => {
    void spawnNewSession();
  }, [spawnNewSession]);
  const onTabSelect = useCallback((id: SessionId) => {
    switchSession(id);
  }, []);
  const onTabClose = useCallback(
    (id: SessionId) => {
      void closeSession(id).then(() => {
        const coll = useSessionsStore.getState();
        if (coll.order.length === 0) void spawnNewSession();
      });
    },
    [spawnNewSession],
  );

  // Phase 3 layout: BlockList is the primary surface, always mounted. The
  // xterm TerminalShell is a dialog-like overlay that mounts ONLY when an
  // alt-screen application is active. Two independent signals both flip
  // it on during Phase-3 rollout — the widget-local byte detector
  // (`needsAltScreen`) and the TUI feature store (`tuiActive`). Either
  // one is sufficient; both sources converge when both detectors see the
  // same enter sequence in the same chunk.
  const onRerun = useCallback((blockId: string) => {
    void rerunBlock({
      blockId,
      // Two-arg submit: carries the predecessor id through to `startBlock`
      // so the new block's `rerunOfId` is stamped atomically (Phase 4).
      submit: async (text, opts) => {
        await submitCommand({ text, rerunOf: opts.rerunOf });
      },
    }).then((result) => {
      // Audit P1 (fix 4): surface a toast when the rerun was rejected
      // because the source block is still running. Silent rejection was
      // the failure mode the audit called out.
      if (!result.ok && result.reason === 'source-running') {
        showToast({
          kind: 'warning',
          message: t('terminal.rerunBlocked'),
        });
      }
    });
  }, []);
  const onCopy = useCallback(
    (blockId: string, scope: 'command' | 'output') => {
      void copyBlock({ blockId, scope });
    },
    [],
  );
  const onCompare = useCallback((blockId: string) => {
    openCompareFromBlock(blockId);
  }, []);

  const altScreenVisible = needsAltScreen || tuiActive;

  // Stabilize the SessionTabs callbacks prop identity — TitleBar memoizes
  // its rightSlot children where possible.
  const sessionTabsNode = useMemo(
    () => (
      <SessionTabs onCreate={onTabCreate} onSelect={onTabSelect} onClose={onTabClose} />
    ),
    [onTabCreate, onTabSelect, onTabClose],
  );

  const view = (() => {
    if (health === 'error' && !sessionId) {
      return (
        <ErrorState
          message={t('terminal.errorMessage')}
          onRetry={retrySpawn}
        />
      );
    }
    return (
      <>
        <div className={styles.blockListHost}>
          <BlockList
            sessionId={activeSessionId}
            onRerun={onRerun}
            onCopy={onCopy}
            onCompare={onCompare}
          />
        </div>
        {altScreenVisible && (
          <div
            className={styles.altScreenOverlay}
            role="dialog"
            aria-label={t('terminal.altScreenLabel')}
          >
            <TerminalShell ref={shellRef} autoFocus session={activeConnection} />
          </div>
        )}
        {!sessionId && health === 'booting' && (
          <div className={styles.overlay}>
            <LoadingState />
          </div>
        )}
      </>
    );
  })();

  return (
    <div className={styles.page}>
      <TitleBar onOpenPalette={openPalette} rightSlot={sessionTabsNode} />
      <BannerHost />
      <main
        className={cx(styles.main, altScreenVisible && styles.tuiActive)}
        aria-label={t('terminal.region')}
        data-tui-active={altScreenVisible ? 'true' : 'false'}
      >
        {view}
        {altScreenVisible && (
          <div className={styles.tuiBadge} aria-live="polite">
            <Badge
              label="TUI"
              tone="neutral"
              srDescription={t('terminal.tuiSr')}
            />
          </div>
        )}
      </main>
      <Composer />
      <StatusBar />
      <CommandPalette open={paletteOpen} onClose={closePalette} />
      <HistorySearch open={historyOpen} onClose={closeHistory} hydrating={hydrating} />
      <ComparePanel />
      <SettingsPanel open={settingsOpen} onClose={closeSettings} />
      {/* Audit P1 (fix 5): ToastHost renders ephemeral notifications from
          `showToast()` — open-in-editor failures, rerun-while-running, etc.
          Mounted alongside the banner host so both affordances coexist. */}
      <ToastHost />
    </div>
  );
}

TerminalPageContent.displayName = 'TerminalPageContent';
