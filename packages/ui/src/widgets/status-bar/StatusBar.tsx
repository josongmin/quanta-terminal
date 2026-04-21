/**
 * StatusBar — bottom chrome. Shows cwd, shell, and session health chip.
 *
 * Per ADR 0010, a cwd that is not shell-integrated renders with an `est`
 * Badge. The enum-driven presentation table (`HEALTH_PRESENTATION`,
 * `INTEGRATION_PRESENTATION`) keeps the JSX open-closed: new states add a
 * row, the render path does not change.
 *
 * Phase-1 additions:
 *   - a small session-active pulse next to the health dot (pulses when
 *     `health === 'ready'`);
 *   - a right-side keybind hint (`⌘K`) so new users see the palette
 *     shortcut even before opening it;
 *   - aria-labels on each chip (status role already in place via Badge).
 */

import { Badge } from '../../shared/ui/badge/index.js';
import { Tooltip } from '../../shared/ui/tooltip/index.js';
import { Kbd } from '../../shared/ui/kbd/index.js';
import { useSessionStore } from '../../entities/session/index.js';
import { cx } from '../../shared/lib/cx.js';
import { formatShortcutHint } from '../../shared/lib/keymap.js';
import { t } from '../../shared/i18n/index.js';
import { useGitBranch } from '../../features/git-branch/index.js';
import { RecordingIndicator } from '../../features/session-record/index.js';
import styles from './status-bar.module.css';
import type { SessionHealth } from '../../entities/session/index.js';
import type { ShellIntegrationStatus } from '@quanta/host-common';
import type { BadgeTone } from '../../shared/ui/badge/index.js';

type DotClass = 'dotReady' | 'dotBooting' | 'dotExited' | 'dotError';

interface HealthPresentation {
  readonly dot: DotClass;
  readonly label: string;
  readonly ariaLabel: string;
  readonly pulse: boolean;
}

const HEALTH_PRESENTATION: Readonly<Record<SessionHealth, HealthPresentation>> = {
  ready:   { dot: 'dotReady',   label: t('statusBar.ready'),   ariaLabel: t('statusBar.healthReady'),   pulse: true  },
  booting: { dot: 'dotBooting', label: t('statusBar.booting'), ariaLabel: t('statusBar.healthBooting'), pulse: false },
  exited:  { dot: 'dotExited',  label: t('statusBar.exited'),  ariaLabel: t('statusBar.healthExited'),  pulse: false },
  error:   { dot: 'dotError',   label: t('statusBar.error'),   ariaLabel: t('statusBar.healthError'),   pulse: false },
};

interface IntegrationPresentation {
  readonly label: string;
  readonly tone: BadgeTone;
  readonly tooltip: string;
  readonly srDescription: string;
}

const INTEGRATION_PRESENTATION: Readonly<
  Record<ShellIntegrationStatus, IntegrationPresentation>
> = {
  installed: {
    label: 'SI',
    tone: 'accent',
    tooltip: t('statusBar.siInstalledTooltip'),
    srDescription: t('statusBar.siInstalledSr'),
  },
  partial: {
    label: 'SI?',
    tone: 'warning',
    tooltip: t('statusBar.siPartialTooltip'),
    srDescription: t('statusBar.siPartialSr'),
  },
  missing: {
    label: 'est',
    tone: 'neutral',
    tooltip: t('statusBar.siMissingTooltip'),
    srDescription: t('statusBar.siMissingSr'),
  },
};

/** Hard cap on the rendered branch chip. Long branch names (e.g. Gerrit-
 *  generated `topic/team/long-slug/xyz`) would otherwise push the cwd chip
 *  off-screen on narrow windows. 24 chars matches the brief. */
const BRANCH_MAX_CHARS = 24;

export function StatusBar() {
  const shell = useSessionStore((s) => s.shell);
  const cwd = useSessionStore((s) => s.cwd);
  const health = useSessionStore((s) => s.health);
  const shellIntegration = useSessionStore((s) => s.shellIntegration);
  const exitCode = useSessionStore((s) => s.exitCode);
  const isWsl = useSessionStore((s) => s.isWsl);
  const gitInfo = useGitBranch(cwd || null);

  const healthView = HEALTH_PRESENTATION[health];
  const integration = INTEGRATION_PRESENTATION[shellIntegration];

  return (
    <div className={styles.bar} role="contentinfo" aria-label={t('statusBar.region')}>
      <div className={styles.group} aria-label={healthView.ariaLabel}>
        <span
          className={cx(
            styles.dot,
            styles[healthView.dot],
            healthView.pulse && styles.dotPulse,
          )}
          aria-hidden
        />
        <span className={styles.health}>{healthLabel(health, exitCode)}</span>
      </div>
      <div className={styles.group}>
        <Tooltip content={integration.tooltip}>
          <Badge
            label={integration.label}
            tone={integration.tone}
            srDescription={integration.srDescription}
          />
        </Tooltip>
        <span className={styles.cwd} aria-label={t('statusBar.cwdLabel', { cwd: cwd || 'unknown' })}>
          {prettyCwd(cwd)}
        </span>
        {gitInfo.isGitRepo && gitInfo.branch !== null ? (
          <GitBranchChip
            branch={gitInfo.branch}
            detached={gitInfo.detached}
            repoRoot={gitInfo.repoRoot ?? ''}
            dirty={gitInfo.dirty}
            ahead={gitInfo.ahead}
            behind={gitInfo.behind}
          />
        ) : null}
      </div>
      <div className={styles.grow} />
      <div className={styles.group}>
        <span className={styles.shell} aria-label={t('statusBar.shellLabel', { shell: shell || 'none' })}>
          {shell || '—'}
        </span>
        {isWsl && (
          <Tooltip content={t('statusBar.wslTooltip')}>
            <Badge
              label={t('statusBar.wslLabel')}
              tone="accent"
              srDescription={t('statusBar.wslSr')}
            />
          </Tooltip>
        )}
      </div>
      <div className={styles.group}>
        <RecordingIndicator />
      </div>
      <div className={styles.group} aria-label={t('statusBar.paletteShortcutLabel')}>
        <span className={styles.kbdHint}>
          <Kbd>{formatShortcutHint('mod+k')}</Kbd>
        </span>
      </div>
    </div>
  );
}

function healthLabel(h: SessionHealth, exitCode: number | null): string {
  if (h === 'exited' && exitCode !== null) return t('statusBar.exitedWithCode', { code: exitCode });
  return HEALTH_PRESENTATION[h].label;
}

function prettyCwd(cwd: string): string {
  if (!cwd) return '—';
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/u.exec(cwd);
  if (m) return '~' + (m[2] ?? '');
  return cwd;
}

StatusBar.displayName = 'StatusBar';

/**
 * GitBranchChip — inline git icon + branch name.
 *
 * Kept local to this module: the chip is a visual detail of the StatusBar,
 * not a reusable primitive. Phase 2 (dirty / ahead-behind) will likely
 * promote this if the UI grows.
 */
interface GitBranchChipProps {
  readonly branch: string;
  readonly detached: boolean;
  readonly repoRoot: string;
  /** `true` when the working tree is dirty; `null` when the host could not
   *  answer (no `gitStatus` capability, timeout, etc.) so the UI just
   *  omits the `*` suffix rather than implying "clean". */
  readonly dirty: boolean | null;
  /** Local-ahead-of-upstream commit count; `null` = unknown; `0` = in sync. */
  readonly ahead: number | null;
  /** Local-behind-upstream commit count; `null` = unknown. */
  readonly behind: number | null;
}

function GitBranchChip({
  branch,
  detached,
  repoRoot,
  dirty,
  ahead,
  behind,
}: GitBranchChipProps) {
  const truncated =
    branch.length > BRANCH_MAX_CHARS ? branch.slice(0, BRANCH_MAX_CHARS - 1) + '…' : branch;
  const dirtyMark = dirty === true ? '*' : '';
  const aheadMark = ahead !== null && ahead > 0 ? `↑${ahead}` : '';
  const behindMark = behind !== null && behind > 0 ? `↓${behind}` : '';
  const divergence = `${aheadMark}${behindMark}`;
  const tooltip = detached
    ? t('statusBar.gitBranchDetachedTooltip', { branch, repo: repoRoot })
    : buildStatusTooltip({ branch, repoRoot, dirty, ahead, behind });
  const srSuffix =
    (dirty === true ? ` ${t('statusBar.gitBranchDirtySr')}` : '') +
    (ahead !== null && ahead > 0 ? ` ${t('statusBar.gitBranchAheadSr', { count: ahead })}` : '') +
    (behind !== null && behind > 0 ? ` ${t('statusBar.gitBranchBehindSr', { count: behind })}` : '');
  return (
    <Tooltip content={tooltip}>
      <span
        className={cx(
          styles.gitBranch,
          detached && styles.detached,
          dirty === true && styles.dirty,
        )}
        role="status"
        aria-label={t('statusBar.gitBranchLabel', { branch }) + srSuffix}
        data-testid="git-branch-chip"
        tabIndex={0}
      >
        <GitBranchIcon />
        <span className={styles.gitBranchName}>{truncated}</span>
        {dirtyMark ? (
          <span className={styles.gitBranchDirty} aria-hidden data-testid="git-branch-dirty">
            {dirtyMark}
          </span>
        ) : null}
        {divergence ? (
          <span
            className={styles.gitBranchDivergence}
            aria-hidden
            data-testid="git-branch-divergence"
          >
            {divergence}
          </span>
        ) : null}
      </span>
    </Tooltip>
  );
}

/** Assemble the hover tooltip. Kept out of the component body so the string
 *  concatenation is easy to unit-test if we ever need to. */
function buildStatusTooltip(args: {
  readonly branch: string;
  readonly repoRoot: string;
  readonly dirty: boolean | null;
  readonly ahead: number | null;
  readonly behind: number | null;
}): string {
  const base = t('statusBar.gitBranchTooltip', { branch: args.branch, repo: args.repoRoot });
  const parts: string[] = [];
  if (args.dirty === true) parts.push(t('statusBar.gitBranchDirtyTooltip'));
  if (args.ahead !== null && args.ahead > 0) {
    parts.push(t('statusBar.gitBranchAheadTooltip', { count: args.ahead }));
  }
  if (args.behind !== null && args.behind > 0) {
    parts.push(t('statusBar.gitBranchBehindTooltip', { count: args.behind }));
  }
  if (parts.length === 0) return base;
  return `${base} — ${parts.join(', ')}`;
}

/**
 * Inline SVG so we don't add a new icon dependency. The shape is an
 * octicon-style branch glyph: two dots connected by a curved line. `currentColor`
 * lets the parent chip's color token drive the stroke.
 */
function GitBranchIcon() {
  return (
    <svg
      className={styles.gitIcon}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      focusable={false}
    >
      <path
        d="M5 2.5a1.5 1.5 0 1 0 0 3v5a1.5 1.5 0 1 0 1 0V9c0-.6.4-1 1-1h3a2.5 2.5 0 0 0 2.5-2.5V5.5a1.5 1.5 0 1 0-1 0v.034A1.5 1.5 0 0 1 10 7H7a2.5 2.5 0 0 0-1 .208V5.5A1.5 1.5 0 0 0 5 2.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
