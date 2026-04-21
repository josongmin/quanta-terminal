/**
 * pager-driver — pushes a `pager` layer when an alt-screen is active AND the
 * process hint matches a known pager (`less`, `more`, `man`, `most`, `bat`,
 * `git --paginate`).
 *
 * This driver does NOT own alt-screen detection — that's the alt-screen
 * driver's job. Instead, the pager driver is signal-driven:
 *   - `setProcessHint(name)` is called when the command router learns a
 *     new foreground process (via OSC 7 cwd change or OSC 133 command-start).
 *   - `onAltScreenEnter()` / `onAltScreenExit()` are called by the alt-
 *     screen driver (or by the shared installer) when depth changes.
 *
 * When BOTH conditions hold — alt-screen active + pager hint — the driver
 * pushes a `pager` layer that overrides `renderHint` to `'ghost'` so the
 * ghost-hint chrome (P1-G) can render "press q to quit" without us
 * touching P1-G in this wave.
 *
 * We also take a second, bytes-only path: `--More--` and the literal colon
 * prompt followed by a cursor-home are the classic more/man/less prompts.
 * If we see those while alt-screen is active AND no explicit hint is set,
 * we still push with `hints.pagerApp = 'less'` (best guess).
 */

import type { Driver, ModeStackHandle } from './types.js';
import type { ModeLayerHints } from '../mode-stack-store.js';

type PagerApp = NonNullable<ModeLayerHints['pagerApp']>;

const PAGER_NAMES = new Set<PagerApp>(['less', 'more', 'man', 'most', 'bat']);

function nameToPagerApp(name: string): PagerApp | null {
  const trimmed = name.trim().toLowerCase();
  if (PAGER_NAMES.has(trimmed as PagerApp)) return trimmed as PagerApp;
  // `git --paginate <cmd>` pipes into $PAGER which is typically less.
  if (trimmed.startsWith('git ') && /(-p|--paginate)(\s|$)/.test(trimmed)) {
    return 'less';
  }
  return null;
}

export interface PagerDriver extends Driver {
  setProcessHint(name: string | null): void;
  onAltScreenEnter(): void;
  onAltScreenExit(): void;
}

export interface PagerDriverOptions {
  readonly stack: ModeStackHandle;
}

export function createPagerDriver(opts: PagerDriverOptions): PagerDriver {
  const { stack } = opts;
  let layerId: string | null = null;
  let altScreenDepth = 0;
  let pagerHint: PagerApp | null = null;
  let byteMatchPending: PagerApp | null = null;

  const maybePush = (): void => {
    if (layerId !== null) return;
    if (altScreenDepth <= 0) return;
    const app = pagerHint ?? byteMatchPending;
    if (app === null) return;
    layerId = stack.push({
      kind: 'pager',
      hints: { pagerApp: app },
      // Pagers consume single-char commands (`q`, `/`, arrows). Line-edit
      // is wrong; intercept_prefix with '\0' prefix means "every key".
      inputPolicy: 'intercept_prefix',
      // Most pagers don't grab mouse; DECSET is rare. Default = dropped
      // so outer mouse (tmux select) still works.
      mousePolicy: 'dropped',
      renderHint: 'ghost',
    });
  };

  const maybePop = (): void => {
    if (layerId === null) return;
    // Drop when either condition goes away.
    if (altScreenDepth <= 0 || (pagerHint === null && byteMatchPending === null)) {
      stack.pop(layerId);
      layerId = null;
    }
  };

  // --- Bytes-only secondary detection -----------------------------------
  //
  // We scan for the literal strings "--More--" and ":" followed by
  // cursor-home-ish CSI sequences. This is conservative: only consult the
  // byte match when no explicit hint was set.

  let buf = '';
  const feedBytes = (bytes: Uint8Array): void => {
    if (pagerHint !== null) return; // explicit hint wins, skip bytes path
    const chunk = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    buf = (buf + chunk).slice(-256); // keep last 256 chars
    if (/--More--/.test(buf)) {
      byteMatchPending = 'more';
      maybePush();
      return;
    }
    // `less` prints "(END)" or ":" at the bottom. We require cursor-home
    // (ESC [ H or ESC [ 0;0 H) recently to reduce false positives.
    if (/\x1b\[(?:\d+;?\d*)?H.*:\s*$/.test(buf)) {
      byteMatchPending = 'less';
      maybePush();
    }
  };

  return {
    feed(bytes) {
      feedBytes(bytes);
    },
    setProcessHint(name) {
      if (name === null) {
        pagerHint = null;
        maybePop();
        return;
      }
      const app = nameToPagerApp(name);
      if (app === null) {
        pagerHint = null;
        maybePop();
        return;
      }
      // Hint changed but same pager — replace hints on the layer by
      // popping + re-pushing. Cheap; the layer count stays bounded.
      if (layerId !== null && pagerHint !== app) {
        stack.pop(layerId);
        layerId = null;
      }
      pagerHint = app;
      maybePush();
    },
    onAltScreenEnter() {
      altScreenDepth += 1;
      maybePush();
    },
    onAltScreenExit() {
      altScreenDepth = Math.max(0, altScreenDepth - 1);
      maybePop();
      // Byte match is per-alt-screen session; reset it when we exit.
      if (altScreenDepth === 0) byteMatchPending = null;
    },
    dispose() {
      if (layerId !== null) stack.pop(layerId);
      layerId = null;
      pagerHint = null;
      byteMatchPending = null;
      altScreenDepth = 0;
      buf = '';
    },
  };
}
