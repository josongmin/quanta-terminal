/**
 * Shared fixtures for the cell-renderer test suite.
 */

import type { CellSpan, Row, RowDelta } from '../../../lib/grid-mirror/types.js';
import { DefaultClassifier } from '../../../lib/width/index.js';

const classifier = new DefaultClassifier('narrow');

export function asciiRow(text: string, cols: number): Row {
  const cells = text.split('').map((ch) => ({
    grapheme: ch,
    cols: 1,
    sgr: '0x0000000000000000',
    hyperlink_id: 0,
    ext: null,
  }));
  while (cells.length < cols) {
    cells.push({
      grapheme: '',
      cols: 1,
      sgr: '0x0000000000000000',
      hyperlink_id: 0,
      ext: null,
    });
  }
  return { cells: cells.slice(0, cols), continuation: false, revision: 1 };
}

export function widthAwareRow(text: string, cols: number, continuation = false): Row {
  const classified = classifier.classifyStr(text);
  const cells: Row['cells'][number][] = [];
  for (const g of classified) {
    if (g.width === 'zero') continue;
    if (g.width === 'two') {
      cells.push({
        grapheme: g.grapheme,
        cols: 2,
        sgr: '0x0000000000000000',
        hyperlink_id: 0,
        ext: null,
      });
      cells.push({
        grapheme: '',
        cols: 2,
        sgr: '0x0000000000000000',
        hyperlink_id: 0,
        ext: null,
      });
    } else {
      cells.push({
        grapheme: g.grapheme,
        cols: 1,
        sgr: '0x0000000000000000',
        hyperlink_id: 0,
        ext: null,
      });
    }
  }
  while (cells.length < cols) {
    cells.push({
      grapheme: '',
      cols: 1,
      sgr: '0x0000000000000000',
      hyperlink_id: 0,
      ext: null,
    });
  }
  return { cells: cells.slice(0, cols), continuation, revision: 1 };
}

export function blankRow(cols: number): Row {
  return asciiRow('', cols);
}

export function makeRows(lines: string[], cols: number): Row[] {
  return lines.map((t) => widthAwareRow(t, cols));
}

export function spanForAscii(text: string): CellSpan {
  return {
    cols: text.length,
    sgr: '0x0000000000000000',
    graphemes: { utf8: text },
    hyperlink_id: 0,
    ext: null,
  };
}

export function rowDelta(row: number, spans: CellSpan[]): RowDelta {
  return {
    row,
    revision_before: 0,
    revision_after: 1,
    spans,
    continuation: false,
    hyperlink_refs: [],
  };
}
