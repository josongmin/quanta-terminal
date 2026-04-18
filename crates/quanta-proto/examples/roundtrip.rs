//! Serialize and deserialize a `BlockCreated` envelope.
//!
//! Run with:
//!
//! ```shell
//! cargo run --example roundtrip -p quanta-proto
//! ```

use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
use quanta_proto::events::{BlockCreated, CwdSource, Event, InputKind};
use quanta_proto::ids::{BlockId, SessionId};

fn main() {
    let env = Envelope::new(
        SessionId::new(),
        1,
        Producer::Block,
        SchemaVersion::ONE,
        Event::BlockCreated(BlockCreated {
            block_id: BlockId::new(),
            ordinal: 0,
            input_text: "echo hello".into(),
            input_kind: InputKind::Shell,
            cwd: "/tmp".into(),
            cwd_source: CwdSource::Launch,
            is_compound: false,
        }),
    );
    let json = serde_json::to_string_pretty(&env).expect("serialize");
    println!("{json}");
    let back: Envelope<Event> =
        serde_json::from_str(&json).expect("roundtrip must succeed for a well-formed envelope");
    assert_eq!(env.event_id, back.event_id);
}
