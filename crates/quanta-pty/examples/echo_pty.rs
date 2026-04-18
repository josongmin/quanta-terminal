//! Spawn `/bin/sh -c 'printf hello'` under the PTY adapter and print the
//! bytes that come back.
//!
//! Run with:
//!
//! ```shell
//! cargo run --example echo_pty -p quanta-pty
//! ```

use quanta_pty::{PortablePtyPort, PtyError, PtyPort, PtySpec};

#[tokio::main]
async fn main() -> Result<(), PtyError> {
    let port = PortablePtyPort::new();
    let spec = PtySpec::shell("/bin/sh")
        .with_arg("-c")
        .with_arg("printf hello");
    let mut h = port.open(spec).await?;

    let mut buf = vec![0u8; 4096];
    let mut collected: Vec<u8> = Vec::new();
    // Bounded loop: at 50 iterations × 25 ms internal adapter timeout, this
    // example finishes in well under 2 seconds even if the child stalls.
    for _ in 0..50 {
        match h.read(&mut buf).await {
            Ok(0) => {
                // Empty tick from the adapter — no bytes ready but not EOF.
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            Ok(n) => collected.extend_from_slice(&buf[..n]),
            Err(PtyError::Closed) => break,
            Err(err) => return Err(err),
        }
        if collected.windows(5).any(|w| w == b"hello") {
            break;
        }
    }
    println!("pty output: {:?}", String::from_utf8_lossy(&collected));
    let _ = h.wait().await;
    Ok(())
}
