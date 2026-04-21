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
  /**
   * `C-INT-*` + `C-IME-*` + `C-UX-*` + `C-COMB-*` — interactive REPLs
   * (python, node, psql, ssh), IME commits, UX contracts (clear,
   * bracketed paste), and multi-stage combinator pipelines
   * (`git log | less | head`, `find /`, `yes | head`). All share the
   * "interactive byte-stream" engine path; grouping them under one
   * category keeps the matrix readable without adding narrow buckets.
   */
  | 'interactive'
  /** `C-PG-*` — pagers (less, more, man, git log). */
  | 'pager'
  /** `C-SH-*` — shell loops (bash, zsh, fish) — pure main-buffer transcripts. */
  | 'shell'
  /**
   * `C-STRESS-*` — engine stress fixtures. Heavy main-buffer volume
   * (tail/base64, cat, ls transcripts) that forces scrollback-ring
   * growth and eviction + DPR-change sanity. Distinct from `shell`
   * (baseline correctness) and `tui` (alt-buffer behaviour) — stress
   * fixtures assert the RING itself stays bounded under load.
   */
  | 'stress'
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
  'C-IME-04': {
    id: 'C-IME-04',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-IME-04',
    description:
      'Dead-key European composition: `$ echo café résumé` — é (UTF-8 0xC3 0xA9) classified as BMP Latin-1 width-1, NOT wide. Sanity check for width classifier BMP fallback.',
  },
  'C-PG-03': {
    id: 'C-PG-03',
    category: 'pager',
    fixtureDir: 'packages/ui/fixtures/compat/C-PG-03',
    description:
      'more /etc/hosts: main-buffer-only pager (no DECSET 1049), reverse-video --More-- status, clean CSI K exit. Contrasts with C-PG-01 (less, alt-buffer pager).',
  },
  'C-NET-01': {
    id: 'C-NET-01',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-NET-01',
    description:
      'ssh localhost echo hi: non-interactive SSH round-trip — local prompt → ssh command → remote `hi` output → clean disconnect → local prompt. Engine sees ssh as a transparent byte stream; altScreen stays false throughout.',
  },
  'C-NET-02': {
    id: 'C-NET-02',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-NET-02',
    description:
      'Remote bash over ssh with `cd /etc; ls`: multi-turn interactive session, MOTD banner, `user@host:` prompt shape, cwd-via-prompt heuristic on `cd /etc`, `ls` output containing `passwd`, clean `exit`. P1-SI replaces the prompt-match cwd check with OSC 7.',
  },
  'C-RP-01': {
    id: 'C-RP-01',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-RP-01',
    description:
      'python3 multi-line `def` block: primary `>>> ` + continuation `... ` prompt cycle, function call + `42` result, clean `exit()`. Banner trimmed to fit 60 cols without wrap.',
  },
  'C-RP-02': {
    id: 'C-RP-02',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-RP-02',
    description:
      'node REPL bracketed-paste block: `CSI 200~`/`CSI 201~` delimiters silently consumed by the parser, pasted arrow-function + call land inline on rows 3-6, result `5` on row 7, clean `.exit`. Canary for future bracketed-paste state tracking.',
  },
  'C-RP-03': {
    id: 'C-RP-03',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-RP-03',
    description:
      'psql `mydb=> ` prompt shape + `SELECT 1;` round-trip: banner, idle prompt, result table (header/rule/value/row count), clean `\\q`. Transaction-aware prompt variants (`=*`, `->`) deferred to P1.',
  },
  // ---- Plan 0005 P0 Gate #6 batch: stress / UX / combinator fixtures. ----
  // Categories: C-STRESS-* → `stress` (new — eviction-ring focus); C-UX-*
  // + C-COMB-* → `interactive` (reuse — see CompatCategory jsdoc).
  //
  // C-UX-02 (resize 200×50 ↔ 80×24, 10 cycles) landed in the Gate #6
  // CLOSING pass once the compat harness grew an in-stream `resize`
  // hook (see `CheckpointExpected.resize` in `compat-replay.ts`).
  //
  // Still skipped from the original Gate #6 slate:
  //   - C-UX-04 (split pane) — a true multi-pane scenario needs two
  //     independent sessions; the "alt-buffer split" variant is already
  //     covered by C-MUX-01 + C-MUX-02.
  'C-STRESS-01': {
    id: 'C-STRESS-01',
    category: 'stress',
    fixtureDir: 'packages/ui/fixtures/compat/C-STRESS-01',
    description:
      '`tail -f /dev/urandom | base64` 30s-style stress: 100 base64-lookalike rows (~7.8 KB) force the main-buffer scroll-up path + scrollback-ring growth. droppedBytes stays 0 (enforced globally by harness-audit).',
  },
  'C-STRESS-02': {
    id: 'C-STRESS-02',
    category: 'stress',
    fixtureDir: 'packages/ui/fixtures/compat/C-STRESS-02',
    description:
      '`cat /tmp/100mb.log` with 15 000 rows forces scrollback eviction past the 10 000-row default cap. rowCount pinned at the cap; evictedCount ≈ 4 978 at fixture end.',
  },
  'C-STRESS-03': {
    id: 'C-STRESS-03',
    category: 'stress',
    fixtureDir: 'packages/ui/fixtures/compat/C-STRESS-03',
    description:
      'DPR-change mid-session sanity: emulator state (cursor, widths, SGR) is unaffected by hypothetical device-pixel-ratio transitions. Real atlas-invalidation lives in FontAtlas tests; this fixture locks the engine baseline with a minimal `ls --color=auto` transcript.',
  },
  'C-UX-01': {
    id: 'C-UX-01',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-UX-01',
    description:
      '`clear` behaviour: CSI H + CSI 2J wipes the visible grid and homes the cursor. Scrollback survives (no CSI 3J emitted). Verifies the baseline `clear` contract used by every shell + bash-in-SSH deployment.',
  },
  'C-UX-02': {
    // Categorised under `interactive` alongside the other C-UX-* entries
    // for consistency with the CompatCategory jsdoc ("UX contracts"). No
    // dedicated `ux` bucket — the matrix is readable without one and the
    // fixture IDs already encode the sub-domain.
    id: 'C-UX-02',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-UX-02',
    description:
      'Resize cycle: 10 alternating resizes between 80×24 and 200×50 (5 round-trips). Exercises the compat harness in-stream `resize` hook; verifies main-buffer content reflows + is preserved byte-exact at pinned rows, cursor clamped, scrollback untouched.',
  },
  'C-UX-03': {
    id: 'C-UX-03',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-UX-03',
    description:
      'Bracketed-paste (DECSET 2004) round-trip: `CSI 200 ~` + `hello world!` + `CSI 201 ~`. Pasted text renders normally; the markers are consumed as control bytes and never appear in the grid.',
  },
  'C-COMB-01': {
    id: 'C-COMB-01',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-COMB-01',
    description:
      '`git log | less | head -20`: pipe + pager + head combinator. less enters alt, paints 20 commit rows, exits on EOF. Alt-buffer content never leaks to the scrollback ring.',
  },
  'C-COMB-02': {
    id: 'C-COMB-02',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-COMB-02',
    description:
      '`find / 2>/dev/null` timeboxed to 800 pathnames: main-buffer scroll-up + scrollback-ring stress. altScreen stays false; ring captures ~778 rows without emergency drops.',
  },
  'C-COMB-03': {
    id: 'C-COMB-03',
    category: 'interactive',
    fixtureDir: 'packages/ui/fixtures/compat/C-COMB-03',
    description:
      '`yes | head -c 1G` lightweight (50 000 × `y\\r\\n`): scrollback-ring cap under 5× overflow. rowCount pinned at 10 000; droppedBytes stays 0.',
  },
};

/** All IDs in insertion order — handy for `describe.each`-style runners. */
export const COMPAT_FIXTURE_IDS: readonly string[] = Object.keys(COMPAT_FIXTURES);
