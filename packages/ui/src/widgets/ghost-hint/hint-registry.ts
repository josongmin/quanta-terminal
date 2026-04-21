/**
 * Ghost-hint registry — Plan 0005 P1-G.
 *
 * Maps a mode-stack layer `kind` (e.g. `pager_less`, `repl_python`, `tui_vim`)
 * to the subtle bottom-right affordance text that `GhostHint` renders while
 * the corresponding mode is active.
 *
 * Design notes
 * ------------
 * - Hints are deliberately tiny, instructional, and passive. We never send
 *   the key on click — clicking a pager and surprise-quitting a session is
 *   exactly the kind of footgun this feature is meant to prevent.
 * - `text` is the full human-readable string; `keys` is the list of key
 *   sequences that would dismiss the mode. Keeping them split lets callers
 *   (and screen readers) format the hint independently of the display.
 * - The table lives in a plain `const` object rather than a class / enum so
 *   tests and future integrations can enumerate it with `Object.keys(...)`
 *   without pulling in the React layer.
 *
 * Adding a new hint
 * -----------------
 * 1. Add an entry below.
 * 2. Add a matching branch in `hint-registry.test.ts`'s "all kinds mapped"
 *    iteration.
 * 3. Ensure the new `kind` is emitted by whatever detects the mode in the
 *    upstream `ModeStack` (owned by P1-D).
 */

/**
 * The set of recognized mode-stack layer kinds. The registry covers the P1-G
 * scope — pagers, REPLs, multiplexers, TUIs, and nested shells. Other kinds
 * (AI, composer overlays, etc.) do NOT get a ghost hint because the key
 * bindings are already surfaced elsewhere in the UI.
 */
export type GhostHintKind =
  | 'pager_less'
  | 'pager_man'
  | 'repl_python'
  | 'repl_node'
  | 'repl_psql'
  | 'multiplexer_tmux'
  | 'tui_vim'
  | 'tui_htop'
  | 'shell_nested';

export interface GhostHintEntry {
  /** Short human-readable instruction shown in the pill. */
  readonly text: string;
  /** Key sequences that dismiss the mode. Surfaced to screen readers. */
  readonly keys: readonly string[];
}

/**
 * Registry — authoritative table of hint kinds. Frozen so downstream callers
 * can't mutate it at runtime (the object reference is stable for equality
 * checks in `useMemo` hooks).
 */
export const GHOST_HINTS: Readonly<Record<GhostHintKind, GhostHintEntry>> = {
  pager_less: { text: 'press q to quit', keys: ['q'] },
  pager_man: { text: 'press q to quit', keys: ['q'] },
  repl_python: { text: 'exit() or ^D', keys: ['exit()', '^D'] },
  repl_node: { text: '.exit or ^D', keys: ['.exit', '^D'] },
  repl_psql: { text: '\\q to leave', keys: ['\\q'] },
  multiplexer_tmux: { text: 'C-b d to detach', keys: ['C-b d'] },
  tui_vim: { text: ':q to quit', keys: [':q'] },
  tui_htop: { text: 'q or F10 to quit', keys: ['q', 'F10'] },
  shell_nested: { text: 'exit to return', keys: ['exit'] },
} as const;

/**
 * Look up a registry entry by kind. Returns `undefined` for unknown kinds
 * so callers can decide whether to fall back (we choose "render nothing"
 * in `GhostHint`). Accepts a plain string for forward-compat with new
 * layer kinds that the registry doesn't yet know about.
 */
export function getGhostHint(kind: string): GhostHintEntry | undefined {
  return (GHOST_HINTS as Readonly<Record<string, GhostHintEntry>>)[kind];
}

/**
 * True iff `kind` is a known `GhostHintKind`. Narrows the string for
 * callers doing exhaustive checks.
 */
export function isGhostHintKind(kind: string): kind is GhostHintKind {
  return kind in GHOST_HINTS;
}
