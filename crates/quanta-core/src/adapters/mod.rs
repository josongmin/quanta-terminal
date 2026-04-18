//! Core adapters — the engine and control-plane registry.

mod engine;
mod fanout;
mod registry;

pub use engine::Engine;
pub use fanout::FanoutSink;
pub use registry::ControlRegistry;
