//! Append a handful of envelopes and replay them from the event log.
//!
//! Run with:
//!
//! ```shell
//! cargo run --example append_and_replay -p quanta-events
//! ```

use quanta_events::{EventLogReader, EventSink, ZstdSegmentedEventLog};
use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
use quanta_proto::events::{BlockCreated, CwdSource, Event, InputKind};
use quanta_proto::ids::{BlockId, SessionId};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let log = ZstdSegmentedEventLog::new(tmp.path())?;
    let session = SessionId::new();
    let block = BlockId::new();

    for seq in 1..=3u64 {
        let env = Envelope::new(
            session,
            seq,
            Producer::Block,
            SchemaVersion::ONE,
            Event::BlockCreated(BlockCreated {
                block_id: block,
                ordinal: seq - 1,
                input_text: format!("cmd #{seq}"),
                input_kind: InputKind::Shell,
                cwd: "/tmp".into(),
                cwd_source: CwdSource::Launch,
                is_compound: false,
            }),
        );
        log.append(env).await?;
    }
    log.flush().await?;

    let records = log.replay_session(session).await?;
    for rec in &records {
        println!(
            "seq={} kind={:?}",
            rec.envelope.monotonic_seq, rec.envelope.payload
        );
    }
    println!("replayed {} records from {:?}", records.len(), tmp.path());
    Ok(())
}
