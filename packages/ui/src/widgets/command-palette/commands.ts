/**
 * Commands — the palette's in-memory catalogue. Phase 1 ships with a fixed
 * set of placeholders (session new/close, focus terminal, toggle help). A
 * later phase lets features contribute commands via a registry.
 *
 * Sections map directly to the visual groupings; the palette renders each
 * section with a heading when it has at least one matching command.
 *
 * Keyboard hints
 * --------------
 * Hints are stored as `accelerator` strings (`'mod+t'`, `'mod+shift+p'`) and
 * resolved through `formatShortcutHint()` at render time so the palette picks
 * up the correct per-platform rendering automatically. The legacy `hint`
 * array-of-strings (e.g. `['⌘', 'T']`) stays supported for tests and call
 * sites that want to supply custom glyph chips, but new entries should use
 * `accelerator`.
 */

import { formatShortcutHint } from '../../shared/lib/keymap.js';
// FIXME(fsd-layer-skip): the palette is the canonical catalogue for
// user-facing actions; the start/stop recording entries dispatch directly
// into the session-record feature singleton.
import {
  toggleRecording,
  isRecording,
} from '../../features/session-record/index.js';
// FIXME(fsd-layer-skip): tag-filter clear dispatches directly into the
// block-filter entity store. No feature wrapper exists — the entity store
// exposes `clear()` as its public action.
import { useBlockFilterStore } from '../../entities/block-filter/index.js';
// FIXME(fsd-layer-skip): pane-zoom toggle dispatches directly into the
// pane entity store. The palette's palette-runs-command path fires
// window.dispatchEvent in other entries (tag editor); here we just call
// the store mutator directly because the aria-live announce is driven by
// the store subscription in TerminalPage and doesn't need a dom event.
import { usePaneStore } from '../../entities/pane/index.js';
// FIXME(fsd-layer-skip): AI explain-last-failure picks the most recent
// failed block via the block entity store and fires a DOM event the
// AiExplainPanel listens for. Same pattern as the tag-editor entry above.
import {
  createExplainLastFailureCommand,
  EXPLAIN_LAST_FAILURE_COMMAND_ID,
} from '../../features/ai-explain/index.js';
// FIXME(fsd-layer-skip): workspace-snapshot save/restore/delete/toggle
// commands dispatch directly into the feature's store + high-level helpers.
import {
  saveNamedSnapshot,
  useWorkspaceSnapshotStore,
  splitSnapshots,
} from '../../features/workspace-snapshot/index.js';
import { restoreSnapshot as restoreWorkspaceSnapshot } from '../../features/workspace-snapshot/serialize.js';
import { tryGetHostBridge } from '../../shared/api/host-bridge.js';
import { showToast } from '../../shared/ui/toast/index.js';

export type CommandSection = 'sessions' | 'actions' | 'history';

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly section: CommandSection;
  /**
   * Platform-agnostic shortcut spec (`'mod+t'`, `'mod+shift+p'`). The palette
   * resolves this to a single display string via `formatShortcutHint` so the
   * same command renders `⌘T` on macOS and `Ctrl+T` elsewhere.
   */
  readonly accelerator?: string;
  /**
   * Legacy keyboard hint: explicit glyph chips (e.g. `['⌘', 'T']`). Retained
   * for existing tests and dynamically-built commands that don't fit the
   * `mod+X` mold. When both `accelerator` and `hint` are set, `accelerator`
   * wins — the palette derives the chip list from it.
   */
  readonly hint?: readonly string[];
  /** Short description shown below the label. */
  readonly description?: string;
  /** Stub action: Phase 1 handlers just console.log. */
  readonly run?: () => void;
}

export function getDefaultCommands(): readonly Command[] {
  const recording = isRecording();
  return [
    {
      id: 'sessions.new',
      label: 'New session',
      section: 'sessions',
      accelerator: 'mod+t',
      description: 'Open a new shell in the current working directory',
    },
    {
      id: 'sessions.close',
      label: 'Close session',
      section: 'sessions',
      accelerator: 'mod+w',
      description: 'End the active shell — confirmation required',
    },
    // Session recording — the id flips between start/stop so the palette
    // catalogue reflects the live state. Running a single `toggleRecording`
    // handler in both cases keeps the shortcut (mod+shift+r) and the palette
    // in lockstep.
    {
      id: recording ? 'sessions.stop-recording' : 'sessions.start-recording',
      label: recording ? 'Session: Stop recording' : 'Session: Start recording',
      section: 'sessions',
      accelerator: 'mod+shift+r',
      description: recording
        ? 'End the asciicast capture and open the save dialog'
        : 'Capture all output from the active shell as an asciicast .cast file',
      run: () => toggleRecording(),
    },
    {
      id: 'actions.focus-terminal',
      label: 'Focus terminal',
      section: 'actions',
      accelerator: 'mod+`',
      description: 'Move keyboard focus to the terminal surface',
    },
    {
      id: 'actions.clear',
      label: 'Clear terminal',
      section: 'actions',
      accelerator: 'mod+k',
      description: 'Send a clear sequence to the active shell',
    },
    {
      id: 'actions.open-settings',
      label: 'Open settings',
      section: 'actions',
      description: 'Preferences, keymap, and appearance',
    },
    // Block tagging — dispatches a DOM event the focused card listens for.
    // This keeps the palette decoupled from the block-card widget (palette
    // lives above widgets in the FSD layering). The event name is stable and
    // documented in BlockCard.
    {
      id: 'actions.tag-active-block',
      label: t('palette.tagActiveBlock'),
      section: 'actions',
      accelerator: 't',
      description: t('palette.tagActiveBlock.description'),
      run: () => {
        if (typeof window === 'undefined') return;
        window.dispatchEvent(new CustomEvent('quanta:open-tag-editor'));
      },
    },
    {
      id: 'actions.clear-tag-filter',
      label: t('palette.clearTagFilter'),
      section: 'actions',
      description: t('palette.clearTagFilter.description'),
      run: () => {
        useBlockFilterStore.getState().clear();
      },
    },
    // "Copy block as Markdown" — routes to the BlockCard that owns the
    // currently-focused subtree via a DOM event. The widget layer reads
    // `window.getSelection()` + scopes to its article so the same entry
    // point handles both "copy whole block" and "copy selection inside
    // this block". Mirrors the 'actions.tag-active-block' pattern.
    {
      id: 'actions.copy-block-as-markdown',
      label: t('palette.copyBlockAsMarkdown'),
      section: 'actions',
      accelerator: 'mod+shift+c',
      description: t('palette.copyBlockAsMarkdown.description'),
      run: () => {
        if (typeof window === 'undefined') return;
        window.dispatchEvent(new CustomEvent('quanta:copy-block-as-markdown'));
      },
    },
    // Pane zoom — toggle the focused pane between maximized and restored.
    // Dispatches straight into the pane store; the aria-live announcer in
    // TerminalPage picks the state change up via its store subscription,
    // so the palette entry and the keyboard shortcut emit identical
    // announcements with no extra plumbing.
    {
      id: 'pane.zoom',
      label: t('paneLayout.zoomToggle'),
      section: 'actions',
      accelerator: 'mod+shift+enter',
      description: t('paneLayout.zoomToggleDescription'),
      run: () => {
        const state = usePaneStore.getState();
        if (!state.root) return;
        // Same single-pane guard as the keybinding handler — toggling a
        // one-leaf tree would be a no-op and would needlessly emit an
        // a11y announcement.
        if (state.root.kind === 'leaf' && state.zoomedPaneId === null) return;
        state.toggleZoomFocusedPane();
      },
    },
    // "Explain last failure" — find the most recent failed block and
    // dispatch the explain event. The corresponding panel, if mounted,
    // re-uses its own state machine to surface the response.
    (() => {
      const cmd = createExplainLastFailureCommand();
      const entry: Command = {
        id: EXPLAIN_LAST_FAILURE_COMMAND_ID,
        label: cmd.label,
        section: 'actions',
        ...(cmd.description !== undefined ? { description: cmd.description } : {}),
        ...(cmd.run !== undefined ? { run: cmd.run } : {}),
      };
      return entry;
    })(),
    // Workspace snapshots — save / restore / delete / toggle auto-restore.
    // Restore / delete use window.prompt for the name picker; the Settings
    // panel's Workspace snapshots section offers a full list with buttons.
    // We keep the palette entries for keyboard-driven users who never open
    // Settings. The commands mirror "Save / Restore / Delete snapshot" in the
    // spec.
    {
      id: 'workspace.save-snapshot',
      label: t('workspaceSnapshot.palette.save'),
      section: 'actions',
      description: t('workspaceSnapshot.palette.save.description'),
      run: () => {
        if (typeof window === 'undefined') return;
        const name = window.prompt(t('workspaceSnapshot.prompt.saveName'), '');
        if (name === null) return;
        const trimmed = name.trim();
        if (trimmed.length === 0) return;
        void saveNamedSnapshot(trimmed)
          .then(() => {
            showToast({ kind: 'info', message: t('workspaceSnapshot.toast.saved', { name: trimmed }) });
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            showToast({ kind: 'warning', message: msg });
          });
      },
    },
    {
      id: 'workspace.restore-snapshot',
      label: t('workspaceSnapshot.palette.restore'),
      section: 'actions',
      description: t('workspaceSnapshot.palette.restore.description'),
      run: () => {
        if (typeof window === 'undefined') return;
        const { named, auto } = splitSnapshots(
          useWorkspaceSnapshotStore.getState().snapshots,
        );
        if (named.length === 0 && !auto) {
          showToast({ kind: 'info', message: t('workspaceSnapshot.toast.empty') });
          return;
        }
        const picker = window.prompt(
          t('workspaceSnapshot.prompt.restoreName'),
          named[0]?.name ?? '',
        );
        if (picker === null) return;
        const trimmed = picker.trim();
        const match =
          named.find((s) => s.name === trimmed) ??
          (auto && (trimmed === auto.name || trimmed === auto.id) ? auto : null);
        if (!match) {
          showToast({ kind: 'warning', message: t('workspaceSnapshot.toast.notFound', { name: trimmed }) });
          return;
        }
        const bridge = tryGetHostBridge();
        void restoreWorkspaceSnapshot({
          snapshot: match,
          ...(bridge ? { bridge } : {}),
        })
          .then(() => {
            showToast({ kind: 'info', message: t('workspaceSnapshot.toast.restored', { name: match.name }) });
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            showToast({ kind: 'warning', message: msg });
          });
      },
    },
    {
      id: 'workspace.delete-snapshot',
      label: t('workspaceSnapshot.palette.delete'),
      section: 'actions',
      description: t('workspaceSnapshot.palette.delete.description'),
      run: () => {
        if (typeof window === 'undefined') return;
        const { named } = splitSnapshots(
          useWorkspaceSnapshotStore.getState().snapshots,
        );
        if (named.length === 0) {
          showToast({ kind: 'info', message: t('workspaceSnapshot.toast.empty') });
          return;
        }
        const picker = window.prompt(
          t('workspaceSnapshot.prompt.deleteName'),
          named[0]?.name ?? '',
        );
        if (picker === null) return;
        const trimmed = picker.trim();
        const match = named.find((s) => s.name === trimmed);
        if (!match) {
          showToast({ kind: 'warning', message: t('workspaceSnapshot.toast.notFound', { name: trimmed }) });
          return;
        }
        void useWorkspaceSnapshotStore
          .getState()
          .deleteSnapshot(match.id)
          .then(() => {
            showToast({ kind: 'info', message: t('workspaceSnapshot.toast.deleted', { name: match.name }) });
          });
      },
    },
    {
      id: 'workspace.toggle-auto-restore',
      label: t('workspaceSnapshot.palette.toggleAutoRestore'),
      section: 'actions',
      description: t('workspaceSnapshot.palette.toggleAutoRestore.description'),
      run: () => {
        const state = useWorkspaceSnapshotStore.getState();
        const next = !state.autoRestore;
        state.setAutoRestore(next);
        showToast({
          kind: 'info',
          message: next
            ? t('workspaceSnapshot.toast.autoRestoreOn')
            : t('workspaceSnapshot.toast.autoRestoreOff'),
        });
      },
    },
  ];
}

/**
 * Resolve a command's hint into a list of display chips for the palette to
 * render via `<Kbd>` elements. Precedence: `accelerator` → split the formatted
 * hint into chip-sized pieces (`⌘K` stays one chip on macOS; `Ctrl+K` splits
 * into `['Ctrl', 'K']` on non-macOS). Falls back to the legacy `hint` array
 * when no accelerator is supplied.
 */
export function getCommandHintChips(cmd: Command): readonly string[] {
  if (cmd.accelerator) {
    const formatted = formatShortcutHint(cmd.accelerator);
    if (formatted.includes('+')) return formatted.split('+');
    return [formatted];
  }
  return cmd.hint ?? [];
}

/**
 * Fuzzy character-sequence score. Returns 0 if not all query chars appear in
 * order inside `target`, otherwise a [0, 1] score where 1 = consecutive
 * prefix match.
 *
 * Algorithm: find each query char greedily (leftmost), track coverage density
 * (consecutive runs score higher) and a start bonus for matching at position 0.
 */
function charSeqScore(query: string, target: string): number {
  if (query.length === 0) return 0;
  let qi = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  let consecutiveBonus = 0;
  let prevMatchAt = -1;

  for (let i = 0; i < target.length && qi < query.length; i += 1) {
    if (target[i] === query[qi]) {
      if (firstMatch === -1) firstMatch = i;
      if (prevMatchAt === i - 1) consecutiveBonus += 1;
      prevMatchAt = i;
      lastMatch = i;
      qi += 1;
    }
  }

  if (qi < query.length) return 0;

  const span = lastMatch - firstMatch + 1;
  const density = query.length / span;
  const startBonus = firstMatch === 0 ? 0.15 : 0;
  const consBonus = (consecutiveBonus / Math.max(1, query.length - 1)) * 0.1;
  return Math.min(1, density * 0.75 + startBonus + consBonus);
}

/**
 * Score a command against a query. Returns a priority value:
 *   1.00  exact label match
 *   0.92  label starts with query
 *   0.80  label contains query as substring
 *   0.55  all query words are prefixes of label words (e.g. "new ses" → "New session")
 *   0.40  fuzzy char-sequence match on label
 *   0.25  description contains query
 *   0.10  fuzzy char-sequence match on description
 *   0.00  no match
 */
function scoreCommand(cmd: Command, q: string): number {
  const label = cmd.label.toLowerCase();
  const desc = (cmd.description ?? '').toLowerCase();

  if (label === q) return 1.0;
  if (label.startsWith(q)) return 0.92;
  if (label.includes(q)) return 0.80;

  // Word-prefix match: every space-separated token in the query must be a
  // prefix of some word in the label. "new ses" matches "New session".
  const queryWords = q.split(/\s+/u).filter(Boolean);
  if (queryWords.length > 1 || !label.includes(q)) {
    const labelWords = label.split(/\s+/u);
    let allMatch = queryWords.length > 0;
    for (const qw of queryWords) {
      if (!labelWords.some((lw) => lw.startsWith(qw))) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return 0.55;
  }

  const fuzzyLabel = charSeqScore(q, label);
  if (fuzzyLabel > 0) return 0.40 * fuzzyLabel;

  if (desc.includes(q)) return 0.25;

  const fuzzyDesc = charSeqScore(q, desc);
  if (fuzzyDesc > 0) return 0.10 * fuzzyDesc;

  return 0;
}

/**
 * Filter the catalogue against a query and rank by relevance score.
 * Empty query returns the full set (preserving original order).
 *
 * Scoring tiers (highest → lowest):
 *   exact label · label-prefix · label-substring · word-prefix ·
 *   fuzzy-label · description-substring · fuzzy-description
 */
export function filterCommands(
  commands: readonly Command[],
  query: string,
): readonly Command[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return commands;

  return commands
    .map((c) => ({ c, score: scoreCommand(c, q) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.c.label.localeCompare(b.c.label))
    .map(({ c }) => c);
}

import { t } from '../../shared/i18n/index.js';

export const SECTION_ORDER: readonly CommandSection[] = ['sessions', 'actions', 'history'];
export const SECTION_TITLE: Readonly<Record<CommandSection, string>> = {
  sessions: t('commandPalette.section.sessions'),
  actions: t('commandPalette.section.actions'),
  history: t('commandPalette.section.history'),
};
