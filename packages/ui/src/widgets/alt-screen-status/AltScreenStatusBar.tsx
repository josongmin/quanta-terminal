/**
 * AltScreenStatusBar — thin, single-row status line that replaces the
 * BlockCard chrome while an alt-screen application is active.
 *
 * Visible text (RFC §7.7):
 *   - Outer program:       `{command} · {session} · Ctrl-D exits`
 *   - Nested (depth ≥ 2):  `{inner} in {outer} · {session}`
 *   - Crashed program:     `{command} exited with signal {N}` (ghost window)
 *
 * The bar mounts unconditionally inside `TerminalPage`; it uses CSS
 * visibility + opacity to fade in/out without a mount flicker. That way the
 * 160 ms fade — RFC §7.7 — is a single CSS transition rather than a mount
 * race. `prefers-reduced-motion` is honored via a CSS media query; the
 * `preferences.altScreenTransition === 'instant'` knob flips a data
 * attribute that overrides the transition with `none`.
 *
 * Props:
 *   - `command`       : current alt-screen label; "" hides the bar.
 *   - `sessionId`     : short session id shown after the command.
 *   - `alternatePrograms?`: when present, overrides the label (used to
 *                          synthesize "vim in tmux" in nested mode; this is
 *                          mostly informational — the store's `command` is
 *                          usually the same value).
 *   - `depth`         : current nesting depth (0 = inactive, 1 = outermost).
 *   - `crashed?`      : set while holding the ghost frame — shows the exit
 *                        reason in danger tone.
 *   - `transition?`   : `'instant' | 'fade'`. Default `'fade'` honors the
 *                        standard 160 ms timing. `'instant'` is set by the
 *                        page when the user picked that preference.
 */

import type { CSSProperties } from 'react';
import { cx } from '../../shared/lib/cx.js';
import { t } from '../../shared/i18n/index.js';
import styles from './alt-screen-status.module.css';

export type AltScreenTransition = 'instant' | 'fade';

export interface AltScreenStatusBarProps {
  readonly command: string;
  readonly sessionId: string | null;
  readonly depth: number;
  readonly crashed?: { readonly reason: string } | null;
  readonly alternatePrograms?: readonly string[];
  readonly transition?: AltScreenTransition;
  readonly className?: string;
  readonly style?: CSSProperties;
}

function shortSessionLabel(id: string | null): string {
  if (!id) return '';
  // Tabs show a short tail of the session id; mirror that here so the bar
  // matches the chip the user sees in the tab row.
  if (id.length <= 8) return id;
  return id.slice(-8);
}

export function AltScreenStatusBar(props: AltScreenStatusBarProps): JSX.Element {
  const {
    command,
    sessionId,
    depth,
    crashed,
    alternatePrograms,
    transition = 'fade',
    className,
    style,
  } = props;
  const visible = command !== '' || (crashed !== null && crashed !== undefined);
  const sessionLabel = shortSessionLabel(sessionId);

  let labelNode: JSX.Element;
  if (crashed) {
    const text = t('altScreenStatus.exitedWithSignal', {
      command: command || '(program)',
      signal: crashed.reason,
    });
    labelNode = <span className={styles.command}>{text}</span>;
  } else if (alternatePrograms && alternatePrograms.length >= 2) {
    const [inner, outer] = alternatePrograms;
    labelNode = (
      <span className={styles.command}>
        {t('altScreenStatus.nested', { inner: inner ?? '', outer: outer ?? '' })}
      </span>
    );
  } else {
    labelNode = <span className={styles.command}>{command}</span>;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t('altScreenStatus.ariaLabel')}
      className={cx(styles.bar, visible ? styles.visible : undefined, className)}
      data-testid="alt-screen-status-bar"
      data-crashed={crashed ? 'true' : 'false'}
      data-depth={String(depth)}
      data-transition={transition}
      data-visible={visible ? 'true' : 'false'}
      style={style}
    >
      <span className={styles.label}>
        {labelNode}
        {sessionLabel ? (
          <>
            <span aria-hidden> · </span>
            <span className={styles.session}>{sessionLabel}</span>
          </>
        ) : null}
      </span>
      {depth > 1 ? (
        <span className={styles.depthBadge} data-testid="alt-screen-status-depth">
          depth {depth}
        </span>
      ) : null}
      {!crashed ? <span className={styles.hint}>{t('altScreenStatus.hint')}</span> : null}
    </div>
  );
}

AltScreenStatusBar.displayName = 'AltScreenStatusBar';
