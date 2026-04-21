import { useEffect, useRef } from 'react';
import type { CompletionEntry } from '@quanta/host-common';
import { cx } from '../../shared/lib/cx.js';
import styles from './completion-popup.module.css';

export interface CompletionPopupProps {
  readonly items: readonly CompletionEntry[];
  readonly activeIndex: number;
  readonly namePrefix: string;
  readonly onSelect: (item: CompletionEntry) => void;
  readonly onSetActive: (index: number) => void;
}

function DirIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M1 3.5C1 2.67 1.67 2 2.5 2H4.79L5.5 3H9.5C10.33 3 11 3.67 11 4.5V8.5C11 9.33 10.33 10 9.5 10H2.5C1.67 10 1 9.33 1 8.5V3.5Z" fill="currentColor" opacity="0.85"/>
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <rect x="2" y="1" width="6" height="10" rx="1" fill="currentColor" opacity="0.6"/>
      <path d="M8 1L11 4H8V1Z" fill="currentColor" opacity="0.85"/>
    </svg>
  );
}

function ExecIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <polygon points="2,2 10,6 2,10" fill="currentColor" opacity="0.85"/>
    </svg>
  );
}

function HighlightedName({ name, prefix }: { name: string; prefix: string }) {
  if (!prefix || !name.toLowerCase().startsWith(prefix.toLowerCase())) {
    return <span className={styles.name}>{name}</span>;
  }
  return (
    <span className={styles.name}>
      <span className={styles.nameMatch}>{name.slice(0, prefix.length)}</span>
      {name.slice(prefix.length)}
    </span>
  );
}

export function CompletionPopup({
  items,
  activeIndex,
  namePrefix,
  onSelect,
  onSetActive,
}: CompletionPopupProps) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (items.length === 0) return null;

  return (
    <div
      className={styles.popup}
      role="listbox"
      aria-label="Path completions"
      data-testid="completion-popup"
    >
      <div className={styles.header}>
        <span className={styles.headerLabel}>Completions</span>
        <span className={styles.headerHint}>↑↓ Tab · Esc</span>
      </div>
      <div className={styles.list}>
        {items.map((item, idx) => (
          <div
            key={item.insert}
            ref={idx === activeIndex ? activeRef : undefined}
            role="option"
            aria-selected={idx === activeIndex}
            data-active={idx === activeIndex ? 'true' : 'false'}
            className={styles.item}
            onMouseEnter={() => onSetActive(idx)}
            onClick={() => onSelect(item)}
          >
            <span className={cx(styles.icon, item.kind === 'dir' ? styles.iconDir : item.kind === 'exec' ? styles.iconExec : styles.iconFile)}>
              {item.kind === 'dir' ? <DirIcon /> : item.kind === 'exec' ? <ExecIcon /> : <FileIcon />}
            </span>
            <HighlightedName name={item.name} prefix={namePrefix} />
            {item.kind === 'dir' && <span className={styles.kind}>dir</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
