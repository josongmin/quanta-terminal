/**
 * **E2E — OSC 8 hyperlink full-stack flow**
 *
 * This spec exercises the complete OSC 8 pipeline:
 *   raw PTY bytes → `AnsiParser` (FSM, OSC 8 open/close) →
 *   `GridMirror` (hyperlink table + row/cell `hyperlink_id`) →
 *   `TerminalCanvas` (React widget with the real `CellBuffer`, hit-test,
 *   pointer handlers) → Ctrl/Cmd+click callback.
 *
 * The `AnsiParser` emits `{text, link}` spans but does not itself mint the
 * per-URI integer IDs that the mirror references. In production the VT
 * engine (Rust side) owns both halves: it parses OSC 8 and emits
 * `hyperlink_added` envelopes alongside `grid_delta` row spans stamped with
 * the matching `hyperlink_id`. Here we reproduce that contract in-test by
 *
 *   1. running the real parser against raw byte chunks — which verifies the
 *      open/close FSM, BEL vs ST terminators, params, chunk splits, and
 *      interleaved SGR;
 *   2. translating each parser span into the mirror's wire shape
 *      (`hyperlink_added` + `RowDelta` with `hyperlink_id`), assigning the
 *      smallest fresh id per distinct URI in encounter order.
 *
 * What full-stack-pipeline.e2e already covers (and we do NOT repeat):
 *   - basic Ctrl+click → callback with the registered URI (Linux).
 *
 * What this spec adds on top:
 *   - both terminators (ST and BEL) drive the real parser;
 *   - `id=<n>` OSC 8 params survive the full path to the callback;
 *   - two independent links on one row dispatch to two distinct callbacks;
 *   - a hyperlinked run wrapped across two rows produces the SAME id on both;
 *   - a bare click (no modifier) does NOT fire the hyperlink callback;
 *   - macOS Cmd+click fires the callback (platform="macos" branch);
 *   - an open-then-close sequence that re-opens the same URI may or may not
 *     reuse the id — we only assert the mirror's resolved URI is correct;
 *   - an OSC 8 sequence split across two raw chunks still registers exactly
 *     one link and paints one hyperlinked span;
 *   - SGR bytes inside the hyperlink run coexist with the link (the link
 *     survives SGR reset and stamps `hyperlink_id` on every cell of both
 *     styled sub-runs).
 *
 * Approach: Option B per the plan. The parser is the source of truth for
 * "which text is under which link"; the mirror receives synthetic envelopes
 * derived from that output. No production code is modified.
 */

import { act, render } from '@testing-library/react';
import { createRef, type Ref } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AnsiParser } from '../../shared/lib/ansi-parser/parser.js';
import type { AnsiSpan } from '../../shared/lib/ansi-parser/types.js';
import { GridMirror } from '../../shared/lib/grid-mirror/index.js';
import type {
  CellSpan,
  GridEventEnvelope,
  GridPayload,
  RowDelta,
} from '../../shared/lib/grid-mirror/types.js';
import {
  DEFAULT_METRICS,
  MirrorSource,
} from '../../shared/ui/cell-renderer/index.js';
import type { Platform } from '../../shared/ui/cell-renderer/types.js';
import {
  TerminalCanvas,
  type TerminalCanvasHandle,
} from '../../widgets/terminal-canvas/TerminalCanvas.js';

const SESSION_ID = '01J00000000000000000000001';
const SGR_DEFAULT = '0x0000000000000000';
// Top byte = attrs. Bit 7 = bold (per CellBuffer.ts ATTR_BIT layout). 0x80 in
// the top byte → attrs.bold = true after parseSgr.
const SGR_BOLD = '0x8000000000000000';

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function parseChunks(chunks: readonly Uint8Array[]): readonly AnsiSpan[] {
  const parser = new AnsiParser();
  const out: AnsiSpan[] = [];
  for (const c of chunks) out.push(...parser.feed(c));
  out.push(...parser.flush());
  return out;
}

function parseOnce(input: string): readonly AnsiSpan[] {
  return parseChunks([enc(input)]);
}

// ---------------------------------------------------------------------------
// Span / row builders
// ---------------------------------------------------------------------------

function textSpan(text: string, sgr = SGR_DEFAULT, hyperlinkId = 0): CellSpan {
  return {
    cols: text.length,
    sgr,
    graphemes: { utf8: text },
    hyperlink_id: hyperlinkId,
    ext: null,
  };
}

function blankSpan(cols: number): CellSpan {
  return {
    cols,
    sgr: SGR_DEFAULT,
    graphemes: 'blank',
    hyperlink_id: 0,
    ext: null,
  };
}

function rowDelta(
  row: number,
  spans: readonly CellSpan[],
  cols: number,
  revBefore: number,
  revAfter: number,
  refs: readonly number[],
  continuation = false,
): RowDelta {
  const totalUsed = spans.reduce((a, s) => a + s.cols, 0);
  const padded: CellSpan[] = [...spans];
  if (totalUsed < cols) padded.push(blankSpan(cols - totalUsed));
  return {
    row,
    revision_before: revBefore,
    revision_after: revAfter,
    spans: padded,
    continuation,
    hyperlink_refs: refs,
  };
}

function blankRowDelta(row: number, cols: number): RowDelta {
  return {
    row,
    revision_before: 0,
    revision_after: 1,
    spans: [blankSpan(cols)],
    continuation: false,
    hyperlink_refs: [],
  };
}

function snapshotEnv(rows: number, cols: number, rowDeltas: readonly RowDelta[]) {
  const fullRowDeltas: RowDelta[] = [];
  const seenRows = new Set<number>();
  for (const rd of rowDeltas) {
    fullRowDeltas.push(rd);
    seenRows.add(rd.row);
  }
  for (let r = 0; r < rows; r += 1) {
    if (!seenRows.has(r)) fullRowDeltas.push(blankRowDelta(r, cols));
  }
  return {
    session_id: SESSION_ID,
    grid_epoch: 1,
    sequence_no: 0,
    resize_generation: 0,
    buffer_kind: 'main' as const,
    payload: {
      kind: 'grid_snapshot' as const,
      rows,
      cols,
      buffer_kind: 'main' as const,
      row_deltas: fullRowDeltas,
      cursor: {
        row: 0,
        col: 0,
        visible: true,
        shape: 'block' as const,
        blinking: false,
        pending_wrap: false,
      },
      mode_state: {},
      meta: {},
    },
  };
}

function hyperlinkAddedEnv(
  id: number,
  uri: string,
  params: string | null,
  seq: number,
): GridEventEnvelope<GridPayload> {
  return {
    session_id: SESSION_ID,
    grid_epoch: 1,
    sequence_no: seq,
    resize_generation: 0,
    buffer_kind: 'main',
    payload: { kind: 'hyperlink_added', id, uri, params },
  };
}

// ---------------------------------------------------------------------------
// Parser-span → mirror-envelope translator (the "VT engine" side, mocked).
// ---------------------------------------------------------------------------

/**
 * Parse OSC 8 params (the bit between the first and second semicolons of the
 * OSC 8 payload — `id=42:foo=bar`). The URI is NOT in scope here; the parser
 * has already pulled it out. Returns the raw params string, or `null` when
 * absent.
 *
 * The parser does not expose params today, so we re-parse the raw bytes to
 * recover them. This is pure test plumbing — production has its own path.
 */
function extractOsc8Params(raw: string, uri: string): string | null {
  // Find the OSC 8 open sequence that names `uri`.
  const open = `\x1b]8;`;
  let i = 0;
  while (i < raw.length) {
    const at = raw.indexOf(open, i);
    if (at < 0) return null;
    // Payload goes up to BEL or ESC\.
    const after = at + open.length;
    const endBel = raw.indexOf('\x07', after);
    const endSt = raw.indexOf('\x1b\\', after);
    const end = endBel < 0 ? endSt : endSt < 0 ? endBel : Math.min(endBel, endSt);
    if (end < 0) return null;
    const payload = raw.slice(after, end); // "<params>;<URI>"
    const semi = payload.indexOf(';');
    if (semi < 0) {
      i = end + 1;
      continue;
    }
    const params = payload.slice(0, semi);
    const u = payload.slice(semi + 1);
    if (u === uri) return params.length === 0 ? null : params;
    i = end + 1;
  }
  return null;
}

/**
 * Translate a flat run of parser spans (the output of `AnsiParser.feed`) into
 * mirror envelopes plus a single `RowDelta` for `row`. Any span carrying a
 * `link` URI is converted to a `hyperlink_added` envelope (one per distinct
 * URI, in encounter order, starting at `firstId`) and its cells get the
 * matching `hyperlink_id` in the row delta. The raw byte string is used to
 * recover OSC 8 `params` (the parser drops them).
 *
 * Returns both the envelopes and the next free id / next sequence number so
 * callers can chain multiple rows into one mirror timeline.
 */
function translateSpansToMirror(
  rawBytes: string,
  spans: readonly AnsiSpan[],
  row: number,
  cols: number,
  startSeq: number,
  firstId: number,
  revBefore: number,
  revAfter: number,
  sgrForStyledSpan?: (s: AnsiSpan) => string,
): {
  envelopes: GridEventEnvelope<GridPayload>[];
  rowDelta: RowDelta;
  nextId: number;
  nextSeq: number;
} {
  const envelopes: GridEventEnvelope<GridPayload>[] = [];
  const uriToId = new Map<string, number>();
  let nextId = firstId;
  let seq = startSeq;
  const cellSpans: CellSpan[] = [];
  for (const s of spans) {
    let id = 0;
    if (s.link !== undefined) {
      if (!uriToId.has(s.link)) {
        const params = extractOsc8Params(rawBytes, s.link);
        const env = hyperlinkAddedEnv(nextId, s.link, params, seq);
        envelopes.push(env);
        uriToId.set(s.link, nextId);
        seq += 1;
        nextId += 1;
      }
      id = uriToId.get(s.link)!;
    }
    const sgr = sgrForStyledSpan ? sgrForStyledSpan(s) : SGR_DEFAULT;
    cellSpans.push(textSpan(s.text, sgr, id));
  }
  const refs = [
    ...new Set(
      cellSpans
        .map((c) => c.hyperlink_id)
        .filter((id): id is number => typeof id === 'number' && id > 0),
    ),
  ];
  const rd = rowDelta(row, cellSpans, cols, revBefore, revAfter, refs);
  return { envelopes, rowDelta: rd, nextId, nextSeq: seq };
}

// ---------------------------------------------------------------------------
// TerminalCanvas mount harness
// ---------------------------------------------------------------------------

interface MountResult {
  mirror: GridMirror;
  source: MirrorSource;
  ref: { current: TerminalCanvasHandle | null };
  container: HTMLElement;
  unmount: () => void;
}

function mountWith(opts: {
  rows: number;
  cols: number;
  snapshot: RowDelta[];
  addedEnvelopes?: GridEventEnvelope<GridPayload>[];
  platform?: Platform;
  onHyperlinkClick?: (ev: {
    id: number;
    uri: string | null;
    modifiers: string[];
  }) => void;
}): MountResult {
  const source = new MirrorSource();
  const mirror = new GridMirror({ onChange: (d) => source.emit(d) });
  mirror.applySnapshot(snapshotEnv(opts.rows, opts.cols, opts.snapshot));
  for (const env of opts.addedEnvelopes ?? []) mirror.apply(env);
  const ref = createRef<TerminalCanvasHandle>();
  const extras: Partial<{
    onHyperlinkClick: (ev: { id: number; uri: string | null; modifiers: string[] }) => void;
  }> = {};
  if (opts.onHyperlinkClick) extras.onHyperlinkClick = opts.onHyperlinkClick;
  const result = render(
    <TerminalCanvas
      ref={ref as Ref<TerminalCanvasHandle>}
      mirror={mirror}
      mirrorSource={source}
      backend="memory"
      metrics={DEFAULT_METRICS}
      platform={opts.platform ?? 'linux'}
      {...extras}
    />,
  );
  return {
    mirror,
    source,
    ref: ref as { current: TerminalCanvasHandle | null },
    container: result.container,
    unmount: result.unmount,
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Dispatch a pointerdown at cell (row, col) with optional modifier flags. */
function clickCell(
  container: HTMLElement,
  row: number,
  col: number,
  opts: { ctrl?: boolean; meta?: boolean } = {},
): void {
  const app = container.querySelector('[role="application"]') as HTMLElement;
  const x = col * DEFAULT_METRICS.cellWidthCssPx + 1;
  const y = row * DEFAULT_METRICS.cellHeightCssPx + 1;
  const native = new (class extends Event {
    clientX = x;
    clientY = y;
    pointerId = 1;
    ctrlKey = Boolean(opts.ctrl);
    shiftKey = false;
    altKey = false;
    metaKey = Boolean(opts.meta);
    button = 0;
    buttons = 1;
    detail = 1;
    pointerType = 'mouse';
  })('pointerdown', { bubbles: true, cancelable: true });
  app.dispatchEvent(native);
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

describe('OSC 8 hyperlink full-stack flow (e2e)', () => {
  it('1. ST terminator — raw bytes → parser → mirror → click dispatches registered URI', async () => {
    const cols = 20;
    const raw = '\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\';
    const spans = parseOnce(raw);
    expect(spans).toEqual([{ text: 'link', link: 'https://example.com' }]);

    const { envelopes, rowDelta: rd } = translateSpansToMirror(
      raw,
      spans,
      0,
      cols,
      1,
      1,
      0,
      1,
    );
    const onHyperlinkClick = vi.fn();
    const { container, mirror } = mountWith({
      rows: 4,
      cols,
      snapshot: [rd],
      addedEnvelopes: envelopes,
      onHyperlinkClick,
    });
    await flushEffects();
    expect(mirror.resolveHyperlink(1).uri).toBe('https://example.com');

    // Click inside the 4-cell "link" region with Ctrl (Linux).
    clickCell(container, 0, 2, { ctrl: true });
    expect(onHyperlinkClick).toHaveBeenCalledTimes(1);
    expect(onHyperlinkClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, uri: 'https://example.com' }),
    );
  });

  it('2. BEL terminator — parser still closes the link; click dispatches URI', async () => {
    const cols = 20;
    const raw = '\x1b]8;;http://a.example\x07text\x1b]8;;\x07';
    const spans = parseOnce(raw);
    expect(spans).toEqual([{ text: 'text', link: 'http://a.example' }]);

    const { envelopes, rowDelta: rd } = translateSpansToMirror(
      raw,
      spans,
      0,
      cols,
      1,
      1,
      0,
      1,
    );
    const onHyperlinkClick = vi.fn();
    const { container, mirror } = mountWith({
      rows: 4,
      cols,
      snapshot: [rd],
      addedEnvelopes: envelopes,
      onHyperlinkClick,
    });
    await flushEffects();
    expect(mirror.resolveHyperlink(1).uri).toBe('http://a.example');

    clickCell(container, 0, 0, { ctrl: true });
    expect(onHyperlinkClick).toHaveBeenCalledTimes(1);
    expect(onHyperlinkClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, uri: 'http://a.example' }),
    );
  });

  it('3. OSC 8 id=42 params — params flow into mirror and are resolvable', async () => {
    const cols = 20;
    const raw = '\x1b]8;id=42;https://x.example\x1b\\X\x1b]8;;\x1b\\';
    const spans = parseOnce(raw);
    expect(spans).toEqual([{ text: 'X', link: 'https://x.example' }]);

    // Sanity-check our in-test params extractor.
    expect(extractOsc8Params(raw, 'https://x.example')).toBe('id=42');

    const { envelopes, rowDelta: rd } = translateSpansToMirror(
      raw,
      spans,
      0,
      cols,
      1,
      1,
      0,
      1,
    );
    const onHyperlinkClick = vi.fn();
    const { container, mirror } = mountWith({
      rows: 4,
      cols,
      snapshot: [rd],
      addedEnvelopes: envelopes,
      onHyperlinkClick,
    });
    await flushEffects();
    const resolved = mirror.resolveHyperlink(1);
    expect(resolved.uri).toBe('https://x.example');
    expect(resolved.params).toBe('id=42');

    clickCell(container, 0, 0, { ctrl: true });
    expect(onHyperlinkClick).toHaveBeenCalledTimes(1);
  });

  it('4. Two independent links on the same row dispatch to two different URIs', async () => {
    const cols = 20;
    const raw =
      '\x1b]8;;https://first.test\x1b\\A\x1b]8;;\x1b\\ \x1b]8;;https://second.test\x1b\\B\x1b]8;;\x1b\\';
    const spans = parseOnce(raw);
    expect(spans).toEqual([
      { text: 'A', link: 'https://first.test' },
      { text: ' ' },
      { text: 'B', link: 'https://second.test' },
    ]);

    const { envelopes, rowDelta: rd } = translateSpansToMirror(
      raw,
      spans,
      0,
      cols,
      1,
      1,
      0,
      1,
    );
    expect(envelopes.length).toBe(2);
    const onHyperlinkClick = vi.fn();
    const { container, mirror, ref } = mountWith({
      rows: 4,
      cols,
      snapshot: [rd],
      addedEnvelopes: envelopes,
      onHyperlinkClick,
    });
    await flushEffects();
    expect(mirror.resolveHyperlink(1).uri).toBe('https://first.test');
    expect(mirror.resolveHyperlink(2).uri).toBe('https://second.test');
    // Cell at col 0 should carry id 1; cell at col 2 should carry id 2.
    // CellBuffer exposes "no hyperlink" as `null` (not 0).
    expect(ref.current?.cellBuffer.getCell(0, 0)?.hyperlinkId).toBe(1);
    expect(ref.current?.cellBuffer.getCell(0, 1)?.hyperlinkId).toBeNull();
    expect(ref.current?.cellBuffer.getCell(0, 2)?.hyperlinkId).toBe(2);

    clickCell(container, 0, 0, { ctrl: true });
    clickCell(container, 0, 2, { ctrl: true });
    expect(onHyperlinkClick).toHaveBeenCalledTimes(2);
    expect(onHyperlinkClick.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ id: 1, uri: 'https://first.test' }),
    );
    expect(onHyperlinkClick.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ id: 2, uri: 'https://second.test' }),
    );
  });

  it('5. One link wrapped across two rows — hit-test returns the SAME id from both rows', async () => {
    // Simulate a URL-wrapped run: "HELLO" on row 0, "WORLD" on row 1, both
    // tagged with the same `hyperlink_id`. In production the VT engine emits
    // two row deltas with continuation=true on the second; we model that.
    const cols = 5;
    const uri = 'https://wrapped.example/long';
    const envs = [hyperlinkAddedEnv(7, uri, null, 1)];
    const row0 = rowDelta(
      0,
      [textSpan('HELLO', SGR_DEFAULT, 7)],
      cols,
      0,
      1,
      [7],
      false,
    );
    const row1 = rowDelta(
      1,
      [textSpan('WORLD', SGR_DEFAULT, 7)],
      cols,
      0,
      1,
      [7],
      true, // continuation
    );
    const onHyperlinkClick = vi.fn();
    const { container, ref } = mountWith({
      rows: 3,
      cols,
      snapshot: [row0, row1],
      addedEnvelopes: envs,
      onHyperlinkClick,
    });
    await flushEffects();
    // Both rows report the same hyperlinkId via hit-test.
    const h0 = ref.current?.hitTest.screenToCell(
      1 * DEFAULT_METRICS.cellWidthCssPx + 1,
      0 * DEFAULT_METRICS.cellHeightCssPx + 1,
    );
    const h1 = ref.current?.hitTest.screenToCell(
      1 * DEFAULT_METRICS.cellWidthCssPx + 1,
      1 * DEFAULT_METRICS.cellHeightCssPx + 1,
    );
    expect(h0?.hyperlinkId).toBe(7);
    expect(h1?.hyperlinkId).toBe(7);

    // Clicking either row fires the SAME URI.
    clickCell(container, 0, 2, { ctrl: true });
    clickCell(container, 1, 2, { ctrl: true });
    expect(onHyperlinkClick).toHaveBeenCalledTimes(2);
    expect(onHyperlinkClick.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ id: 7, uri }),
    );
    expect(onHyperlinkClick.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ id: 7, uri }),
    );
  });

  it('6. Click WITHOUT the platform modifier does NOT fire onHyperlinkClick', async () => {
    const cols = 20;
    const raw = '\x1b]8;;https://nope.test\x1b\\LINK\x1b]8;;\x1b\\';
    const { envelopes, rowDelta: rd } = translateSpansToMirror(
      raw,
      parseOnce(raw),
      0,
      cols,
      1,
      1,
      0,
      1,
    );
    const onHyperlinkClick = vi.fn();
    const { container } = mountWith({
      rows: 4,
      cols,
      snapshot: [rd],
      addedEnvelopes: envelopes,
      platform: 'linux',
      onHyperlinkClick,
    });
    await flushEffects();
    // Bare click — no ctrlKey, no metaKey.
    clickCell(container, 0, 1);
    expect(onHyperlinkClick).not.toHaveBeenCalled();
  });

  it('7. macOS platform — Cmd+click (metaKey) fires the callback; Ctrl+click does not', async () => {
    const cols = 20;
    const raw = '\x1b]8;;https://mac.example\x1b\\M\x1b]8;;\x1b\\';
    const { envelopes, rowDelta: rd } = translateSpansToMirror(
      raw,
      parseOnce(raw),
      0,
      cols,
      1,
      1,
      0,
      1,
    );
    const onHyperlinkClick = vi.fn();
    const { container } = mountWith({
      rows: 4,
      cols,
      snapshot: [rd],
      addedEnvelopes: envelopes,
      platform: 'macos',
      onHyperlinkClick,
    });
    await flushEffects();
    // Ctrl does NOT fire on macOS.
    clickCell(container, 0, 0, { ctrl: true });
    expect(onHyperlinkClick).not.toHaveBeenCalled();
    // Cmd (meta) DOES fire on macOS.
    clickCell(container, 0, 0, { meta: true });
    expect(onHyperlinkClick).toHaveBeenCalledTimes(1);
    expect(onHyperlinkClick).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        uri: 'https://mac.example',
        modifiers: expect.arrayContaining(['meta']),
      }),
    );
  });

  it('8. Close then re-open — mirror holds the current URI; click dispatches it', async () => {
    // open#1 "A" → close → open#2 "B" (same URI reused as a new open). The
    // parser treats them as two separate styled runs — a close clears the
    // link, then a new open restarts it. We mint fresh ids per encounter,
    // matching the VT engine's cache-miss behaviour when a close has flushed
    // the URI. The key assertion: whichever id winds up on the cell at click
    // time, the RESOLVED URI is still correct.
    const cols = 20;
    const raw =
      '\x1b]8;;https://reopen.example\x1b\\A\x1b]8;;\x1b\\ \x1b]8;;https://reopen.example\x1b\\B\x1b]8;;\x1b\\';
    const spans = parseOnce(raw);
    expect(spans).toEqual([
      { text: 'A', link: 'https://reopen.example' },
      { text: ' ' },
      { text: 'B', link: 'https://reopen.example' },
    ]);
    // Translator dedups by URI — same URI → same id.
    const { envelopes, rowDelta: rd, nextId } = translateSpansToMirror(
      raw,
      spans,
      0,
      cols,
      1,
      1,
      0,
      1,
    );
    expect(envelopes.length).toBe(1); // single hyperlink_added (URI dedup).
    expect(nextId).toBe(2);
    const onHyperlinkClick = vi.fn();
    const { container, mirror } = mountWith({
      rows: 4,
      cols,
      snapshot: [rd],
      addedEnvelopes: envelopes,
      onHyperlinkClick,
    });
    await flushEffects();
    expect(mirror.resolveHyperlink(1).uri).toBe('https://reopen.example');

    // Click both the "A" cell and the "B" cell — both must dispatch.
    clickCell(container, 0, 0, { ctrl: true });
    clickCell(container, 0, 2, { ctrl: true });
    expect(onHyperlinkClick).toHaveBeenCalledTimes(2);
    for (const call of onHyperlinkClick.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({ uri: 'https://reopen.example' }),
      );
    }
  });

  it('9. OSC 8 split across two raw chunks — parser re-joins and the link registers exactly once', async () => {
    const cols = 20;
    const full = '\x1b]8;;https://split.example\x1b\\split\x1b]8;;\x1b\\';
    // Split the raw bytes right in the middle of the URI so the parser has
    // to hold partial OSC state across feed() calls.
    const midpoint = Math.floor(full.length / 2);
    const chunk1 = enc(full.slice(0, midpoint));
    const chunk2 = enc(full.slice(midpoint));
    expect(chunk1.length).toBeGreaterThan(0);
    expect(chunk2.length).toBeGreaterThan(0);
    const spans = parseChunks([chunk1, chunk2]);
    expect(spans).toEqual([{ text: 'split', link: 'https://split.example' }]);

    const { envelopes, rowDelta: rd } = translateSpansToMirror(
      full,
      spans,
      0,
      cols,
      1,
      1,
      0,
      1,
    );
    expect(envelopes.length).toBe(1);
    const onHyperlinkClick = vi.fn();
    const { container, mirror } = mountWith({
      rows: 4,
      cols,
      snapshot: [rd],
      addedEnvelopes: envelopes,
      onHyperlinkClick,
    });
    await flushEffects();
    expect(mirror.resolveHyperlink(1).uri).toBe('https://split.example');

    clickCell(container, 0, 2, { ctrl: true });
    expect(onHyperlinkClick).toHaveBeenCalledTimes(1);
    expect(onHyperlinkClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, uri: 'https://split.example' }),
    );
  });

  it('10. SGR inside a link — bold sub-run still carries the hyperlink_id', async () => {
    const cols = 20;
    // Open link, SGR bold, text "bold", SGR reset, text "plain", close link.
    // Per parser contract the SGR reset does NOT clear the OSC 8 link — the
    // link survives across style changes inside the OSC 8 window.
    const raw =
      '\x1b]8;;https://styled.example\x1b\\\x1b[1mbold\x1b[0mplain\x1b]8;;\x1b\\';
    const spans = parseOnce(raw);
    // Expect two spans — both linked — differing only in `bold`.
    expect(spans.length).toBe(2);
    expect(spans[0]).toEqual(
      expect.objectContaining({
        text: 'bold',
        bold: true,
        link: 'https://styled.example',
      }),
    );
    expect(spans[1]).toEqual(
      expect.objectContaining({ text: 'plain', link: 'https://styled.example' }),
    );

    const { envelopes, rowDelta: rd } = translateSpansToMirror(
      raw,
      spans,
      0,
      cols,
      1,
      1,
      0,
      1,
      (s) => (s.bold ? SGR_BOLD : SGR_DEFAULT),
    );
    // Only one hyperlink_added — the URI appears twice in spans but dedups.
    expect(envelopes.length).toBe(1);
    const onHyperlinkClick = vi.fn();
    const { container, ref, mirror } = mountWith({
      rows: 4,
      cols,
      snapshot: [rd],
      addedEnvelopes: envelopes,
      onHyperlinkClick,
    });
    await flushEffects();
    expect(mirror.resolveHyperlink(1).uri).toBe('https://styled.example');
    // Every cell across both styled sub-runs must carry hyperlink_id=1.
    for (let c = 0; c < 'boldplain'.length; c += 1) {
      expect(ref.current?.cellBuffer.getCell(0, c)?.hyperlinkId).toBe(1);
    }
    // But the decoded attrs differ between "bold" and "plain" cells —
    // CellBuffer exposes `attrs` (parsed from the SGR u64), not the raw string.
    expect(ref.current?.cellBuffer.getCell(0, 0)?.attrs.bold).toBe(true);
    expect(ref.current?.cellBuffer.getCell(0, 4)?.attrs.bold).toBe(false);

    clickCell(container, 0, 1, { ctrl: true }); // inside "bold"
    clickCell(container, 0, 6, { ctrl: true }); // inside "plain"
    expect(onHyperlinkClick).toHaveBeenCalledTimes(2);
    for (const call of onHyperlinkClick.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({ id: 1, uri: 'https://styled.example' }),
      );
    }
  });

  it('11. Click on a non-hyperlink cell (cols beyond the link) with modifier is a no-op for the link callback', async () => {
    // Parser produces one link run at cols 0..3; cols 4..9 are plain "tail".
    const cols = 20;
    const raw = '\x1b]8;;https://only.example\x1b\\LINK\x1b]8;;\x1b\\tail';
    const spans = parseOnce(raw);
    expect(spans).toEqual([
      { text: 'LINK', link: 'https://only.example' },
      { text: 'tail' },
    ]);
    const { envelopes, rowDelta: rd } = translateSpansToMirror(
      raw,
      spans,
      0,
      cols,
      1,
      1,
      0,
      1,
    );
    const onHyperlinkClick = vi.fn();
    const { container } = mountWith({
      rows: 4,
      cols,
      snapshot: [rd],
      addedEnvelopes: envelopes,
      onHyperlinkClick,
    });
    await flushEffects();
    // Click col 0 (inside link) with Ctrl → fires.
    clickCell(container, 0, 0, { ctrl: true });
    expect(onHyperlinkClick).toHaveBeenCalledTimes(1);
    // Click col 5 (inside "tail") with Ctrl → does NOT fire (no hyperlink_id).
    clickCell(container, 0, 5, { ctrl: true });
    expect(onHyperlinkClick).toHaveBeenCalledTimes(1);
  });
});
