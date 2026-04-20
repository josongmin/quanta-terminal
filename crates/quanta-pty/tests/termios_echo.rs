//! Regression: PTY line-discipline `ECHO` must be disabled at spawn time.
//!
//! Background
//! ----------
//! Cooked-mode shells (zsh/bash/sh) default to `ECHO on`, which means any
//! bytes we write to the master fd are reflected back to us verbatim
//! before the shell has a chance to process them. In Quanta the Composer
//! is the source of user input — the shell-side echo shows up as a
//! duplicate of the typed command at the head of the block output,
//! producing the user-visible "typed `ls`, block shows `ls` before the
//! real output" bug. The adapter now turns `ECHO` off on the master fd
//! right after `openpty` and before `spawn_command`, so the child shell
//! inherits a termios with `LocalFlags::ECHO*` cleared.
//!
//! These tests pin that contract end-to-end by spawning an interactive
//! `/bin/sh` and asserting that bytes written to the PTY do NOT come back
//! out — nothing but the shell's own output shows up on the reader.
//!
//! Unix-only: Windows ConPTY has no termios concept, and the echo
//! channel works differently there.

#![cfg(unix)]

use std::time::{Duration, Instant};

use quanta_pty::{PortablePtyPort, PtyError, PtyHandle, PtyPort, PtySpec};

/// Drain bytes from the PTY until `deadline`. Returns the full accumulated
/// byte stream. Unlike plain reads, this tolerates the adapter's empty-tick
/// response (`Ok(0)`) without treating it as EOF.
async fn drain_until(h: &mut dyn PtyHandle, deadline: Instant) -> Vec<u8> {
    let mut collected = Vec::new();
    let mut buf = vec![0u8; 8 * 1024];
    while Instant::now() < deadline {
        match h.read(&mut buf).await {
            Ok(0) => {
                // Empty tick — the adapter's "no data yet". Loop and try
                // again until the deadline.
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok(n) => collected.extend_from_slice(&buf[..n]),
            Err(PtyError::Closed) => break,
            Err(e) => panic!("unexpected read error: {e:?}"),
        }
    }
    collected
}

/// Baseline sanity check: the adapter still spawns an interactive shell
/// and we can read its prompt. If this fails, the termios change broke
/// something unrelated.
#[tokio::test]
async fn interactive_shell_still_starts() {
    let port = PortablePtyPort::new();
    // `-i` forces interactive mode so the shell reads from the PTY and
    // prints a prompt. Under cooked mode ECHO the prompt bytes themselves
    // are shell output, not echo — so we expect to see the `$`.
    let spec = PtySpec::shell("/bin/sh").with_arg("-i");
    let mut h = port.open(spec).await.expect("spawn");
    let end = Instant::now() + Duration::from_millis(600);
    let collected = drain_until(h.as_mut(), end).await;
    let _ = h.kill().await;
    let _ = h.wait().await;
    // Don't assert on exact prompt bytes — different shells / platforms
    // emit different things. The invariant is "we received SOME bytes":
    // the PTY is alive and the reader path works.
    assert!(
        !collected.is_empty(),
        "interactive shell produced no output at all; the adapter is broken",
    );
}

/// The load-bearing test: write a control byte sequence to the PTY and
/// confirm it is NOT echoed back.
///
/// We use `\x01` (Ctrl-A) because:
///   * It's not a newline — no shell is going to execute a command.
///   * It's a single byte — any leak is unambiguously our write, not
///     anything the shell would have printed on its own.
///   * It's not whitespace — easy to grep for in the output buffer.
///
/// If ECHO were still on, we'd see `\x01` come straight back out of the
/// reader within milliseconds. With ECHO disabled, the byte enters the
/// shell's input and the shell either ignores it (sh in `-s`) or
/// interprets it (zsh readline bind-key) — but never echoes it.
#[tokio::test]
async fn control_byte_write_is_not_echoed() {
    let port = PortablePtyPort::new();
    let spec = PtySpec::shell("/bin/sh").with_arg("-i");
    let mut h = port.open(spec).await.expect("spawn");

    // Drain the initial prompt bytes so subsequent reads see only the
    // response to our write.
    let prompt_end = Instant::now() + Duration::from_millis(300);
    let _prompt = drain_until(h.as_mut(), prompt_end).await;

    // Now write Ctrl-A and wait for the echo window to close.
    h.write_all(&[0x01]).await.expect("write ctrl-a");
    let echo_end = Instant::now() + Duration::from_millis(300);
    let collected = drain_until(h.as_mut(), echo_end).await;
    let _ = h.kill().await;
    let _ = h.wait().await;
    // Any `\x01` in the output came from the ECHO channel — the shell
    // itself has no reason to emit a control byte in response to Ctrl-A.
    assert!(
        !collected.contains(&0x01),
        "ECHO was not disabled: control byte came back; bytes={collected:?}",
    );
}

/// Higher-level test: write a printable-ASCII word that a shell absolutely
/// would echo under cooked mode. Confirms the same invariant as above
/// with a more realistic payload.
#[tokio::test]
async fn printable_word_write_is_not_echoed() {
    let port = PortablePtyPort::new();
    // Disable readline / zle so the shell's line editor doesn't re-emit
    // our bytes as part of its own rendering. `sh -i` is a plain Bourne
    // shell with no line editor, which is what we want for this test.
    let spec = PtySpec::shell("/bin/sh").with_arg("-i");
    let mut h = port.open(spec).await.expect("spawn");

    let prompt_end = Instant::now() + Duration::from_millis(300);
    let _prompt = drain_until(h.as_mut(), prompt_end).await;

    // Write the literal bytes `quanta` (no newline — we do not want the
    // shell to interpret it as a command; we just want to see whether
    // the PTY echoes the input back out of its master side).
    h.write_all(b"quanta").await.expect("write quanta");
    let echo_end = Instant::now() + Duration::from_millis(300);
    let collected = drain_until(h.as_mut(), echo_end).await;
    let _ = h.kill().await;
    let _ = h.wait().await;
    // With ECHO on, we'd see `quanta` come straight back; with ECHO off
    // the bytes enter the shell's stdin buffer and stay there until a
    // newline triggers parsing. Either way, no literal `quanta` in the
    // reader stream during this window.
    let as_str = String::from_utf8_lossy(&collected);
    assert!(
        !as_str.contains("quanta"),
        "ECHO was not disabled: literal input showed up in reader; \
         stream={as_str:?}",
    );
}
