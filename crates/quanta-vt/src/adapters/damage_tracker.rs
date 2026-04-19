//! Row-level damage tracker.
//!
//! The inner tracker on [`crate::Grid`] is private; this adapter exports the
//! row-level types EPIC-C and others consume when inspecting delta output.

use serde::{Deserialize, Serialize};

/// A single dirty-row hint. This mirrors [`crate::RowDelta`] for consumers
/// that only need "row X changed; its revision is Y" without the cell data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowDamage {
    /// Row index (zero-based, viewport-local).
    pub row: u16,
    /// New row revision.
    pub revision: u64,
}

/// Zero-allocation-in-steady-state row damage tracker.
///
/// Backed by a preallocated `Vec<bool>` sized to the grid row count. On
/// each feed, `.clear()` resets the bits; subsequent writes `.mark(row)`
/// flip bits. `.flush()` drains dirty rows into a preallocated result
/// vector that callers are expected to re-use.
#[derive(Debug, Default)]
pub struct RowDamageTracker {
    dirty: Vec<bool>,
}

impl RowDamageTracker {
    /// Construct sized for `rows` entries.
    #[must_use]
    pub fn new(rows: u16) -> Self {
        Self {
            dirty: vec![false; rows as usize],
        }
    }

    /// Mark a row dirty. Out-of-range indices are silently ignored; the
    /// grid clamps callers before calling us.
    pub fn mark(&mut self, row: u16) {
        if let Some(slot) = self.dirty.get_mut(row as usize) {
            *slot = true;
        }
    }

    /// Reset to all-clean. Does not reallocate.
    pub fn clear(&mut self) {
        for s in &mut self.dirty {
            *s = false;
        }
    }

    /// Resize to `rows` entries; resets all to clean.
    pub fn resize(&mut self, rows: u16) {
        self.dirty.clear();
        self.dirty.resize(rows as usize, false);
    }

    /// Drain dirty rows into `out`, emitting one [`RowDamage`] per dirty
    /// index. `revisions` supplies the per-row revision to stamp. Does not
    /// clear the tracker (callers pair with `.clear()` or resize).
    pub fn flush_into(&self, revisions: &[u64], out: &mut Vec<RowDamage>) {
        for (i, dirty) in self.dirty.iter().enumerate() {
            if !*dirty {
                continue;
            }
            let rev = revisions.get(i).copied().unwrap_or(0);
            out.push(RowDamage {
                row: i as u16,
                revision: rev,
            });
        }
    }

    /// Number of rows tracked.
    #[must_use]
    pub fn len(&self) -> usize {
        self.dirty.len()
    }

    /// True if no rows tracked.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.dirty.is_empty()
    }

    /// Is row `row` currently dirty?
    #[must_use]
    pub fn is_dirty(&self, row: u16) -> bool {
        self.dirty.get(row as usize).copied().unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_all_clean() {
        let t = RowDamageTracker::new(5);
        for r in 0..5 {
            assert!(!t.is_dirty(r));
        }
    }

    #[test]
    fn mark_and_flush() {
        let mut t = RowDamageTracker::new(5);
        t.mark(0);
        t.mark(3);
        let revisions = vec![1, 2, 3, 4, 5];
        let mut out = Vec::new();
        t.flush_into(&revisions, &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(
            out[0],
            RowDamage {
                row: 0,
                revision: 1
            }
        );
        assert_eq!(
            out[1],
            RowDamage {
                row: 3,
                revision: 4
            }
        );
    }

    #[test]
    fn clear_resets() {
        let mut t = RowDamageTracker::new(3);
        t.mark(1);
        assert!(t.is_dirty(1));
        t.clear();
        assert!(!t.is_dirty(1));
    }

    #[test]
    fn resize_clears_and_resizes() {
        let mut t = RowDamageTracker::new(3);
        t.mark(1);
        t.resize(10);
        assert_eq!(t.len(), 10);
        assert!(!t.is_dirty(1));
    }

    #[test]
    fn mark_out_of_range_is_noop() {
        let mut t = RowDamageTracker::new(3);
        t.mark(10); // no panic
        assert!(!t.is_dirty(10));
    }
}
