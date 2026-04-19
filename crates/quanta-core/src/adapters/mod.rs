//! Core adapters — the engine and control-plane registry.

mod engine;
mod fanout;
mod registry;

pub use engine::Engine;
pub use fanout::{FanoutSink, METRIC_SUBSCRIBER_LAG_DROPS};
pub use registry::ControlRegistry;
