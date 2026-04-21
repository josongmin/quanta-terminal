/**
 * Plan 0005 P1-C — BlockOverlay widget tests.
 *
 * Exercises the pure presentation layer with plain fixtures (no store,
 * no bridge). The overlay must:
 *
 *   - Project row ranges to pixel rects via a deterministic formula.
 *   - Skip blocks whose startRow is outside the live scrollback window.
 *   - Render one `<article>` per visible block with the right data-attrs.
 *   - Style cards by confidence tier (authoritative / heuristic / idle /
 *     synthetic default) via the `data-confidence` attribute.
 *   - Render exit code only on terminal blocks with a non-null code.
 *   - Compute a fallback duration from `completedAt - startedAt` when
 *     `durationMs` is null.
 *   - Clamp card height to `maxHeightPx` when provided, with a 16 px floor.
 *   - Stretch a still-open range (`endRowExclusive: null`) to the ring tail.
 *   - Handle an empty `blocks` list without throwing.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BlockOverlay, projectRowRange, formatDuration, formatCwd } from '../BlockOverlay.js';
import type { BlockOverlayItem } from '../BlockOverlay.js';

function makeItem(overrides: Partial<BlockOverlayItem> = {}): BlockOverlayItem {
  // Use `in` checks for fields that legitimately carry explicit `null` in
  // tests (e.g. confidence fallback, durationMs computed from start+end);
  // `??` would collapse those nulls to the default.
  return {
    id: overrides.id ?? 'blk-1',
    command: overrides.command ?? 'ls -la',
    status: overrides.status ?? 'completed',
    exitCode: 'exitCode' in overrides ? overrides.exitCode! : 0,
    cwd: overrides.cwd ?? '/home/user/src/project',
    rowRange: overrides.rowRange ?? { startRow: 10, endRowExclusive: 15 },
    confidence: 'confidence' in overrides ? overrides.confidence! : 'authoritative',
    durationMs: 'durationMs' in overrides ? overrides.durationMs! : 240,
    startedAt: overrides.startedAt ?? 1_000,
    completedAt: 'completedAt' in overrides ? overrides.completedAt! : 1_240,
  };
}

afterEach(() => cleanup());

describe('BlockOverlay — presentation', () => {
  it('renders a single card for a single block', () => {
    render(
      <BlockOverlay
        blocks={[makeItem()]}
        baseRowId={0}
        rowCount={50}
        cellHeightPx={16}
      />,
    );
    const cards = screen.getAllByTestId('block-overlay-card');
    expect(cards).toHaveLength(1);
  });

  it('renders nothing visible when blocks is empty (still returns the root)', () => {
    render(
      <BlockOverlay blocks={[]} baseRowId={0} rowCount={0} cellHeightPx={16} />,
    );
    expect(screen.getByTestId('block-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('block-overlay-card')).toBeNull();
  });

  it('positions a card at row*cellHeight px from the top', () => {
    render(
      <BlockOverlay
        blocks={[makeItem({ rowRange: { startRow: 5, endRowExclusive: 10 } })]}
        baseRowId={0}
        rowCount={50}
        cellHeightPx={16}
      />,
    );
    const card = screen.getByTestId('block-overlay-card');
    expect(card.style.top).toBe('80px'); // 5 * 16
    expect(card.style.height).toBe('80px'); // (10 - 5) * 16
  });

  it('subtracts baseRowId before projecting (shifted scrollback)', () => {
    // baseRowId=100 means rows 0..99 were evicted. A block at startRow=110
    // should anchor at (110 - 100) * 16 = 160px, not 1760.
    render(
      <BlockOverlay
        blocks={[
          makeItem({ rowRange: { startRow: 110, endRowExclusive: 115 } }),
        ]}
        baseRowId={100}
        rowCount={50}
        cellHeightPx={16}
      />,
    );
    const card = screen.getByTestId('block-overlay-card');
    expect(card.style.top).toBe('160px');
  });

  it('skips blocks whose startRow is below baseRowId (evicted)', () => {
    render(
      <BlockOverlay
        blocks={[
          makeItem({
            id: 'evicted',
            rowRange: { startRow: 50, endRowExclusive: 55 },
          }),
          makeItem({
            id: 'live',
            rowRange: { startRow: 150, endRowExclusive: 160 },
          }),
        ]}
        baseRowId={100}
        rowCount={100}
        cellHeightPx={16}
      />,
    );
    const cards = screen.getAllByTestId('block-overlay-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.getAttribute('data-block-id')).toBe('live');
  });

  it('stretches an open range (endRowExclusive: null) to the ring tail', () => {
    render(
      <BlockOverlay
        blocks={[
          makeItem({
            status: 'running',
            rowRange: { startRow: 10, endRowExclusive: null },
          }),
        ]}
        baseRowId={0}
        rowCount={30}
        cellHeightPx={16}
      />,
    );
    const card = screen.getByTestId('block-overlay-card');
    // Height: (30 - 10) * 16 = 320px
    expect(card.style.height).toBe('320px');
  });

  it('renders exit code when the block is completed with a non-null code', () => {
    render(
      <BlockOverlay
        blocks={[makeItem({ status: 'completed', exitCode: 0 })]}
        baseRowId={0}
        rowCount={50}
        cellHeightPx={16}
      />,
    );
    expect(screen.getByTestId('block-overlay-exit-code')).toHaveTextContent('0');
    expect(screen.getByTestId('block-overlay-exit-code').getAttribute('data-ok')).toBe(
      'true',
    );
  });

  it('marks exit code as not-ok when exit code is non-zero', () => {
    render(
      <BlockOverlay
        blocks={[makeItem({ status: 'error', exitCode: 1 })]}
        baseRowId={0}
        rowCount={50}
        cellHeightPx={16}
      />,
    );
    expect(screen.getByTestId('block-overlay-exit-code').getAttribute('data-ok')).toBe(
      'false',
    );
  });

  it('omits exit code on a still-running block', () => {
    render(
      <BlockOverlay
        blocks={[makeItem({ status: 'running', exitCode: null, completedAt: null })]}
        baseRowId={0}
        rowCount={50}
        cellHeightPx={16}
      />,
    );
    expect(screen.queryByTestId('block-overlay-exit-code')).toBeNull();
  });

  it('stamps data-confidence with authoritative for osc133-sourced blocks', () => {
    render(
      <BlockOverlay
        blocks={[makeItem({ confidence: 'authoritative' })]}
        baseRowId={0}
        rowCount={50}
        cellHeightPx={16}
      />,
    );
    const card = screen.getByTestId('block-overlay-card');
    expect(card.getAttribute('data-confidence')).toBe('authoritative');
  });

  it('falls back to synthetic data-confidence when confidence is null', () => {
    render(
      <BlockOverlay
        blocks={[makeItem({ confidence: null })]}
        baseRowId={0}
        rowCount={50}
        cellHeightPx={16}
      />,
    );
    const card = screen.getByTestId('block-overlay-card');
    expect(card.getAttribute('data-confidence')).toBe('synthetic');
  });

  it('renders heuristic and idle data-confidence for their respective tiers', () => {
    render(
      <BlockOverlay
        blocks={[
          makeItem({ id: 'a', confidence: 'heuristic' }),
          makeItem({
            id: 'b',
            confidence: 'idle',
            rowRange: { startRow: 20, endRowExclusive: 25 },
          }),
        ]}
        baseRowId={0}
        rowCount={50}
        cellHeightPx={16}
      />,
    );
    expect(
      screen.getByTestId('block-overlay').querySelector('[data-block-id="a"]')
        ?.getAttribute('data-confidence'),
    ).toBe('heuristic');
    expect(
      screen.getByTestId('block-overlay').querySelector('[data-block-id="b"]')
        ?.getAttribute('data-confidence'),
    ).toBe('idle');
  });

  it('computes duration from completedAt - startedAt when durationMs is null', () => {
    render(
      <BlockOverlay
        blocks={[
          makeItem({ durationMs: null, startedAt: 1000, completedAt: 2500 }),
        ]}
        baseRowId={0}
        rowCount={50}
        cellHeightPx={16}
      />,
    );
    // 1500 ms → "1.5s"
    expect(screen.getByTestId('block-overlay-duration')).toHaveTextContent('1.5s');
  });

  it('omits duration on a still-running block with null durationMs', () => {
    render(
      <BlockOverlay
        blocks={[
          makeItem({
            status: 'running',
            durationMs: null,
            startedAt: 0,
            completedAt: null,
          }),
        ]}
        baseRowId={0}
        rowCount={50}
        cellHeightPx={16}
      />,
    );
    expect(screen.queryByTestId('block-overlay-duration')).toBeNull();
  });

  it('renders a cwd badge short label for deep paths', () => {
    render(
      <BlockOverlay
        blocks={[makeItem({ cwd: '/home/user/src/quanta/packages/ui' })]}
        baseRowId={0}
        rowCount={50}
        cellHeightPx={16}
      />,
    );
    expect(screen.getByTestId('block-overlay-cwd')).toHaveTextContent('ui');
  });

  it('clamps card height to maxHeightPx with a 16 px floor', () => {
    render(
      <BlockOverlay
        blocks={[
          makeItem({ rowRange: { startRow: 3, endRowExclusive: 100 } }),
        ]}
        baseRowId={0}
        rowCount={100}
        cellHeightPx={16}
        maxHeightPx={200}
      />,
    );
    const card = screen.getByTestId('block-overlay-card');
    // top=48, raw height=97*16=1552 → clamped to 200-48=152
    expect(card.style.height).toBe('152px');
  });

  it('stamps data-status with running / completed / error / canceled', () => {
    render(
      <BlockOverlay
        blocks={[
          makeItem({
            id: 'a',
            status: 'running',
            rowRange: { startRow: 0, endRowExclusive: null },
          }),
          makeItem({
            id: 'b',
            status: 'error',
            rowRange: { startRow: 10, endRowExclusive: 15 },
          }),
          makeItem({
            id: 'c',
            status: 'canceled',
            rowRange: { startRow: 20, endRowExclusive: 25 },
          }),
        ]}
        baseRowId={0}
        rowCount={30}
        cellHeightPx={16}
      />,
    );
    const find = (id: string): string | null =>
      screen
        .getByTestId('block-overlay')
        .querySelector(`[data-block-id="${id}"]`)
        ?.getAttribute('data-status') ?? null;
    expect(find('a')).toBe('running');
    expect(find('b')).toBe('error');
    expect(find('c')).toBe('canceled');
  });

  it('records the visible block count on data-block-count', () => {
    render(
      <BlockOverlay
        blocks={[
          makeItem({ id: 'a', rowRange: { startRow: 0, endRowExclusive: 5 } }),
          makeItem({
            id: 'b',
            rowRange: { startRow: 10, endRowExclusive: 15 },
          }),
        ]}
        baseRowId={0}
        rowCount={30}
        cellHeightPx={16}
      />,
    );
    expect(screen.getByTestId('block-overlay').getAttribute('data-block-count')).toBe('2');
  });
});

describe('projectRowRange — pure math', () => {
  it('returns null for a range below baseRowId', () => {
    expect(
      projectRowRange(
        { startRow: 5, endRowExclusive: 10 },
        100,
        50,
        16,
        0,
      ),
    ).toBeNull();
  });

  it('returns null for a range past rowCount (not yet captured)', () => {
    // startRow = baseRowId + rowCount + 1 is past the ring tail.
    expect(
      projectRowRange(
        { startRow: 1005, endRowExclusive: 1010 },
        100,
        50,
        16,
        0,
      ),
    ).toBeNull();
  });

  it('handles the boundary row exactly at rowCount', () => {
    // A row at index === rowCount is the "just about to be captured" tail;
    // the overlay still gets a valid projection with zero-floor height.
    const r = projectRowRange(
      { startRow: 150, endRowExclusive: null },
      100,
      50,
      16,
      0,
    );
    expect(r).not.toBeNull();
    expect(r?.top).toBe(800); // 50 * 16
  });

  it('applies topOffsetPx', () => {
    const r = projectRowRange(
      { startRow: 1, endRowExclusive: 2 },
      0,
      10,
      16,
      24,
    );
    expect(r?.top).toBe(16 + 24);
  });
});

describe('formatDuration', () => {
  it('formats sub-second', () => {
    expect(formatDuration(42)).toBe('42ms');
  });
  it('formats seconds', () => {
    expect(formatDuration(2300)).toBe('2.3s');
  });
  it('formats minutes', () => {
    expect(formatDuration(125_000)).toBe('2m 05s');
  });
  it('handles negative / NaN gracefully', () => {
    expect(formatDuration(-10)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });
});

describe('formatCwd', () => {
  it('returns the tail segment', () => {
    expect(formatCwd('/home/user/src/project')).toBe('project');
  });
  it('returns the original for empty string', () => {
    expect(formatCwd('')).toBe('');
  });
  it('handles trailing slashes', () => {
    expect(formatCwd('/root/')).toBe('root');
  });
});
