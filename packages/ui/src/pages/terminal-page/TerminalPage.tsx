/**
 * TerminalPage — the single Phase-1 route.
 *
 * Responsibilities:
 *   - compose the chrome (title bar, banner host, terminal shell, composer,
 *     status bar);
 *   - own the command palette open/close state;
 *   - wire the global keymap (Cmd/Ctrl+K, Cmd/Ctrl+T, Cmd/Ctrl+W, Cmd/Ctrl+`,
 *     Escape);
 *   - switch between the empty/loading/ready/error views based on session state.
 *
 * What the page deliberately does not do: subscribe to the host bridge. That
 * belongs to `features/session/connect`, invoked by the terminal-shell
 * widget. The page only reads the session entity.
 */

import { useCallback, useEffect, useState } from 'react';

import { TitleBar } from '../../widgets/title-bar/index.js';
import { TerminalShell } from '../../widgets/terminal-shell/index.js';
import { Composer } from '../../widgets/composer/index.js';
import { StatusBar } from '../../widgets/status-bar/index.js';
import { BannerHost } from '../../widgets/banner-host/index.js';
import { CommandPalette } from '../../widgets/command-palette/index.js';
import { SessionTabs } from '../../widgets/session-tabs/index.js';
import { EmptyState } from './EmptyState.js';
import { LoadingState } from './LoadingState.js';
import { ErrorState } from './ErrorState.js';

import { useSessionStore } from '../../entities/session/index.js';
import { useBannerStore, selectVisibleConditions } from '../../entities/banner/index.js';
import { installBannerDetectors } from '../../features/banner/index.js';
import { pickBannerCondition } from '../../shared/lib/banner-precedence.js';
import { useKeymap } from '../../shared/lib/keymap.js';
import { createLogger } from '../../shared/lib/logger.js';
import { uiBus } from '../../shared/lib/event-bus.js';

import styles from './terminal-page.module.css';

const log = createLogger('terminal-page');

export function TerminalPage() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sessionId = useSessionStore((s) => s.id);
  const health = useSessionStore((s) => s.health);

  // Install banner detectors once. The handle unsubs on unmount so HMR / tests
  // do not accumulate subscriptions.
  useEffect(() => {
    const handle = installBannerDetectors();
    return () => handle.unsubscribe();
  }, []);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useKeymap('mod+k', (e) => {
    e.preventDefault();
    setPaletteOpen((p) => !p);
  });
  // Escape cascade: close palette first; if no palette open, dismiss the
  // top banner (if any is dismissible). This mirrors the natural "most
  // transient overlay first" rule most editors follow.
  useKeymap(
    'escape',
    () => {
      if (paletteOpen) {
        setPaletteOpen(false);
        return;
      }
      // Dismiss the highest-precedence active, not-yet-dismissed banner.
      const bannerStore = useBannerStore.getState();
      const visible = selectVisibleConditions(bannerStore);
      const top = pickBannerCondition(visible);
      if (top) bannerStore.dismiss(top);
    },
    { enabled: true, allowInEditable: true },
  );
  useKeymap('mod+t', (e) => {
    // Phase 1: new-session is a stub. We still preventDefault so the browser
    // doesn't open a new tab when running in the Tauri webview.
    e.preventDefault();
    // Future: call a session feature; for now we just emit a UI bus hint so
    // the next iteration can hook in without re-wiring the keymap.
    uiBus.emit('terminal.focus', undefined);
  });
  useKeymap('mod+w', (e) => {
    e.preventDefault();
    // Stub with a user-facing confirm so the key isn't a silent no-op.
    if (typeof window !== 'undefined' && sessionId) {
      const ok = window.confirm('Close this session? This will terminate the shell.');
      if (ok) {
        // Real close wires through features/session in a later phase.
        log.info('terminal-page: close-session requested (stub, not yet wired)');
      }
    }
  });
  useKeymap('mod+`', (e) => {
    e.preventDefault();
    uiBus.emit('terminal.focus', undefined);
  });

  const retrySpawn = useCallback(() => {
    // Resetting the store flips `health` back to 'booting' and drops the
    // error exit code. The TerminalShell is remounted via its key below so
    // its useEffect re-runs and a fresh connectSession() attempts to spawn.
    useSessionStore.getState().reset();
  }, []);

  const view = (() => {
    if (!sessionId) {
      if (health === 'error') {
        return (
          <ErrorState
            message="quanta: shell session failed to start. See the status bar for details."
            onRetry={retrySpawn}
          />
        );
      }
      if (health === 'booting') {
        return <LoadingState />;
      }
      return (
        <EmptyState
          onNewSession={() => {
            /* stub */
          }}
          onOpenPalette={openPalette}
        />
      );
    }
    return <TerminalShell />;
  })();

  return (
    <div className={styles.page}>
      <TitleBar onOpenPalette={openPalette} rightSlot={<SessionTabs />} />
      <BannerHost />
      <main className={styles.main} aria-label="Terminal">
        {view}
      </main>
      <Composer />
      <StatusBar />
      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  );
}

TerminalPage.displayName = 'TerminalPage';
