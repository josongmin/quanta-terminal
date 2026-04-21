/**
 * Compat-fixture registry.
 *
 * Plan 0005 P0 Epic ε — scaffolding.
 *
 * Central record of every compat fixture shipped in-tree. Lets the
 * replay runner enumerate fixtures, lets tooling reference them by id,
 * and gives reviewers one place to see what's covered vs. what's still
 * a gap in the matrix.
 *
 * Full expected list of IDs lives in
 * `docs/plans/0005-sota-convergence/test-strategy.md` §1 (compat
 * matrix). Today only C-ED-01 is shipped; new fixtures are added here
 * as they land.
 */

export type CompatCategory =
  /** `C-ED-*` — interactive editors (vim, nvim, nano, helix). */
  | 'editor'
  /** `C-INT-*` — interactive REPLs (python, node, psql, ssh). */
  | 'interactive'
  /** `C-PG-*` — pagers (less, more, man, git log). */
  | 'pager'
  /** `C-SH-*` — shell loops (bash, zsh, fish) — pure main-buffer transcripts. */
  | 'shell'
  /** `C-TUI-*` — full-screen TUIs (htop, btop, k9s, fzf). */
  | 'tui';

export interface CompatFixture {
  readonly id: string;
  readonly category: CompatCategory;
  readonly fixtureDir: string;
  readonly description: string;
  /**
   * When true, the fixture is RED by design — pending another epic's
   * work. The integration test uses `test.fails(...)` instead of
   * `test(...)` for these.
   */
  readonly pending?: {
    readonly blockingEpic: string;
    readonly note: string;
  };
}

/**
 * Fixture registry. Keys are compat IDs.
 *
 * Note on `fixtureDir`: paths are relative to the repo root. The replay
 * harness resolves them against an absolute root at call time, so
 * consumers that want the full path should `path.resolve(repoRoot,
 * fixture.fixtureDir)`.
 */
export const COMPAT_FIXTURES: Readonly<Record<string, CompatFixture>> = {
  'C-ED-01': {
    id: 'C-ED-01',
    category: 'editor',
    fixtureDir: 'packages/ui/fixtures/compat/C-ED-01',
    description:
      'vim round-trip: main buffer byte-exact across DECSET 1049 alt-screen cycle. Green post Epic α.',
  },
  'C-PG-01': {
    id: 'C-PG-01',
    category: 'pager',
    fixtureDir: 'packages/ui/fixtures/compat/C-PG-01',
    description:
      'less /etc/passwd: alt-screen paint, scroll-down repaint, jump-to-end (END) status, clean 1049l exit restoring the main-buffer prompt.',
  },
  'C-MON-01': {
    id: 'C-MON-01',
    category: 'tui',
    fixtureDir: 'packages/ui/fixtures/compat/C-MON-01',
    description:
      'top 30s-style session: three alt-buffer repaint frames, clean 1049l exit. Scrollback ring stays at zero rows across the cycle (alt paints never leak into main scrollback).',
  },
  'C-ED-02': {
    id: 'C-ED-02',
    category: 'editor',
    fixtureDir: 'packages/ui/fixtures/compat/C-ED-02',
    description:
      'nvim with LSP diagnostic overlay: alt-buffer paint, status line SGR, inline-red marker preserved byte-for-byte across 1049 cycle.',
  },
  'C-MUX-01': {
    // `mux` isn't a category in the `CompatCategory` enum — tmux is
    // bucketed under `tui` (it is a full-screen TUI that happens to
    // manage panes). The fixture ID prefix keeps the matrix readable.
    id: 'C-MUX-01',
    category: 'tui',
    fixtureDir: 'packages/ui/fixtures/compat/C-MUX-01',
    description:
      'tmux new + split-horizontal + detach: alt-buffer cycle with status line SGR and inner-pane prompt after split paint.',
  },
  'C-IME-01': {
    id: 'C-IME-01',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-IME-01',
    description:
      'Korean 2-set IME commit: CJK grapheme cluster renders as width-2 leading + width-0 continuation; cursor advances by 2 per hangul.',
  },
  'C-SH-01': {
    id: 'C-SH-01',
    category: 'shell',
    fixtureDir: 'packages/ui/fixtures/compat/C-SH-01',
    description:
      'bash baseline: prompt + `ls`, `cd /tmp`, `pwd`, `echo $?`. Pure main-buffer loop — no alt-screen, no SGR. Verifies `\\r\\n` cursor advancement and multi-turn transcript rendering.',
  },
  'C-SH-02': {
    id: 'C-SH-02',
    category: 'shell',
    fixtureDir: 'packages/ui/fixtures/compat/C-SH-02',
    description:
      'zsh with a 91-character hostname-in-prompt: stresses DECAWM auto-wrap at cols=80 so the prompt spans row 0 + part of row 1 before the command echoes.',
  },
  'C-SH-03': {
    id: 'C-SH-03',
    category: 'shell',
    fixtureDir: 'packages/ui/fixtures/compat/C-SH-03',
    description:
      "fish autosuggest ghost text: `ls ` echoed, then autosuggestion `/tmp` written in SGR 90 (bright-black fg) with CSI 4 D pulling the cursor back. The ghost span's sgrDigest is the load-bearing byte-for-byte assertion.",
  },
  'C-ED-03': {
    id: 'C-ED-03',
    category: 'editor',
    fixtureDir: 'packages/ui/fixtures/compat/C-ED-03',
    description:
      "vim :!bash nested subshell. Inner bash runs INSIDE vim's alt-screen (no nested 1049h). `altScreen` flips exactly once — on the outer 1049h — and stays true through the bash lifecycle, flipping back only on :q!'s 1049l.",
  },
  'C-PG-02': {
    id: 'C-PG-02',
    category: 'pager',
    fixtureDir: 'packages/ui/fixtures/compat/C-PG-02',
    description:
      'man git-log: DECSET 1049h + SGR 1 bold section headers (NAME/SYNOPSIS) + reverse-video status line `Manual page git-log(1) line 1` + clean 1049l exit. sgrDigest locks the bold + inverse attributes byte-for-byte.',
  },
  'C-MON-02': {
    id: 'C-MON-02',
    category: 'tui',
    fixtureDir: 'packages/ui/fixtures/compat/C-MON-02',
    description:
      'htop 30s-style session: alt buffer + colored CPU bars (SGR 42/43) + colored process-state column + footer keybindings. Three repaint frames. Scrollback stays at zero rows; main buffer restored on q/1049l.',
  },
  'C-MON-03': {
    id: 'C-MON-03',
    category: 'tui',
    fixtureDir: 'packages/ui/fixtures/compat/C-MON-03',
    description:
      'watch -n 0.1 date: continuous repaint stress (60 frames). CSI K (erase-in-line) used for frame clears so no trailing-space pollution. Scrollback ring stays at zero rows across the entire cycle.',
  },
  'C-MUX-02': {
    id: 'C-MUX-02',
    category: 'tui',
    fixtureDir: 'packages/ui/fixtures/compat/C-MUX-02',
    description:
      'tmux-in-ssh depth 2: ssh localhost → tmux new. Remote banner visible, alt-buffer enter on tmux, inner prompt renders, clean 1049l exit returns to remote prompt, exit returns to local prompt.',
  },
  'C-MUX-03': {
    id: 'C-MUX-03',
    category: 'tui',
    fixtureDir: 'packages/ui/fixtures/compat/C-MUX-03',
    description:
      'tmux-in-ssh-in-tmux depth 3: single alt-buffer contract. Inner 1049h is a no-op (already alt). Inner 1049l exits alt unconditionally — main buffer shows pre-outer-tmux content. Canary for P1 ModeStack work.',
  },
  'C-IME-02': {
    id: 'C-IME-02',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-IME-02',
    description:
      'Japanese IME commit: こんにちは! — 5 hiragana (each width-2) + ASCII ! (width-1). Widths array asserts the leading-cell/continuation pattern.',
  },
  'C-IME-03': {
    id: 'C-IME-03',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-IME-03',
    description:
      'Chinese pinyin IME commit: 你好世界! — 4 CJK characters (each width-2) + ASCII ! (width-1). Echoed on row 2 with identical widths.',
  },
};

/** All IDs in insertion order — handy for `describe.each`-style runners. */
export const COMPAT_FIXTURE_IDS: readonly string[] = Object.keys(COMPAT_FIXTURES);
