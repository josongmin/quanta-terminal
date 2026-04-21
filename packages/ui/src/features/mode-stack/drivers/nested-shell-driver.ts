/**
 * nested-shell-driver — tracks SHLVL changes via OSC 7 cwd + SHLVL deltas.
 *
 * When a shell spawns a child shell (user types `bash` in zsh, or ssh spawns
 * a remote shell), SHLVL increments. The legacy "depth" model collapses all
 * nesting to 0/1; the ModeStack instead pushes a `nested-shell` layer for
 * each SHLVL level beyond the root.
 *
 * Signal path: the shell integration script (P1-B) emits `OSC 7 ;
 * file://<host><path>` on every prompt AND includes SHLVL in its
 * `OSC 1337 ; ShellIntegrationVersion=...;SHLVL=N` payload. We accept the
 * SHLVL value directly via `setShellLevel(level)`; the caller is
 * responsible for parsing the OSC payload (done in
 * `shared/lib/vt-emulator/osc-subscribe.ts` per P1-A §A7).
 *
 * The driver maintains the invariant `#{nested-shell layers} == max(0, level - 1)`
 * — one nested layer per SHLVL above the root. On increment, push; on
 * decrement, pop one.
 *
 * Policy for the nested layer:
 *   - inputPolicy: 'passthrough' — input still flows through the PTY.
 *   - mousePolicy: 'outermost_wins' — nested shell doesn't claim mouse;
 *     mouse resolution uses whichever deeper layer (multiplexer, tui) holds it.
 *   - renderHint: 'chrome' — nested shells want block chrome like the root.
 */

import type { Driver, ModeStackHandle } from './types.js';

export interface NestedShellDriver extends Driver {
  /**
   * Update the known SHLVL. Typically called with the parsed number from
   * OSC 7 / OSC 1337 shell-integration payloads. Idempotent: if the level
   * is unchanged, no push/pop happens.
   */
  setShellLevel(level: number): void;
  /** Current nesting depth (number of pushed `nested-shell` layers). */
  readonly depth: () => number;
}

export interface NestedShellDriverOptions {
  readonly stack: ModeStackHandle;
  /** Optional starting SHLVL for the outer shell. Defaults to 1. */
  readonly rootLevel?: number;
}

export function createNestedShellDriver(
  opts: NestedShellDriverOptions,
): NestedShellDriver {
  const { stack } = opts;
  const rootLevel = opts.rootLevel ?? 1;
  const ownedIds: string[] = [];
  let currentLevel: number | null = null;

  const push = (): void => {
    const id = stack.push({
      kind: 'nested-shell',
      inputPolicy: 'passthrough',
      mousePolicy: 'outermost_wins',
      renderHint: 'chrome',
    });
    ownedIds.push(id);
  };

  const pop = (): void => {
    const id = ownedIds.pop();
    if (id !== undefined) stack.pop(id);
  };

  return {
    feed(_bytes) {
      // Byte-level detection deliberately not implemented. OSC 7 / 1337
      // parsing lives with the OSC subscription surface (P1-A §A7);
      // this driver is a pure consumer of `setShellLevel`.
    },
    setShellLevel(level) {
      if (!Number.isFinite(level) || level < 0) return;
      if (currentLevel === level) return;
      const prev = currentLevel ?? rootLevel;
      currentLevel = level;
      const prevDepth = Math.max(0, prev - rootLevel);
      const nextDepth = Math.max(0, level - rootLevel);
      // Restore the desired depth by pushing or popping the delta.
      if (nextDepth > prevDepth) {
        for (let i = 0; i < nextDepth - prevDepth; i += 1) push();
      } else if (nextDepth < prevDepth) {
        for (let i = 0; i < prevDepth - nextDepth; i += 1) pop();
      }
    },
    depth() {
      return ownedIds.length;
    },
    dispose() {
      while (ownedIds.length > 0) pop();
      currentLevel = null;
    },
  };
}
