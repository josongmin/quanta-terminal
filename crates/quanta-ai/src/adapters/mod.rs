//! Adapters — concrete classifier + provider implementations.

pub mod heuristic_classifier;
pub mod mock_provider;

pub use heuristic_classifier::HeuristicClassifier;
pub use mock_provider::MockProvider;
