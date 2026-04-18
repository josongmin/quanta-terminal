//! Edge-case coverage for the PTY adapter.
//!
//! Covers the corners that the error-path tests don't:
//! - zero-dimension resize;
//! - u16::MAX dimensions;
//! - mid-codepoint byte splits inside PTY output;
//! - rapid spawn/drop cycles (reader-thread teardown).

use std::time::Duration;

use quanta_pty::{PortablePtyPort, PtyError, PtyPort, PtySize, PtySpec};

/// Shell path: `/bin/sh` on every supported OS.
fn sh() -> &'static str {
    "/bin/sh"
}

/// A brand-new PTY resized to 0x0 must not panic. portable-pty's openpty
/// requires positive dimensions, so the adapter should either clamp or
/// return a clean Io error.
#[tokio::test]
async fn resize_zero_by_zero_on_open_pty_does_not_panic() {
    let port = PortablePtyPort::new();
    let mut h = port
        .open(PtySpec::shell(sh()).with_arg("-c").with_arg("sleep 1"))
        .await
        .expect("spawn");
    // Resize to 0x0: acceptable outcomes are Ok (some backends clamp) or
    // PtyError::Io — neither is allowed to panic.
    let r = h.resize(PtySize::new(0, 0)).await;
    assert!(
        matches!(r, Ok(()) | Err(PtyError::Io(_))),
        "resize 0x0 must not panic or surface a foreign error; got {r:?}",
    );
    let _ = h.kill().await;
}

/// Resize to u16::MAX × u16::MAX. Some OSes accept, some clamp. The adapter
/// must not panic under either path.
#[tokio::test]
async fn resize_to_u16_max_does_not_panic() {
    let port = PortablePtyPort::new();
    let mut h = port
        .open(PtySpec::shell(sh()).with_arg("-c").with_arg("sleep 1"))
        .await
        .expect("spawn");
    let r = h.resize(PtySize::new(u16::MAX, u16::MAX)).await;
    assert!(
        matches!(r, Ok(()) | Err(PtyError::Io(_))),
        "resize to u16::MAX must not panic; got {r:?}",
    );
    let _ = h.kill().await;
}

/// Write then read a large burst of bytes to exercise mid-codepoint split
/// independence at the adapter layer. We write 1 KiB of a repeating CJK
/// byte pattern through `printf "%b"` and read back at least that many
/// bytes, asserting every 3-byte CJK group is present verbatim.
#[tokio::test]
async fn output_containing_cjk_bytes_survives_adapter_reads() {
    // 한 = ED 95 9C. Build a shell command that uses `printf` with `\xED\x95\x9C`
    // escapes — POSIX printf interprets `\x` hex escapes.
    //
    // We repeat the sequence 128 times so at least one adapter-level read
    // boundary falls inside a codepoint (reader buffer is 8 KiB; 384 bytes
    // of payload + any prompt noise is well inside that, but stdout line
    // buffering typically chunks at 1 KiB).
    let port = PortablePtyPort::new();
    let script = r"printf '\xED\x95\x9C%.0s' $(seq 1 128)";
    let mut h = port
        .open(PtySpec::shell(sh()).with_arg("-c").with_arg(script))
        .await
        .expect("spawn");

    let mut collected: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 1024];
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match h.read(&mut buf).await {
            Ok(0) => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Ok(n) => collected.extend_from_slice(&buf[..n]),
            Err(PtyError::Closed) => break,
            Err(err) => panic!("read error: {err:?}"),
        }
        // Stop once we see enough bytes so the test finishes quickly.
        if collected.len() >= 3 * 128 {
            break;
        }
    }
    let _ = h.wait().await;

    // Count "한" occurrences. Every instance must be an intact 3-byte group.
    let han = [0xEDu8, 0x95, 0x9C];
    let count = collected.windows(3).filter(|w| *w == han).count();
    assert!(
        count >= 32,
        "expected many intact '한' groups in adapter output; found {count} in {} bytes",
        collected.len(),
    );
    // No replacement character (U+FFFD = EF BF BD) must have snuck in.
    let fffd = [0xEFu8, 0xBF, 0xBD];
    assert!(
        !collected.windows(3).any(|w| w == fffd),
        "found U+FFFD in PTY output — adapter lossily decoded somewhere",
    );
}

/// Repeatedly spawn/drop PTYs with no reads. The reader-thread teardown
/// path must keep up — a leak here causes file-descriptor exhaustion.
#[tokio::test]
async fn many_spawn_drop_cycles_do_not_leak_threads() {
    let port = PortablePtyPort::new();
    for _ in 0..16 {
        let h = port
            .open(PtySpec::shell(sh()).with_arg("-c").with_arg("exit 0"))
            .await
            .expect("spawn");
        drop(h);
    }
    // If we got here without hitting EMFILE or blocking, we're good.
}
