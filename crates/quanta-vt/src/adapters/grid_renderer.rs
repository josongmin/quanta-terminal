//! `GridRenderer` — a diff computer. Produces a [`crate::GridDelta`] from
//! the current grid state given a set of row revisions to compare against.
//!
//! "Renderer" here follows the RFC §7 block diagram naming; it is NOT a UI
//! renderer. Pixel painting is EPIC-D.

use crate::domain::cell::Cell;
use crate::ports::event::{CellRun, RowDelta};

/// Diff computer.
#[derive(Debug, Default)]
pub struct GridRenderer;

impl GridRenderer {
    /// Build `RowDelta`s for any row whose revision changed vs. the
    /// caller-provided baseline. Rows without a baseline entry are emitted
    /// as fresh deltas; rows absent from `current` are NOT emitted (that
    /// case is a resize, handled separately).
    #[must_use]
    pub fn diff_rows(
        old_revisions: &[u64],
        current_revisions: &[u64],
        rows: &[Vec<Cell>],
        continuations: &[bool],
    ) -> Vec<RowDelta> {
        let mut out = Vec::new();
        for (i, rev) in current_revisions.iter().enumerate() {
            let old = old_revisions.get(i).copied().unwrap_or(0);
            if old == *rev {
                continue;
            }
            let cells = match rows.get(i) {
                Some(r) => r,
                None => continue,
            };
            let cont = continuations.get(i).copied().unwrap_or(false);
            out.push(RowDelta {
                row: i as u16,
                revision: *rev,
                runs: encode_runs(cells),
                continuation: cont,
            });
        }
        out
    }
}

fn encode_runs(cells: &[Cell]) -> Vec<CellRun> {
    let mut runs: Vec<CellRun> = Vec::new();
    let mut current: Option<(u16, Vec<Cell>)> = None;
    let mut last: Option<&Cell> = None;
    for (col, cell) in cells.iter().enumerate() {
        let col = col as u16;
        let matches = last.is_some_and(|l| attrs_match(l, cell));
        if !matches {
            if let Some((start, acc)) = current.take() {
                runs.push(CellRun {
                    start_col: start,
                    cells: acc,
                });
            }
            current = Some((col, Vec::new()));
        }
        if let Some((_, acc)) = &mut current {
            acc.push(cell.clone());
        }
        last = Some(cell);
    }
    if let Some((start, acc)) = current {
        runs.push(CellRun {
            start_col: start,
            cells: acc,
        });
    }
    runs
}

fn attrs_match(a: &Cell, b: &Cell) -> bool {
    a.fg == b.fg && a.bg == b.bg && a.attrs == b.attrs && a.hyperlink == b.hyperlink
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::cell::Cell;
    use quanta_vt_width::{CellWidth, Grapheme};

    fn cell(c: char) -> Cell {
        Cell {
            grapheme: Grapheme::from_str_infallible(&c.to_string()),
            width: CellWidth::One,
            ..Cell::empty()
        }
    }

    #[test]
    fn no_change_means_no_deltas() {
        let rows = vec![vec![cell('a'); 3]];
        let conts = vec![false];
        let revs = vec![5u64];
        let out = GridRenderer::diff_rows(&revs, &revs, &rows, &conts);
        assert!(out.is_empty());
    }

    #[test]
    fn changed_row_produces_delta() {
        let rows = vec![vec![cell('a'); 3]];
        let conts = vec![false];
        let old = vec![4u64];
        let new = vec![5u64];
        let out = GridRenderer::diff_rows(&old, &new, &rows, &conts);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].row, 0);
        assert_eq!(out[0].revision, 5);
    }

    #[test]
    fn run_length_encodes_uniform_row() {
        let cells = vec![cell('a'), cell('b'), cell('c')];
        let runs = encode_runs(&cells);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].cells.len(), 3);
    }
}
