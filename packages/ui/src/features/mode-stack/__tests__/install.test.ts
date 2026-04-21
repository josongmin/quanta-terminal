/**
 * Plan 0005 §P1-D integration tests — `installModeStack`.
 *
 * These pin the installer's contract:
 *   - Wires every enabled driver to `engine.onRawByte`.
 *   - An `ESC[?1049h` chunk fed through the engine reaches the alt-screen
 *     driver and pushes a `tui` layer.
 *   - `dispose()` unsubscribes AND calls each driver's `dispose()` so
 *     owned layers pop cleanly.
 *   - Multiple drivers running in parallel don't corrupt each other's ids.
 *   - The legacy-shim (`useAltScreenModeFromStack`) reflects installer-driven
 *     state.
 *   - Regression canary: driving the C-MUX-03 (tmux-in-ssh-in-tmux, depth 3)
 *     scenario through a SINGLE install still lands the full stack — the
 *     installer does not regress the existing ModeStack semantics.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionId } from '@quanta/host-common';

import { useModeStackStore } from '../mode-stack-store.js';
import { installModeStack } from '../install.js';
import { createSessionEngine } from '../../session/engine.js';

const enc = new TextEncoder();
const SESSION_ID = 'install-test' as SessionId;

/** Build an engine with a manual rAF scheduler so we never wait on real time. */
function makeEngine() {
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  const engine = createSessionEngine({
    sessionId: SESSION_ID,
    cols: 80,
    rows: 24,
    scheduler: (cb) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    cancelScheduler: (id) => {
      callbacks.delete(id);
    },
  });
  return { engine, tickRaf: () => {
    const pending = Array.from(callbacks.values());
    callbacks.clear();
    for (const cb of pending) cb();
  } };
}

describe('installModeStack', () => {
  beforeEach(() => {
    useModeStackStore.getState().reset();
  });

  it('wires all five drivers by default', () => {
    const { engine } = makeEngine();
    const handle = installModeStack({ sessionId: SESSION_ID, engine });
    expect(handle.drivers.altScreen).not.toBeNull();
    expect(handle.drivers.multiplexer).not.toBeNull();
    expect(handle.drivers.pager).not.toBeNull();
    expect(handle.drivers.repl).not.toBeNull();
    expect(handle.drivers.nestedShell).not.toBeNull();
    handle.dispose();
    engine.dispose();
  });

  it('respects per-driver flags (skipped drivers are null)', () => {
    const { engine } = makeEngine();
    const handle = installModeStack({
      sessionId: SESSION_ID,
      engine,
      flags: { multiplexer: false, repl: false },
    });
    expect(handle.drivers.altScreen).not.toBeNull();
    expect(handle.drivers.multiplexer).toBeNull();
    expect(handle.drivers.pager).not.toBeNull();
    expect(handle.drivers.repl).toBeNull();
    expect(handle.drivers.nestedShell).not.toBeNull();
    handle.dispose();
    engine.dispose();
  });

  it('ESC[?1049h fed through the engine pushes a tui layer (alt-screen driver wired)', () => {
    const { engine } = makeEngine();
    const handle = installModeStack({ sessionId: SESSION_ID, engine });
    expect(useModeStackStore.getState().layers).toHaveLength(1);

    engine.feed(enc.encode('\x1b[?1049h'));
    const layers = useModeStackStore.getState().layers;
    expect(layers.map((l) => l.kind)).toEqual(['shell', 'tui']);

    engine.feed(enc.encode('\x1b[?1049l'));
    expect(useModeStackStore.getState().layers).toHaveLength(1);

    handle.dispose();
    engine.dispose();
  });

  it('dispose() unsubscribes drivers from engine and pops owned layers', () => {
    const { engine } = makeEngine();
    const handle = installModeStack({ sessionId: SESSION_ID, engine });

    // Push a tui layer via the wired alt-screen driver.
    engine.feed(enc.encode('\x1b[?1049h'));
    expect(useModeStackStore.getState().layers).toHaveLength(2);

    // Dispose: any owned layer (the tui push above) pops, AND the listener
    // detaches so subsequent feeds are no-ops.
    handle.dispose();
    expect(useModeStackStore.getState().layers).toHaveLength(1);

    // After dispose, further bytes must not push anything.
    engine.feed(enc.encode('\x1b[?1049h'));
    expect(useModeStackStore.getState().layers).toHaveLength(1);

    engine.dispose();
  });

  it('multiple drivers observe the same chunk without conflict (alt-screen + multiplexer)', () => {
    const { engine } = makeEngine();
    installModeStack({ sessionId: SESSION_ID, engine });

    // Single chunk carrying a tmux DCS wrapper followed by an alt-screen enter.
    engine.feed(enc.encode('\x1bPtmux;\x1b]0;x\x07\x1b\\\x1b[?1049h'));

    const kinds = useModeStackStore.getState().layers.map((l) => l.kind);
    // Both pushes land. Order is the driver registration order (alt-screen
    // observes the chunk before multiplexer, so its `tui` push hits first).
    // We only assert both kinds are present — the installer does not promise
    // a cross-driver ordering guarantee.
    expect(kinds).toContain('multiplexer');
    expect(kinds).toContain('tui');
    expect(kinds[0]).toBe('shell');
    expect(useModeStackStore.getState().layers).toHaveLength(3);
  });

  it('shim-compatible snapshot reflects installer-driven state', () => {
    // The `useAltScreenModeFromStack` React hook reads from the same store
    // via the exact same derivation. To avoid booting a renderer we reproduce
    // the derivation off the store snapshot — bit-for-bit the hook's math.
    const { engine } = makeEngine();
    installModeStack({ sessionId: SESSION_ID, engine });

    const snapshotShim = () => {
      const snap = useModeStackStore.getState();
      let depth = 0;
      for (const layer of snap.layers) if (layer.kind === 'tui') depth += 1;
      return { active: depth > 0, depth };
    };

    expect(snapshotShim()).toEqual({ active: false, depth: 0 });

    engine.feed(enc.encode('\x1b[?1049h'));
    expect(snapshotShim()).toEqual({ active: true, depth: 1 });

    // Nested alt-screen: two tui layers (matches ADR 0008 "every enter stacks").
    engine.feed(enc.encode('\x1b[?1049h'));
    expect(snapshotShim()).toEqual({ active: true, depth: 2 });
  });

  it('alt-screen → pager bridge: less bytes fed through engine push a pager layer with hints.pagerApp', () => {
    const { engine } = makeEngine();
    const handle = installModeStack({ sessionId: SESSION_ID, engine });

    // Enter alt-screen first (what `less` does on startup).
    engine.feed(enc.encode('\x1b[?1049h'));
    // Now the pager driver needs a process hint. In production this arrives
    // via OSC 7 / OSC 133 C parsing handed to `setProcessHint`; for the
    // integration test we exercise that seam directly to confirm the
    // installer-owned driver instance is the one receiving the signal.
    handle.drivers.pager?.setProcessHint('less');

    const layers = useModeStackStore.getState().layers;
    expect(layers.map((l) => l.kind)).toEqual(['shell', 'tui', 'pager']);
    const pagerLayer = layers.find((l) => l.kind === 'pager');
    expect(pagerLayer?.hints?.pagerApp).toBe('less');

    // Exit alt-screen → installer's store-subscribed bridge calls
    // `pager.onAltScreenExit()` automatically, popping the pager layer too.
    engine.feed(enc.encode('\x1b[?1049l'));
    expect(
      useModeStackStore.getState().layers.some((l) => l.kind === 'pager'),
    ).toBe(false);

    handle.dispose();
    engine.dispose();
  });

  it('dispose() is idempotent — calling it twice is a safe no-op', () => {
    const { engine } = makeEngine();
    const handle = installModeStack({ sessionId: SESSION_ID, engine });
    engine.feed(enc.encode('\x1b[?1049h'));
    expect(useModeStackStore.getState().layers).toHaveLength(2);

    handle.dispose();
    // Second call must not throw and must not re-pop (the tui layer is
    // already gone; a naive impl that calls driver.dispose() again could
    // trip internal id assertions).
    expect(() => handle.dispose()).not.toThrow();
    expect(useModeStackStore.getState().layers).toHaveLength(1);

    engine.dispose();
  });

  it('concurrent-epoch tiebreak: pager and repl fire on the same chunk → only first lands', () => {
    // Use the raw store handle with two drivers racing on the same epoch.
    // The pager driver is stubbed via direct `stack.push` because its
    // byte-path requires an alt-screen precondition that's orthogonal to
    // the tiebreak rule we're pinning here.
    useModeStackStore.getState().reset();
    const s = useModeStackStore.getState();

    // Simulate pager-first, then repl — same chunk, no intervening ops.
    const pagerId = s.push({
      kind: 'pager',
      hints: { pagerApp: 'less' },
      inputPolicy: 'intercept_prefix',
      mousePolicy: 'dropped',
      renderHint: 'ghost',
    });
    const replId = s.push({
      kind: 'repl',
      hints: { replShell: 'python' },
      inputPolicy: 'line_edit',
      mousePolicy: 'dropped',
      renderHint: 'ghost',
    });

    // Tiebreak: the existing pager layer wins; the repl push coalesces.
    expect(replId).toBe(pagerId);
    const layers = useModeStackStore.getState().layers;
    expect(layers.map((l) => l.kind)).toEqual(['shell', 'pager']);
  });

  it('concurrent-epoch tiebreak does NOT break nesting (tui on top of multiplexer still stacks)', () => {
    // Non-competing kinds (tui, multiplexer, nested-shell) must never
    // coalesce even on back-to-back pushes — only the {pager, repl}
    // competition triggers the tiebreak.
    useModeStackStore.getState().reset();
    const s = useModeStackStore.getState();
    s.push({
      kind: 'multiplexer',
      hints: { multiplexer: 'tmux' },
      inputPolicy: 'intercept_prefix',
      mousePolicy: 'outermost_wins',
      renderHint: 'chrome',
    });
    s.push({
      kind: 'tui',
      inputPolicy: 'passthrough',
      mousePolicy: 'innermost_wins',
      renderHint: 'chrome',
    });
    const kinds = useModeStackStore.getState().layers.map((l) => l.kind);
    expect(kinds).toEqual(['shell', 'multiplexer', 'tui']);
  });

  it('regression canary (C-MUX-03 flavour): tmux → ssh(SHLVL 2) → vim still stacks and resolves innermost-wins', () => {
    // Mirrors `features/mode-stack/__tests__/integration/mode-stack-depth-3.test.tsx`
    // but with ALL drivers wired via `installModeStack`, to guarantee the
    // installer does not regress the depth-3+ resolution.
    const { engine } = makeEngine();
    const handle = installModeStack({ sessionId: SESSION_ID, engine });

    // Outer tmux DCS pass-through: pushes multiplexer.
    engine.feed(enc.encode('\x1bPtmux;\x1b]0;local\x07\x1b\\'));
    // ssh → remote shell; shell integration bumps SHLVL.
    handle.drivers.nestedShell?.setShellLevel(2);
    // Remote tmux detected; BUT the installer uses a single multiplexer
    // driver instance — once pushed, re-seeing `tmux;` doesn't add a second
    // layer. For the canary we care about the reachable depth, not two
    // distinct multiplexer layers. Remote alt-screen via vim pushes tui.
    engine.feed(enc.encode('\x1b[?1049h'));

    const layers = useModeStackStore.getState().layers;
    const kinds = layers.map((l) => l.kind);
    // Expected: shell, multiplexer (outer tmux), nested-shell (ssh hop),
    // tui (vim on remote). Depth 4 layers.
    expect(kinds).toEqual(['shell', 'multiplexer', 'nested-shell', 'tui']);
    expect(useModeStackStore.getState().resolveMousePolicy()).toBe(
      'innermost_wins',
    );
    expect(useModeStackStore.getState().topRenderHint()).toBe('chrome');

    handle.dispose();
    // After dispose: every layer owned by a driver is popped.
    expect(useModeStackStore.getState().layers).toHaveLength(1);

    engine.dispose();
  });
});
