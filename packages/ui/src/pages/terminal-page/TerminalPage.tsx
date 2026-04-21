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
import {
  useWorkspaceSnapshotStore,
  bindAutoCapture,
  // `autoRestoreIfPresent` is exported for future boot orchestration — see
  // the "Workspace snapshots" effect below. Intentionally unused here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  autoRestoreIfPresent as _autoRestoreIfPresent,
} from '../../features/workspace-snapshot/index.js';
import { computeWorkspaceFingerprint } from '../../shared/lib/persistence/index.js';
import { useBannerStore, selectVisibleConditions } from '../../entities/banner/index.js';
import { useAltScreenMode, useTuiStore } from '../../entities/tui/index.js';
import { installBannerDetectors } from '../../features/banner/index.js';
import { bindBlockEntity } from '../../features/command/index.js';
import { installTuiDetector, TuiRenderSurface } from '../../features/tui/index.js';
import { SessionInputSurface } from '../../features/session/index.js';
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
import { OutputSearch } from '../../widgets/output-search/index.js';
// Plan 0005 P1-F wave 1 — the grid-wide FindPanel is the canonical search
// surface. Cmd+F opens it; the panel pulls the active session's VT emulator
// via `getSessionConnection(activeSessionId).engine.emulator` and feeds
// matches into the TerminalCanvas overlay via `useFindPanelStore`. The
// legacy OutputSearch (block-local) stays mounted on the page for now but
// is no longer bound to Cmd+F; users reach it through the command palette.
import { FindPanel, useFindPanelStore } from '../../widgets/find-panel/index.js';
// Plan 0005 P1-G wave 2 — ghost-hint pill reads from the real ModeStack
// (wired via `features/mode-stack/install.ts` in connect.ts). Mounted here
// gated on `flag.ghostHints` so power users can opt out without the widget
// touching their keyboard / focus semantics.
import { GhostHint } from '../../widgets/ghost-hint/index.js';
// Plan 0005 P1-C — block overlay chrome. The overlay mounts only when
// `flag.blockUx === true`; it paints absolute-positioned card chrome over
// the grid canvas without touching byte-path state.
import { BlockOverlayHost } from '../../widgets/block-overlay/BlockOverlayHost.js';
import { useOutputSearchStore } from '../../features/output-search/index.js';
import { BellFlash } from '../../widgets/bell-flash/index.js';
import { useBellStore } from '../../entities/bell/index.js';
import { useBellSettings, playBeep } from '../../features/bell/index.js';
import type { ConnectedSession } from '../../features/session/index.js';
import {
  createSession,
  closeSession,
  switchSession,
  getSessionConnection,
} from '../../features/session-tabs/index.js';
import {
  splitActivePane,
  closeActivePane,
  focusPaneSibling,
} from '../../features/pane-tabs/index.js';
import {
  usePaneStore,
  getActivePaneSessionId,
} from '../../entities/pane/index.js';
import { PaneGrid, PANE_ZOOM_SHORTCUT } from '../../widgets/pane-grid/index.js';
import type { SessionId } from '../../shared/types/generated/index.js';
import { pickBannerCondition } from '../../shared/lib/banner-precedence.js';
import { getHostBridge, tryGetHostBridge } from '../../shared/api/host-bridge.js';
import { cx } from '../../shared/lib/cx.js';
import { useKeymap } from '../../shared/lib/keymap.js';
import { createLogger } from '../../shared/lib/logger.js';
// Plan 0005 Epic δ: block UX widgets (BlockList / Composer / BlockCard /
// ShellIntegrationBanner / etc.) mount only when `flag.blockUx === true`.
// The default P0 shipping surface is a plain grid — TuiRenderSurface +
// SessionInputSurface — so this flag is read at the top of the component
// and gates every block-scoped subtree below. See the README in
// `src/__tests__/p1-block-ux/` for the migration convention.
import { useFeatureFlag } from '../../shared/config/feature-flags.js';
import { t } from '../../shared/i18n/index.js';
import { useZoomStore } from '../../features/zoom/index.js';
import { installNotificationDetector } from '../../features/notifications/index.js';
import { runAutoImport } from '../../features/shell-history-import/index.js';
import { LiveRegion, useA11yAnnounceSettings } from '../../features/a11y-announce/index.js';
import {
  StopRecordingModal,
  subscribeStopResult,
  toggleRecording,
  type StopRecordingResult,
} from '../../features/session-record/index.js';
// Plan 0005 P1-E — session restore. Off by default (flag: sessionRestore);
// the wiring here is a best-effort probe that runs the replay engine if the
// flag is on and surfaces the result to the logger + `setRestoreOverlay`
// state. The actual grid-integration (handing the replayed emulator to the
// session connect adapter) is deliberately deferred to a follow-up task so
// this change remains surgical — the emulator snapshot already exercises
// the deterministic replay path.
import { base64ToBytes, replaySession } from '../../features/session-restore/index.js';

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
  // Plan 0005 Epic δ — P0 default gate.
  //   - When `blockUxOn === false` (the P0 default), the block presentation
  //     layer (BlockList / BlockCard / Composer / ShellIntegrationBanner /
  //     etc.) does NOT mount. The terminal is a plain grid: TuiRenderSurface
  //     paints the session's VT engine output, and SessionInputSurface routes
  //     keystrokes to the PTY byte-for-byte.
  //   - When `blockUxOn === true` (P1 opt-in, set via the feature-flags
  //     store or the `QUANTA_FLAG_BLOCK_UX=on` env var), the legacy block-
  //     card surface mounts on top, same as the pre-Epic-δ layout.
  // The gate is read ONCE at the top of the component so the render tree
  // below switches atomically on flag change — no half-mounted state.
  const blockUxOn = useFeatureFlag('blockUx');
  // Plan 0005 P1-E — session restore (default off). When on, the terminal
  // page awaits `replaySession(lastId)` before the first PTY subscribe so
  // the grid paints the last-known state instead of blank. The overlay is
  // shown only when replay takes > 100 ms; the flag stays off by default
  // until the journal format graduates past P1-E review.
  const sessionRestoreOn = useFeatureFlag('sessionRestore');
  const ghostHintsOn = useFeatureFlag('ghostHints');
  const [restoreOverlayVisible, setRestoreOverlayVisible] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stopRecordingResult, setStopRecordingResult] =
    useState<StopRecordingResult | null>(null);
  const [hydrating, setHydrating] = useState(true);
  // Screen-reader announcement for alt-screen enter / exit transitions. The
  // value is re-computed every time `altScreen.active` changes so a11y users
  // hear "Entered vim" / "Exited TUI mode, back to shell" even though the
  // canvas itself is opaque to the AT tree.
  const [altScreenAnnounce, setAltScreenAnnounce] = useState('');
  // Screen-reader announcement for pane zoom / unzoom. Written inside the
  // `mod+shift+enter` handler; the aria-live region at the bottom of the
  // page clears itself after a short timeout so repeat zoom-toggles fire
  // fresh utterances.
  const [paneZoomAnnounce, setPaneZoomAnnounce] = useState('');
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

  // Sync the pane tree's focus with the active session id. Two directions:
  //   1. When tabs change the active session, move pane focus to the matching
  //      leaf (if it exists in the tree). Drops gracefully when the session
  //      is not in the tree (e.g. a freshly created tab that isn't a split).
  //   2. Pane focus → switchSession is handled inline by the click / keymap
  //      handlers so the dependency graph stays unidirectional here.
  useEffect(() => {
    if (activeSessionId === null) return;
    const paneState = usePaneStore.getState();
    if (!paneState.root) return;
    const activePaneId = getActivePaneSessionId();
    if (activePaneId === activeSessionId) return;
    paneState.focusSession(activeSessionId);
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

  // Alt-screen announcer: on every enter/exit transition, update the polite
  // live region so screen-reader users are told the UI is switching into or
  // out of TUI mode. The command label (e.g. "vim") is included when the
  // store's `command` is populated. A ref tracks the previous `active` value
  // so we don't announce "Exited TUI mode" on the initial render.
  const prevAltActiveRef = useRef<boolean | null>(null);
  useEffect(() => {
    const prev = prevAltActiveRef.current;
    prevAltActiveRef.current = altScreen.active;
    if (prev === null) return; // First observation: no transition to announce.
    if (altScreen.active === prev && altScreen.active) {
      // Still active but the command label changed — refresh the message.
      const cmd = tuiCommand ? ` (${tuiCommand})` : '';
      setAltScreenAnnounce(t('tui.announce.entered', { command: cmd }));
      return;
    }
    if (altScreen.active === prev) return; // No real transition.
    if (altScreen.active) {
      const cmd = tuiCommand ? ` (${tuiCommand})` : '';
      setAltScreenAnnounce(t('tui.announce.entered', { command: cmd }));
    } else {
      setAltScreenAnnounce(t('tui.announce.exited'));
    }
  }, [altScreen.active, tuiCommand]);

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

  // OS notifications: install the detector only. Permission prompting is
  // deferred to the settings-panel toggle (a real user gesture) — browsers
  // reject `Notification.requestPermission()` calls made from non-gesture
  // code paths like this mount-time effect.
  useEffect(() => {
    const handle = installNotificationDetector();
    return () => handle.unsubscribe();
  }, []);

  // Shell-history import: on first mount after `ranOnce === false`, scrape
  // the user's existing zsh / bash / fish history file so autosuggest and
  // the command palette are useful immediately. Fire-and-forget: any
  // failure flips `ranOnce` so we don't retry on every boot, and logs
  // via the feature's own `createLogger`. Sits outside the boot effect so
  // a slow home-dir lookup can't delay session spawn.
  useEffect(() => {
    const bridge = tryGetHostBridge();
    if (!bridge) return;
    void runAutoImport({ bridge }).catch((err: unknown) => {
      log.warn('terminal-page: shell-history auto-import failed', err);
    });
  }, []);

  // Audible bell: when a new bell arrives AND the audibleBell setting is
  // enabled, synthesise a short sine beep via WebAudio. The store already
  // throttles rapid bells so we don't need to de-dupe here. Gating is
  // read-once inside the effect because re-running the subscription on
  // every settings change is wasteful; we read the live setting at fire
  // time instead.
  const bellCount = useBellStore((s) => s.bellCount);
  useEffect(() => {
    if (bellCount === 0) return;
    if (!useBellSettings.getState().audibleBell) return;
    playBeep();
  }, [bellCount]);

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

  // Workspace snapshots: hydrate the snapshot store at boot so the Settings
  // UI has the list ready, and bind the auto-capture lifecycle hooks
  // (visibilitychange / beforeunload). Auto-restore on boot is deliberately
  // NOT kicked off from here — the first-session-spawn path below races this
  // and would either leak the default-spawned session or prevent restore. The
  // user-driven "Restore snapshot" palette command + settings UI remain the
  // primary restore surfaces; auto-restore is available as an optional
  // `autoRestoreIfPresent` call for future boot orchestration.
  useEffect(() => {
    void useWorkspaceSnapshotStore.getState().hydrate();
    const binding = bindAutoCapture();
    return () => {
      binding.uninstall();
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
      const result = await createSession({
        bridge: getHostBridge(),
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        onData: handlePtyData,
      });
      // Seed the pane tree on first spawn. `setRoot` is idempotent (no-op
      // when a tree already exists), so additional `spawnNewSession` calls
      // from `Cmd+T` don't disturb the split layout — those create new
      // tabs, not new panes. Pane splits go through `splitActivePane`.
      usePaneStore.getState().setRoot(result.sessionId);
    } catch (err) {
      log.error('terminal-page: createSession rejected', err);
      useSessionStore.getState().setSession({ health: 'error', exitCode: null });
    }
  }, [handlePtyData]);

  useEffect(() => {
    if (bootGuardRef.current) return;
    bootGuardRef.current = true;
    // Plan 0005 P1-E: if the session-restore flag is on, try to replay the
    // last journal before spawning a fresh shell. The replay is time- and
    // size-bounded (see DEFAULT_STORM_LIMITS), so a pathological journal
    // cannot delay boot indefinitely. On any failure we fall through to the
    // normal spawn path — the user sees a blank grid instead of a toast.
    //
    // The replayed emulator is NOT yet plumbed into the live grid mirror;
    // that hook requires `connect.ts` to accept an opt-in "pre-seeded"
    // emulator, which is tracked as a P1-E follow-up. For now the overlay
    // presence + the recorded metrics prove the journal-read / replay
    // pipeline is sound.
    if (sessionRestoreOn) {
      const overlayTimer = setTimeout(() => setRestoreOverlayVisible(true), 100);
      const lastId = (useSessionsStore.getState().activeId ??
        null) as SessionId | null;
      if (lastId !== null) {
        void (async () => {
          try {
            // Plan 0005 P1-E / W2-D — consume the host bridge's
            // `loadSessionJournal` method when present (Tauri wires this
            // via `quanta_session_journal_read`). Hosts without persistent
            // storage (mock bridge, VS Code webview) null-check out and the
            // replay downgrades to a no-op dry run — the overlay timer and
            // metrics still fire so the pipeline stays exercised.
            const hostBridge = tryGetHostBridge();
            const journalLoader =
              hostBridge && typeof hostBridge.loadSessionJournal === 'function'
                ? hostBridge.loadSessionJournal.bind(hostBridge)
                : async () => [];
            const result = await replaySession(lastId, {
              port: {
                async loadSessionJournal(sid) {
                  const entries = await journalLoader(sid);
                  const out: Uint8Array[] = [];
                  for (const e of entries) {
                    out.push(base64ToBytes(e.bytes_b64));
                  }
                  return out;
                },
              },
            });
            if (result.fallbackReason) {
              log.info(
                'session-restore: skipped',
                { reason: result.fallbackReason, elapsedMs: result.elapsedMs },
              );
            } else {
              log.info('session-restore: replayed', {
                playedFrames: result.playedFrames,
                playedBytes: result.playedBytes,
                elapsedMs: result.elapsedMs,
              });
            }
          } catch (err) {
            log.warn('session-restore: replay threw', err);
          } finally {
            clearTimeout(overlayTimer);
            setRestoreOverlayVisible(false);
            void spawnNewSession();
          }
        })();
        return () => clearTimeout(overlayTimer);
      }
      clearTimeout(overlayTimer);
    }
    void spawnNewSession();
    return undefined;
  }, [spawnNewSession, sessionRestoreOn]);

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
  // Plan 0005 P1-F — Cmd+F opens the grid-wide FindPanel (scrollback +
  // viewport search). The legacy OutputSearch widget is still reachable
  // via the command palette, but no longer owns the shortcut — grid-wide
  // search is the modern-terminal convention (iTerm2 / kitty / Warp all
  // bind Cmd+F this way).
  const onFindShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    useFindPanelStore.getState().toggle();
  }, []);
  const onEscape = useCallback(() => {
    // P1-F grid-wide find handles its own Escape at the input level, but
    // if focus ever leaves the input (rare) this still lets Esc close it.
    const findPanel = useFindPanelStore.getState();
    if (findPanel.open) {
      findPanel.close();
      return;
    }
    // Legacy block-local output search: same idea.
    const outputSearch = useOutputSearchStore.getState();
    if (outputSearch.open) {
      outputSearch.close();
      return;
    }
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
      // Split-pane semantics: if the active session is part of a
      // multi-pane split, close ONLY the focused pane. When the split
      // collapses to a single leaf, we leave that leaf in place (it maps
      // to a tab). If the pane tree is a single leaf, fall through to the
      // historical "close tab" behaviour.
      const pane = usePaneStore.getState();
      const isMultiPane = pane.root !== null && pane.root.kind === 'split';
      if (isMultiPane) {
        void closeActivePane();
        return;
      }
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
  // Split-pane shortcuts. Cmd+D / Ctrl+Shift+D → horizontal split
  // (new pane sits to the right). Cmd+Shift+D → vertical split (new
  // pane sits below). Both spawn a fresh session and graft it into the
  // current pane's slot via `splitActivePane`.
  const onSplitHorizontalShortcut = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault();
      void splitActivePane({
        bridge: getHostBridge(),
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        onData: handlePtyData,
        dir: 'horizontal',
      }).catch((err) => log.warn('terminal-page: split horizontal failed', err));
    },
    [handlePtyData],
  );
  const onSplitVerticalShortcut = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault();
      void splitActivePane({
        bridge: getHostBridge(),
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        onData: handlePtyData,
        dir: 'vertical',
      }).catch((err) => log.warn('terminal-page: split vertical failed', err));
    },
    [handlePtyData],
  );
  // Cmd+\ (or Ctrl+\) cycles focus through panes in left-to-right tree order.
  const onCycleFocusShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    focusPaneSibling(1);
  }, []);
  // Cmd+Shift+Enter (Ctrl+Shift+Enter) toggles pane zoom — maximize the
  // focused pane, hiding siblings without closing them. A repeat press
  // restores the split layout. The aria-live announce is driven by a
  // store subscription below, so this handler stays a one-liner and the
  // palette entry (which also calls `toggleZoomFocusedPane`) gets the
  // same announcement for free.
  const onToggleZoomShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    const before = usePaneStore.getState();
    if (!before.root) return;
    // Single-pane tree with no zoom state → nothing meaningful to toggle.
    if (before.root.kind === 'leaf' && before.zoomedPaneId === null) return;
    before.toggleZoomFocusedPane();
  }, []);

  // Announce zoom transitions (hotkey AND palette entry). Subscribing to
  // `zoomedPaneId` via `subscribeWithSelector` means the announce string is
  // a pure function of the post-transition state, so both entry paths emit
  // the same utterance. Initial mount is `null → null` which the
  // `prev !== next` guard elides, keeping the boot a11y tree quiet.
  useEffect(() => {
    const unsubscribe = usePaneStore.subscribe(
      (s) => s.zoomedPaneId,
      (next, prev) => {
        if (next === prev) return;
        setPaneZoomAnnounce(
          next !== null
            ? t('paneLayout.zoomedAnnounce')
            : t('paneLayout.restoredAnnounce'),
        );
      },
    );
    return unsubscribe;
  }, []);
  const onBacktickShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
  }, []);

  const onNextTabShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    const { order, activeId } = useSessionsStore.getState();
    if (order.length < 2 || activeId === null) return;
    const idx = order.indexOf(activeId);
    const next = order[(idx + 1) % order.length];
    if (next) switchSession(next);
  }, []);

  const onPrevTabShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    const { order, activeId } = useSessionsStore.getState();
    if (order.length < 2 || activeId === null) return;
    const idx = order.indexOf(activeId);
    const prev = order[(idx - 1 + order.length) % order.length];
    if (prev) switchSession(prev);
  }, []);

  // Cmd+Alt+A cycles screen-reader announcements off → polite → assertive → off.
  // `allowInEditable` is true because a blind user may have composer focus
  // while flipping announcement mode — they still need the keybind to work.
  const onA11yAnnounceCycleShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    useA11yAnnounceSettings.getState().cycleMode();
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
  // Asciicast recording: Cmd+Shift+R toggles. A manual invocation fans the
  // stop result back via the subscribeStopResult bus so the modal always
  // opens from the same signal (hotkey, palette click, overflow abort).
  const onToggleRecordingShortcut = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    toggleRecording();
  }, []);

  useKeymap('mod+k', onPaletteShortcut);
  useKeymap('mod+f', onFindShortcut, { allowInEditable: true });
  useKeymap('mod+shift+f', onHistoryShortcut, { allowInEditable: true });
  useKeymap('escape', onEscape, { enabled: true, allowInEditable: true });
  useKeymap('mod+t', onNewTabShortcut);
  useKeymap('mod+w', onCloseTabShortcut);
  useKeymap('mod+`', onBacktickShortcut);
  useKeymap('mod+,', onSettingsShortcut, { allowInEditable: true });
  useKeymap('mod+=', onZoomInShortcut, { allowInEditable: true });
  useKeymap('mod+-', onZoomOutShortcut, { allowInEditable: true });
  useKeymap('mod+0', onZoomResetShortcut, { allowInEditable: true });
  // Split-pane keymap. Cmd+D splits horizontally (new pane to the right),
  // Cmd+Shift+D splits vertically (new pane below). Cmd+\ cycles pane focus.
  useKeymap('mod+d', onSplitHorizontalShortcut);
  useKeymap('mod+shift+d', onSplitVerticalShortcut);
  useKeymap('mod+\\', onCycleFocusShortcut, { allowInEditable: true });
  useKeymap(PANE_ZOOM_SHORTCUT, onToggleZoomShortcut, { allowInEditable: true });
  useKeymap('mod+alt+a', onA11yAnnounceCycleShortcut, { allowInEditable: true });
  useKeymap('mod+shift+r', onToggleRecordingShortcut, { allowInEditable: true });
  useKeymap('mod+]', onNextTabShortcut, { allowInEditable: true });
  useKeymap('mod+[', onPrevTabShortcut, { allowInEditable: true });

  // Cmd/Ctrl+1..9 — jump directly to the Nth tab (Cmd+9 always goes to last).
  useEffect(() => {
    const isMac = typeof navigator !== 'undefined' && /mac/iu.test(navigator.platform ?? '');
    const handler = (e: globalThis.KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey) return;
      const n = parseInt(e.key, 10);
      if (n < 1 || n > 9) return;
      e.preventDefault();
      const { order } = useSessionsStore.getState();
      if (order.length === 0) return;
      const id = n === 9 ? order[order.length - 1] : order[n - 1];
      if (id) switchSession(id);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Subscribe to the session-record controller so any stop path (hotkey,
  // palette, overflow) surfaces the StopRecordingModal from this page mount.
  useEffect(() => {
    const unsubscribe = subscribeStopResult((result) => {
      setStopRecordingResult(result);
    });
    return () => unsubscribe();
  }, []);

  const dismissStopRecordingModal = useCallback(() => {
    setStopRecordingResult(null);
  }, []);

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
        // Session removal also tears its pane leaf out of the tree. When the
        // leaf was the last one (single-pane tab), the tree collapses to
        // empty; `spawnNewSession` below reseeds it on the next create.
        const paneState = usePaneStore.getState();
        if (paneState.root) {
          // If the currently-focused leaf is the closed session, pop it;
          // otherwise we hunt for the matching leaf manually.
          const activeLeaf = paneState.root;
          if (activeLeaf.kind === 'leaf' && activeLeaf.sessionId === id) {
            paneState.closeActive();
          } else {
            // Focus the target first so closeActive removes the correct leaf.
            paneState.focusSession(id);
            const next = usePaneStore.getState();
            if (next.root) next.closeActive();
          }
        }
        const coll = useSessionsStore.getState();
        if (coll.order.length === 0) void spawnNewSession();
      });
    },
    [spawnNewSession],
  );

  // Degraded-mode hook. Subscribes to the host bridge's sidecar-recovered
  // event (EPIC-H §4.4) and exposes a `state` the banner reads.
  //
  // `currentSessionId` scopes the `sidecar_crash_recovered` trigger to
  // the session the UI currently owns. The Tauri startup path replays
  // one synthetic exit per session recorded in the prior-process crash
  // marker; without this scope the UI would flag a brand-new post-boot
  // session as crashed on every cold start where the previous run did
  // not exit cleanly.
  const bridge = tryGetHostBridge();
  const degraded = useDegradedMode({
    bridge: bridge ?? null,
    currentSessionId: activeSessionId,
  });

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

  // Is the current pane tree a multi-pane split? Single-leaf trees fall back
  // to the legacy BlockList rendering so the first-boot flow stays identical.
  const paneRoot = usePaneStore((s) => s.root);
  const isMultiPane = paneRoot !== null && paneRoot.kind === 'split';

  const onPaneFocus = useCallback((id: SessionId) => {
    usePaneStore.getState().focusSession(id);
    switchSession(id);
  }, []);

  const renderPane = useCallback(
    (paneSessionId: SessionId) => {
      return (
        <BlockList
          sessionId={paneSessionId}
          onRerun={onRerun}
          onCopy={onCopy}
          onCompare={onCompare}
        />
      );
    },
    [onRerun, onCopy, onCompare],
  );

  const mainContent = (() => {
    if (health === 'error' && !sessionId) {
      return <ErrorState message={t('terminal.errorMessage')} onRetry={retrySpawn} />;
    }
    // Epic δ P0 default: no block UX. The `blockListHost` slot stays
    // `flex: 1` to preserve the layout below; the grid is painted by the
    // always-on `TuiRenderSurface` further down in the <main> tree. A
    // booting session still surfaces the LoadingState overlay so first-
    // spawn feedback is identical to the P1 layout.
    if (!blockUxOn) {
      return (
        <>
          <div className={styles.blockListHost} />
          {!sessionId && health === 'booting' && (
            <div className={styles.overlay}>
              <LoadingState />
            </div>
          )}
          {restoreOverlayVisible && (
            <div
              className={styles.overlay}
              role="status"
              aria-live="polite"
              data-testid="session-restore-overlay"
            >
              {'Restoring session…'}
            </div>
          )}
        </>
      );
    }
    if (isMultiPane) {
      return (
        <div className={styles.blockListHost}>
          <PaneGrid renderPane={renderPane} onPaneFocus={onPaneFocus} />
        </div>
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
    <div
      className={cx(styles.page, altScreen.active ? styles.altActive : undefined)}
      data-renderer="canvas"
    >
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
        {/* Alt-screen TUI surface: covers the block list while an alt-
            screen program is active. Returns null when inactive so the
            subscription + parser are only alive during a TUI session. */}
        <TuiRenderSurface
          sessionId={activeSessionId}
          bridge={bridge ?? null}
        />
        {/* Plan 0005 P1-C — block overlay chrome. Absolute-positioned
            cards that track scrollback row ranges; no glyph rendering
            (the grid renderer owns every cell). Mounted only when
            `flag.blockUx === true` AND we're not inside an alt-screen
            application (TuiRenderSurface occludes the chrome region). */}
        {blockUxOn && !altScreen.active && (
          <BlockOverlayHost sessionId={activeSessionId} />
        )}
        {/* Epic β (Plan 0005 §4.β) — always-on SessionInputSurface. Mounted
            unconditionally whenever a session is active: every keyboard
            / mouse / paste / focus / IME event routes through the
            `input-host` encoders and lands on the PTY wire byte-for-byte,
            not via the Composer textarea's submit path. The alt-screen
            gate that previously lived here is gone; the TuiRenderSurface
            visibility still follows `altScreen.active` per existing
            behavior and Epic δ will unify render later.

            Composer coexistence (transitional):
              - Composer is still mounted below; its Enter still calls
                `submitCommand` (legacy path) for now.
              - Events inside the composer textarea (it has its own focus
                + event handlers) stay on the composer — this surface only
                captures events outside that DOM node.
              - Once `flag.blockUx` lands in Epic δ, Composer unmounts in
                the default renderer and every keystroke lands on the wire
                via this surface alone.
              - TODO(Epic δ): remove <Composer /> from this page once the
                flag flips; delete the `submitCommand` legacy path. */}
        {activeSessionId !== null && (
          <SessionInputSurface sessionId={activeSessionId} />
        )}
        {/* Output-search bar: finds text in visible block output. Docks
            itself to the bottom-right of <main> via absolute positioning.
            Returns null when closed so the DOM is completely quiet. */}
        <OutputSearch sessionId={activeSessionId} />
        {/* Plan 0005 P1-F — grid-wide FindPanel. Bound to Cmd+F above;
            returns null when the store is closed. `getEmulator` reads
            the active session's VT emulator lazily on each debounce tick
            so switching tabs while the panel is open re-points the next
            keystroke at the freshly-active grid. */}
        <FindPanel
          getEmulator={() => {
            if (activeSessionId === null) return null;
            const conn = getSessionConnection(activeSessionId);
            return conn?.engine.emulator ?? null;
          }}
        />
        {/* Plan 0005 P1-G — passive bottom-right mode-hint pill. Reads the
            ModeStack populated by `features/mode-stack/install.ts`. Pill is
            non-modal (`role="status"` + `aria-live="polite"`); clicking only
            cancels the auto-dismiss timer, never steals keys from the inner
            mode. Gated on `flag.ghostHints` (default on) so users can opt
            out. */}
        {ghostHintsOn && <GhostHint />}
        {/* Visual bell flash overlay — renders a brief 80 ms highlight
            across the terminal area when the bell store advances. Returns
            null when visualBell is off or no bell is active, so it stays
            invisible to pointer events at all times. */}
        <BellFlash />
      </main>
      {/* Epic δ P0: Composer is a block-UX widget. It unmounts when the
          flag is off; keystrokes still land on the wire via the always-on
          SessionInputSurface. In P1 the composer returns and its Enter
          path feeds submitCommand as before. */}
      {blockUxOn && (
        <div className={styles.composerHost}>
          <Composer />
        </div>
      )}
      <StatusBar />
      <CommandPalette open={paletteOpen} onClose={closePalette} />
      <HistorySearch open={historyOpen} onClose={closeHistory} hydrating={hydrating} />
      <ComparePanel />
      <SettingsPanel open={settingsOpen} onClose={closeSettings} />
      <StopRecordingModal
        result={stopRecordingResult}
        onDismiss={dismissStopRecordingModal}
      />
      <ToastHost />
      {/* Alt-screen announcer: visually-hidden, polite live region. Screen
          readers pick up enter/exit transitions that the canvas can't surface. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={styles.altScreenAnnouncer}
        data-testid="alt-screen-announce"
      >
        {altScreenAnnounce}
      </div>
      {/* Pane zoom announcer: same visually-hidden pattern. Reuses the
          alt-screen announcer's CSS so both live regions have identical
          visually-hidden semantics. Kept as a separate node so an a11y user
          can distinguish the two transitions. assertive is required because
          zoom is a mode change (like full-screen) that must interrupt any
          current screen-reader utterance — polite can be indefinitely
          deferred in a busy terminal stream. */}
      <div
        role="status"
        aria-live="assertive"
        aria-atomic="true"
        className={styles.altScreenAnnouncer}
        data-testid="pane-zoom-announce"
      >
        {paneZoomAnnounce}
      </div>
      {/* Output announcer: opt-in aria-live region fed by useOutputAnnouncer.
          Mounted OUTSIDE any `display:none` parent so screen readers pick it
          up. The component renders `aria-live="off"` when the feature is
          disabled, leaving the node inert without unmount churn. */}
      <LiveRegion />
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

