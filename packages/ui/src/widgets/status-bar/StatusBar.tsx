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
  ready:   { dot: 'dotReady',   label: 'ready',   ariaLabel: 'Session is ready',   pulse: true  },
  booting: { dot: 'dotBooting', label: 'booting', ariaLabel: 'Session is starting', pulse: false },
  exited:  { dot: 'dotExited',  label: 'exited',  ariaLabel: 'Session has exited', pulse: false },
  error:   { dot: 'dotError',   label: 'error',   ariaLabel: 'Session errored',    pulse: false },
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
    tooltip: 'Quanta knows the current working directory because shell integration is installed.',
    srDescription: 'shell integration active',
  },
  partial: {
    label: 'SI?',
    tone: 'warning',
    tooltip: 'Shell integration is partial. Some prompts are captured; cwd tracking may estimate.',
    srDescription: 'shell integration partial',
  },
  missing: {
    label: 'est',
    tone: 'neutral',
    tooltip: 'cwd is estimated. Install shell integration for authoritative tracking.',
    srDescription: 'cwd is estimated from prompt text',
  },
};

export function StatusBar() {
  const shell = useSessionStore((s) => s.shell);
  const cwd = useSessionStore((s) => s.cwd);
  const health = useSessionStore((s) => s.health);
  const shellIntegration = useSessionStore((s) => s.shellIntegration);
  const exitCode = useSessionStore((s) => s.exitCode);

  const healthView = HEALTH_PRESENTATION[health];
  const integration = INTEGRATION_PRESENTATION[shellIntegration];

  return (
    <div className={styles.bar} role="contentinfo" aria-label="Session status">
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
        <span className={styles.cwd} aria-label={`Working directory: ${cwd || 'unknown'}`}>
          {prettyCwd(cwd)}
        </span>
      </div>
      <div className={styles.grow} />
      <div className={styles.group}>
        <span className={styles.shell} aria-label={`Shell: ${shell || 'none'}`}>
          {shell || '—'}
        </span>
      </div>
      <div className={styles.group} aria-label="Open command palette shortcut">
        <span className={styles.kbdHint}>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </div>
    </div>
  );
}

function healthLabel(h: SessionHealth, exitCode: number | null): string {
  if (h === 'exited' && exitCode !== null) return `exited ${exitCode}`;
  return HEALTH_PRESENTATION[h].label;
}

function prettyCwd(cwd: string): string {
  if (!cwd) return '—';
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/u.exec(cwd);
  if (m) return '~' + (m[2] ?? '');
  return cwd;
}

StatusBar.displayName = 'StatusBar';
