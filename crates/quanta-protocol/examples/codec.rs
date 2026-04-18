//! Round-trip a control-plane `Hello` message through the protocol codec.
//!
//! Run with:
//!
//! ```shell
//! cargo run --example codec -p quanta-protocol
//! ```

use quanta_proto::protocol::{Hello, ProtocolVersion};
use quanta_protocol::{decode_control, encode_control, ControlMessage};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let hello = ControlMessage::Hello(Hello {
        host_protocol_version: ProtocolVersion::CURRENT,
        host_version: "demo-host-0.0.1".into(),
        client_id: "example-client".into(),
        resume_cursors: std::collections::HashMap::new(),
    });
    let wire = encode_control(&hello)?;
    println!(
        "wire bytes ({} bytes): {:?}",
        wire.len(),
        String::from_utf8_lossy(&wire)
    );

    let back = decode_control(&wire)?;
    println!("decoded: {back:?}");
    Ok(())
}
