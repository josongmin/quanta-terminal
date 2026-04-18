//! Byte-transparency end-to-end test for the session actor.
//!
//! The core invariant: bytes read from the PTY MUST be delivered through the
//! `OutputChunk` pipeline byte-for-byte identical, even when a PTY read
//! happens to split a multi-byte UTF-8 codepoint across two chunks. xterm
//! reassembles the bytes on the UI side; the session actor never decodes to
//! `String` on the hot read path.
//!
//! We exercise this by running a shell command whose output contains CJK and
//! emoji characters, waiting for all OutputChunk events, base64-decoding
//! them, concatenating in `seq` order, and asserting the resulting byte
//! sequence contains the exact CJK / emoji byte patterns we sent.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use quanta_events::{EventLogReader as _, ZstdSegmentedEventLog};
use quanta_proto::events::Event;
use quanta_pty::PortablePtyPort;
use quanta_session::{InputSubmission, SessionActor, SessionConfig, SessionHandle};

/// Known byte sequences we send through the PTY. These are the exact bytes
/// a real UTF-8 locale shell would emit, with no platform-specific encoding.
const HANGUL_ANNYEONG: [u8; 15] = [
    // 안: EC 95 88, 녕: EB 85 95, 하: ED 95 98, 세: EC 84 B8, 요: EC 9A 94
    0xEC, 0x95, 0x88, 0xEB, 0x85, 0x95, 0xED, 0x95, 0x98, 0xEC, 0x84, 0xB8, 0xEC, 0x9A, 0x94,
];
const EMOJI_WAVE: [u8; 4] = [0xF0, 0x9F, 0x91, 0x8B];

fn pick_shell() -> String {
    if std::path::Path::new("/bin/sh").exists() {
        "/bin/sh".into()
    } else {
        "/usr/bin/sh".into()
    }
}

/// Helper: write raw bytes to a temp file, then spawn a session that runs
/// `cat <file>`. Using a file avoids cross-shell quoting for binary strings.
async fn run_cat_of_bytes(payload: &[u8]) -> Vec<u8> {
    let tmp = tempfile::tempdir().unwrap();
    let payload_path = tmp.path().join("payload.bin");
    std::fs::write(&payload_path, payload).unwrap();

    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path().join("log")).unwrap());
    std::fs::create_dir_all(tmp.path().join("log")).unwrap();
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig::default_login(pick_shell(), PathBuf::from("/tmp"));
    let (actor, sid) = SessionActor::spawn(pty, log.clone(), cfg).await.unwrap();

    // Submit a `cat <file>` and wait for the session to finish.
    actor
        .submit_input(InputSubmission {
            text: format!("cat {}", payload_path.display()),
            kind: quanta_proto::events::InputKind::Shell,
            submit: true,
        })
        .await
        .expect("submit cat");

    // Wait briefly for output to accumulate; bounded so CI doesn't hang.
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let records = log.replay_session(sid).await.unwrap();
        let got: Vec<u8> = records
            .iter()
            .filter_map(|r| match &r.envelope.payload {
                Event::OutputChunk(c) => BASE64.decode(&c.bytes_b64).ok(),
                _ => None,
            })
            .flatten()
            .collect();
        if got.windows(payload.len()).any(|w| w == payload) {
            actor.close().await.unwrap();
            return got;
        }
    }
    actor.close().await.unwrap();
    // Deadline hit — return what we have so the caller's assertion produces
    // a useful failure rather than a generic timeout.
    let records = log.replay_session(sid).await.unwrap();
    records
        .iter()
        .filter_map(|r| match &r.envelope.payload {
            Event::OutputChunk(c) => BASE64.decode(&c.bytes_b64).ok(),
            _ => None,
        })
        .flatten()
        .collect()
}

/// Korean "안녕하세요" printed through the PTY must appear byte-identical in
/// the OutputChunk stream. No `String::from_utf8` on the hot path means the
/// 한글깨짐 bug class can't introduce replacement characters silently.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn korean_greeting_passes_through_pty_byte_transparent() {
    let got = run_cat_of_bytes(&HANGUL_ANNYEONG).await;
    assert!(
        got.windows(HANGUL_ANNYEONG.len())
            .any(|w| w == HANGUL_ANNYEONG),
        "Korean bytes not present verbatim in PTY output: {got:?}",
    );
}

/// 4-byte emoji passes through unchanged.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn emoji_passes_through_pty_byte_transparent() {
    let got = run_cat_of_bytes(&EMOJI_WAVE).await;
    assert!(
        got.windows(EMOJI_WAVE.len()).any(|w| w == EMOJI_WAVE),
        "emoji bytes not present verbatim in PTY output: {got:?}",
    );
}

/// Random binary-looking bytes that are NOT valid UTF-8 (lone continuation
/// bytes + 0xFF) must also pass through unchanged. A tty running in raw
/// mode emits these at every interactive keystroke.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_utf8_bytes_pass_through_pty_without_loss() {
    // 0x01..=0x06 plus a lone continuation byte. We avoid 0x00 so `cat` on
    // common shells doesn't truncate at a NUL.
    let payload: [u8; 7] = [0x01, 0x02, 0x03, 0x80, 0x81, 0xFE, 0x05];
    let got = run_cat_of_bytes(&payload).await;
    assert!(
        got.windows(payload.len()).any(|w| w == payload),
        "non-UTF-8 bytes must round-trip through the session pipeline: got {got:?}",
    );
}
