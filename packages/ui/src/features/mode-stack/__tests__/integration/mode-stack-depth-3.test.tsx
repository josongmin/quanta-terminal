/**
 * Integration test — tmux-in-ssh-in-tmux at depth 3.
 *
 * Plan 0005 §P1-D exit gate: "mode stack depth ≥ 3 supported end-to-end",
 * and "innermost mouse wins".
 *
 * Scenario (mirrors compat fixture C-MUX-03):
 *   - Outer tmux on the local machine: multiplexer-driver pushes layer A.
 *   - `ssh remote` — the remote shell starts → nested-shell-driver pushes
 *     layer B via SHLVL 1 → 2.
 *   - Remote tmux on the far end: multiplexer-driver sees its DCS pass-
 *     through again and pushes layer C (innermost).
 *
 * We then assert:
 *   - Stack depth = 4 (shell + 3 pushed layers).
 *   - Innermost tmux layer (C) claims `innermost_wins` mouse (simulates the
 *     inner DECSET 1002 the remote tmux will emit later in the session).
 *   - Input policy = the innermost `intercept_prefix` (C-b prefix in the
 *     innermost tmux).
 *
 * The test runs the drivers sequentially against an in-process store — no
 * React render surface required; ModeStack is a pure data model.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useModeStackStore } from '../../mode-stack-store.js';
import { createAltScreenDriver } from '../../drivers/alt-screen-driver.js';
import { createMultiplexerDriver } from '../../drivers/multiplexer-driver.js';
import { createNestedShellDriver } from '../../drivers/nested-shell-driver.js';

const enc = new TextEncoder();

describe('integration: tmux-in-ssh-in-tmux (depth 3)', () => {
  beforeEach(() => {
    useModeStackStore.getState().reset();
  });

  it('reaches depth 4 with innermost mouse winning', () => {
    const stack = useModeStackStore.getState();

    // Install the three drivers we need for this scenario. Note: we install
    // one multiplexer driver per layer (outer and inner tmux are distinct
    // byte streams reaching the UI through the same channel; in the real
    // product the installer would spawn one driver per detected event, but
    // for a focused test we simulate that by creating two).
    const outerMux = createMultiplexerDriver({ stack });
    const ssh = createNestedShellDriver({ stack, rootLevel: 1 });
    const innerMux = createMultiplexerDriver({ stack });
    const innerAltScreen = createAltScreenDriver({ stack });

    // Step 1 — outer tmux advertises itself via a DCS pass-through.
    outerMux.feed(enc.encode('\x1bPtmux;\x1b]0;local\x07\x1b\\'));
    // Step 2 — ssh to a remote host; remote shell integration reports SHLVL=2.
    ssh.setShellLevel(2);
    // Step 3 — remote tmux detected; inner multiplexer driver receives its
    // own DCS pass-through and pushes layer C.
    innerMux.feed(enc.encode('\x1bPtmux;\x1b]0;remote\x07\x1b\\'));

    const mid = useModeStackStore.getState();
    expect(mid.layers.map((l) => l.kind)).toEqual([
      'shell',
      'multiplexer',
      'nested-shell',
      'multiplexer',
    ]);

    // The INNERMOST layer gates the mouse policy. Simulate the remote
    // tmux opening its alt-screen + subsequently a vim inside it via an
    // alt-screen push — now depth 5, innermost = tui with
    // `innermost_wins` policy. Assert.
    innerAltScreen.feed(enc.encode('\x1b[?1049h'));
    const top = useModeStackStore.getState();
    expect(top.layers).toHaveLength(5);
    expect(top.layers[top.layers.length - 1]?.kind).toBe('tui');
    expect(top.resolveMousePolicy()).toBe('innermost_wins');
    expect(top.topRenderHint()).toBe('chrome');

    // Tear down in reverse order; stack returns to shell only.
    innerAltScreen.dispose();
    innerMux.dispose();
    ssh.dispose();
    outerMux.dispose();
    expect(useModeStackStore.getState().layers).toHaveLength(1);
  });

  it('innermost multiplexer intercepts the prefix key, even when outer is only passthrough', () => {
    const stack = useModeStackStore.getState();
    const outerMux = createMultiplexerDriver({ stack });
    const innerMux = createMultiplexerDriver({ stack });
    outerMux.feed(enc.encode('\x1bPtmux;x\x1b\\'));
    innerMux.feed(enc.encode('\x1bPtmux;y\x1b\\'));

    // Both are multiplexer layers with intercept_prefix — innermost wins by
    // the walk top→bottom rule, which is what we want (the inner tmux gets
    // to see the user's prefix key first).
    expect(useModeStackStore.getState().resolveInputPolicy()).toBe(
      'intercept_prefix',
    );
  });
});
