//! Shared test helpers.

use std::sync::Arc;

use quanta_vt::Grid;
use quanta_vt_width::{AmbiguousWidthPolicy, DefaultClassifier, WidthClassifier};

#[must_use]
pub(crate) fn classifier() -> Arc<dyn WidthClassifier> {
    Arc::new(DefaultClassifier::new(AmbiguousWidthPolicy::Narrow))
}

#[must_use]
pub(crate) fn grid(rows: u16, cols: u16) -> Grid {
    Grid::new(rows, cols, 1000, classifier())
}
