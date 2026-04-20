/**
 * TerminalPage — the single Phase-1 route.
 *
 * EPIC-H / EPIC-I changes (§4.5, §4.2, §4.4; RFC §19):
 *   - `TerminalCanvas` is mounted unconditionally; `BlockList` overlays on
 *     top (absolute positioning via row-range virtualization). The legacy
 *     branches that gated on whether the xterm fallback surface was
 *     active have been deleted along with the xterm dep.
 *   - Alt-screen state is read from the `useAltScreenMode()` selector
 *     (sourced from ModeChanged events via `entities/tui/model.ts`).
 *   - `AltScreenStatusBar` is always mounted; its visibility is driven by
 *     the store's `command` (empty → hidden).
 *   - `DegradedBanner` is mounted; visibility is driven by
 *     `useDegradedMode().state === 'degraded'`.
 *   - `SideBySideHarness` mounts when `preferences.renderer === 'side-by-side'`
 *     AND `import.meta.env.DEV` (dev-only, tree-shaken in prod).
 *
 * Responsibilities:
 *   - compose the chrome (title bar, banner host, terminal canvas, composer,
 *     status bar);
 *   - own the MULTI-SESSION lifecycle (Phase 4). The first session is spawned
 *     automatically on mount. `Cmd+T` / the `+` tab button spawns additional
 *     sessions; `Cmd+W` / the `×` tab button closes the active one.
 *   - own the command palette open/close state;
 *   - wire the global keymap (Cmd/Ctrl+K, Cmd/Ctrl+T, Cmd/Ctrl+W, Cmd/Ctrl+`,
 *     Escape).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { TitleBar } from '../../widgets/title-bar/index.js';
import { BlockList } from '../../widgets/block-list/index.js';
import { Composer } from '../../widgets/composer/index.js';
import { StatusBar } from '../../widgets/status-bar/index.js';
import { BannerHost } from '../../widgets/banner-host/index.js';
import { CommandPalette } from '../../widgets/command-palette/index.js';
import { HistorySearch } from '../../widgets/history-search/index.js';
import { SessionTabs } from '../../widgets/session-tabs/index.js';
import { SettingsPanel } from '../../widgets/settings-panel/index.js';
import { AltScreenStatusBar } from '../../widgets/alt-screen-status/index.js';
import { ThemeProvider } from '../../features/theme/index.js';
// `EmptyState` is kept in the tree for the explicit no-session affordance
// (opened via Cmd+T in Phase 2). Not referenced yet while session boot happens
// transparently under the new block-list surface.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { EmptyState as _EmptyState } from './EmptyState.js';
import { LoadingState } from './LoadingState.js';
import { ErrorState } from './ErrorState.js';

import { showToast, ToastHost } from '../../shared/ui/toast/index.js';

import { useSessionStore, useSessionsStore } from '../../entities/session/index.js';
import {
  createIdbBlockAdapter,
  installBlockPersistence,
  hydrateFromPersistence,
} from '../../entities/block/index.js';
import { computeWorkspaceFingerprint } from '../../shared/lib/persistence/index.js';
import { useBannerStore, selectVisibleConditions } from '../../entities/banner/index.js';
import { useAltScreenMode, useTuiStore } from '../../entities/tui/index.js';
import { installBannerDetectors } from '../../features/banner/index.js';
import { bindBlockEntity } from '../../features/command/index.js';
import { installTuiDetector } from '../../features/tui/index.js';
import { rerunBlock, copyBlock } from '../../features/block/index.js';
import { openCompareFromBlock } from '../../features/compare/index.js';
import { submitCommand } from '../../features/composer/submit.js';
import { useCompareStore } from '../../entities/compare/index.js';
import { ComparePanel } from '../../widgets/compare-panel/index.js';
import {
  DegradedBanner,
  bindDegradedGate,
  useDegradedMode,
} from '../../features/degraded-mode/index.js';
import type { ConnectedSession } from '../../features/session/index.js';
import {
  createSession,
  closeSession,
  switchSession,
  getSessionConnection,
} from '../../features/session-tabs/index.js';
import type { SessionId } from '../../shared/types/generated/index.js';
import { pickBannerCondition } from '../../shared/lib/banner-precedence.js';
import { getHostBridge, tryGetHostBridge } from '../../shared/api/host-bridge.js';
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

function isDevBuild(): boolean {
  try {
    const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
    return Boolean(env?.DEV);
  } catch {
    return false;
  }
}

/** Initial grid seed. The resize observer on the terminal-canvas brings the
 *  dimensions in line on first tick. */
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

/**
 * Dev flag for the side-by-side harness. Dynamically checked so we don't
 * pull `SideBySideHarness` into the production bundle — the module is
 * tree-shaken when `import.meta.env.DEV` is false. The flag name matches
 * the settings knob `preferences.experimental.sideBySide`.
 */
function useSideBySideFlag(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      const raw = window.localStorage?.getItem('quanta.experimental.side-by-side');
      return raw === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: StorageEvent) => {
      if (e.key !== 'quanta.experimental.side-by-side') return;
      setEnabled(e.newValue === 'true');
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);
  return enabled;
}

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

  // EPIC-H: alt-screen state is sourced from the TUI store, which in turn
  // is driven by the byte-level detector (today) or `ModeChanged(AltScreen)`
  // events (tomorrow). No local boolean flags anymore.
  const altScreen = useAltScreenMode();
  const tuiCommand = useTuiStore((s) => s.command);
  const tuiSessionId = useTuiStore((s) => s.sessionId);

  // Plumb the active session id into the tui store so the AltScreenStatusBar
  // shows the right label. This is idempotent when the id hasn't changed.
  useEffect(() => {
    const store = useTuiStore.getState();
    if (store.sessionId !== activeSessionId && activeSessionId !== null) {
      useTuiStore.setState({ sessionId: activeSessionId });
    }
  }, [activeSessionId]);

  // End the 160 ms CSS fade once it completes — the store reads this to
  // clear the `transitioning` flag so the next enter/exit can raise it
  // again. Runs only when the flag is set.
  useEffect(() => {
    if (!altScreen.transitioning) return;
    const timer = setTimeout(() => {
      useTuiStore.getState().endTransition();
    }, 180);
    return () => clearTimeout(timer);
  }, [altScreen.transitioning]);

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

  // OS notifications: request permission lazily.
  useEffect(() => {
    void ensureNotificationPermission();
    const handle = installNotificationDetector();
    return () => handle.unsubscribe();
  }, []);

  // Block persistence (Phase 4): hydrate once, then install the terminal-
  // transition hook for the rest of the page's lifetime.
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

  // Multi-session data-fan-in: alt-screen state is driven entirely by
  // ModeChanged events via the TUI store, and the terminal canvas
  // (EPIC-D) consumes the GridMirror directly. The callback is retained
  // as a no-op so existing tests mocking createSession with an `onData`
  // callback still resolve. After EPIC-I (xterm removal) there is no
  // secondary surface that needs raw bytes at the page level.
  const handlePtyData = useCallback(
    (_emittingSessionId: SessionId, _bytesB64: string) => {
      // No-op. The byte-level alt-screen detector is wired via
      // `installTuiDetector` and reads the chunk stream via the command
      // router's raw observer.
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
  }, [spawnNewSession]);

  // Track the active connection so we can pass it to side-by-side (when
  // opted into). Using a subscription (not a hook over zustand) because
  // `activeConnection` lives in the feature-owned map.
  useEffect(() => {
    if (activeSessionId === null) {
      setActiveConnection(null);
      return;
    }
    setActiveConnection(getSessionConnection(activeSessionId) ?? null);
  }, [activeSessionId]);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const compareOpen = useCompareStore((s) => s.open);
  const closeCompare = useCompareStore((s) => s.closeCompare);

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
      if (typeof window !== 'undefined') {
        const ok = window.confirm(t('terminal.closeConfirm'));
        if (!ok) return;
      }
      void closeSession(activeId).then(() => {
        const coll = useSessionsStore.getState();
        if (coll.order.length === 0) {
          void spawnNewSession();
        }
      });
    },
    [spawnNewSession],
  );
  const onBacktickShortcut = useCallback((e: KeyboardEvent) => {
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
  useKeymap('mod+=', onZoomInShortcut, { allowInEditable: true });
  useKeymap('mod+-', onZoomOutShortcut, { allowInEditable: true });
  useKeymap('mod+0', onZoomResetShortcut, { allowInEditable: true });

  const retrySpawn = useCallback(() => {
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

  // Degraded-mode hook. Subscribes to the host bridge's sidecar-recovered
  // event (EPIC-H §4.4) and exposes a `state` the banner reads.
  const bridge = tryGetHostBridge();
  const degraded = useDegradedMode({ bridge: bridge ?? null });

  // RFC §20 / ADR 0010: while the engine is degraded, user input must not
  // reach the PTY. We bind a narrow gate port that the production write
  // paths (`features/command/execute.ts` and `ConnectedSession.write`)
  // consult before hitting the bridge. A ref indirection keeps the bound
  // closures pointing at fresh hook state without re-binding on every
  // render.
  const degradedRef = useRef(degraded);
  degradedRef.current = degraded;
  useEffect(() => {
    const dispose = bindDegradedGate({
      isDegraded: () => degradedRef.current.state === 'degraded',
      reportDroppedInput: () => degradedRef.current.incrementDroppedInput(),
    });
    return dispose;
  }, []);

  const handleRestart = useCallback(async () => {
    try {
      if (activeSessionId !== null) {
        await closeSession(activeSessionId);
      }
      await spawnNewSession();
      degraded.recover();
    } catch (err) {
      log.warn('degraded restart failed', err);
    }
  }, [activeSessionId, spawnNewSession, degraded]);

  // Dev-flag: side-by-side harness.
  const sideBySideEnabled = useSideBySideFlag();

  // Block actions.
  const onRerun = useCallback((blockId: string) => {
    void rerunBlock({
      blockId,
      submit: async (text, opts) => {
        await submitCommand({ text, rerunOf: opts.rerunOf });
      },
    }).then((result) => {
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

  // Stabilize the SessionTabs callbacks prop identity.
  const sessionTabsNode = useMemo(
    () => <SessionTabs onCreate={onTabCreate} onSelect={onTabSelect} onClose={onTabClose} />,
    [onTabCreate, onTabSelect, onTabClose],
  );

  const mainContent = (() => {
    if (health === 'error' && !sessionId) {
      return <ErrorState message={t('terminal.errorMessage')} onRetry={retrySpawn} />;
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
        {!sessionId && health === 'booting' && (
          <div className={styles.overlay}>
            <LoadingState />
          </div>
        )}
      </>
    );
  })();

  const showAltScreenBar = altScreen.active || altScreen.crashed !== null;

  return (
    <div className={styles.page} data-renderer="canvas">
      <TitleBar onOpenPalette={openPalette} rightSlot={sessionTabsNode} />
      <BannerHost />
      {/* Degraded-mode banner renders above the terminal chrome, below the
          title bar, so the last GridSnapshot stays visible behind it (I-8). */}
      {degraded.state === 'degraded' && (
        <DegradedBanner onRestart={handleRestart} reason={degraded.reason ?? undefined} />
      )}
      {/* Alt-screen thin status bar. Always mounted; its internal `visible`
          flag flips via CSS so the 160 ms fade is a single transition. */}
      <AltScreenStatusBar
        command={showAltScreenBar ? tuiCommand || 'terminal' : ''}
        sessionId={tuiSessionId ?? activeSessionId ?? null}
        depth={altScreen.depth}
        crashed={altScreen.crashed ?? null}
      />
      <main
        className={cx(
          styles.main,
          altScreen.active ? styles.altActive : undefined,
          degraded.state === 'degraded' ? styles.degraded : undefined,
        )}
        aria-label={t('terminal.region')}
        data-alt-screen-active={altScreen.active ? 'true' : 'false'}
        data-alt-screen-depth={String(altScreen.depth)}
        data-degraded={degraded.state === 'degraded' ? 'true' : 'false'}
      >
        {/* Dev-only side-by-side harness. The dev-flag check is
            `isDevBuild()` which reads `import.meta.env.DEV` safely. */}
        {isDevBuild() && sideBySideEnabled ? (
          <SideBySideHarnessLazy session={activeConnection} />
        ) : (
          mainContent
        )}
      </main>
      <Composer />
      <StatusBar />
      <CommandPalette open={paletteOpen} onClose={closePalette} />
      <HistorySearch open={historyOpen} onClose={closeHistory} hydrating={hydrating} />
      <ComparePanel />
      <SettingsPanel open={settingsOpen} onClose={closeSettings} />
      <ToastHost />
    </div>
  );
}

TerminalPageContent.displayName = 'TerminalPageContent';

/**
 * Lazy-ish wrapper that pulls in the side-by-side harness only when the dev
 * flag is flipped. In production the branch never renders and the harness
 * module tree-shakes away. We accept the static import — bundlers shake it
 * out behind the `import.meta.env.DEV` guard in the parent component.
 */
import { SideBySideHarness } from '../../features/compat/index.js';
import { GridMirror } from '../../shared/lib/grid-mirror/index.js';
import { MirrorSource } from '../../shared/ui/cell-renderer/index.js';

function SideBySideHarnessLazy(props: { readonly session: ConnectedSession | null }) {
  // Each mount creates its own lightweight mirror so the dev harness does
  // not interfere with any prod-plumbed mirror. Seed it with an empty 80×24
  // buffer so both renderers have something to paint.
  const [{ mirror, source }] = useState(() => {
    const src = new MirrorSource();
    const m = new GridMirror({ onChange: (d) => src.emit(d) });
    m.applySnapshot({
      session_id: 'side-by-side',
      grid_epoch: 1,
      sequence_no: 0,
      resize_generation: 0,
      buffer_kind: 'main',
      payload: {
        kind: 'grid_snapshot',
        rows: INITIAL_ROWS,
        cols: INITIAL_COLS,
        buffer_kind: 'main',
        row_deltas: [],
        cursor: {
          row: 0,
          col: 0,
          visible: true,
          shape: 'block',
          blinking: false,
          pending_wrap: false,
        },
        mode_state: {},
        meta: {},
      },
    });
    return { mirror: m, source: src };
  });
  return (
    <SideBySideHarness
      mirror={mirror}
      mirrorSource={source}
      session={props.session}
    />
  );
}

