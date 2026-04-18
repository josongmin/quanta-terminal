//! Feed a synthetic shell transcript through the VTE boundary detector and
//! print every detected event.
//!
//! Run with:
//!
//! ```shell
//! cargo run --example detect_boundaries -p quanta-block
//! ```

use quanta_block::{BoundaryEvent, VteBoundaryDetector};

fn main() {
    let mut det = VteBoundaryDetector::new();
    // OSC 133 A (prompt) + B (command) + C (output start) + D;0 (done).
    let input: &[u8] =
        b"\x1b]133;A\x1b\\user@host$ echo hi\n\x1b]133;B\x1b\\\x1b]133;C\x1b\\hi\n\x1b]133;D;0\x1b\\";
    let mut sink: Vec<BoundaryEvent> = Vec::new();
    det.feed(input, &mut sink);
    for (i, ev) in sink.iter().enumerate() {
        println!("  [{i}] {ev:?}");
    }
}
