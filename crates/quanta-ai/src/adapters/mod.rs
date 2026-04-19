//! Adapters — concrete classifier + provider implementations.

pub mod anthropic_provider;
pub mod heuristic_classifier;
pub mod mock_provider;

pub use anthropic_provider::{
    AnthropicProvider, AnthropicProviderBuilder, ApiKey, DEFAULT_MODEL, METRIC_REQUEST_LATENCY_MS,
};
pub use heuristic_classifier::HeuristicClassifier;
pub use mock_provider::MockProvider;
