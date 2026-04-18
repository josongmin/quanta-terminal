//! Build a small output store and print per-block concatenated bytes.
//!
//! Run with:
//!
//! ```shell
//! cargo run --example spans -p quanta-output
//! ```

use quanta_output::OutputStore;
use quanta_proto::events::OutputStream;
use quanta_proto::ids::BlockId;

fn main() {
    let mut store = OutputStore::new();
    let block = BlockId::new();
    for chunk in [&b"hello "[..], b"world", b"!\n"] {
        let outcome = store
            .append(block, OutputStream::Stdout, chunk)
            .expect("append returns Some for non-empty input");
        println!(
            "seq={} [{}..{}) — {:?}",
            outcome.seq,
            outcome.byte_offset_start,
            outcome.byte_offset_end,
            String::from_utf8_lossy(chunk)
        );
    }
    let all = store.concatenate(&block);
    println!("concatenated: {:?}", String::from_utf8_lossy(&all));
    println!("total bytes: {}", store.total_bytes(&block));
}
