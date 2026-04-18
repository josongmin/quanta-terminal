//! CJK / multi-byte split-chunk tests for the VTE boundary detector.
//!
//! The "한글깨짐 (Korean corruption)" class of bugs happens when a PTY read
//! chunk boundary lands inside a multi-byte UTF-8 codepoint. The detector
//! MUST be byte-transparent: feeding `[0xED, 0x95]` then `[0x9C]` across two
//! separate `feed()` calls must produce EXACTLY the same events as feeding
//! `[0xED, 0x95, 0x9C]` in one call.
//!
//! These fixtures use exact byte arrays — never a `"한".as_bytes()` conversion
//! inside the test body — so the bytes driven through the parser are the
//! bytes a real PTY emits. Determinism is load-bearing.

use quanta_block::{BoundaryEvent, VteBoundaryDetector};

/// UTF-8 bytes for "한": `ED 95 9C`.
const HAN_BYTES: [u8; 3] = [0xED, 0x95, 0x9C];
/// UTF-8 bytes for "글": `EA B8 80`.
const GEUL_BYTES: [u8; 3] = [0xEA, 0xB8, 0x80];
/// UTF-8 bytes for "안": `EC 95 88`.
const AN_BYTES: [u8; 3] = [0xEC, 0x95, 0x88];
/// UTF-8 bytes for "녕": `EB 85 95`.
const NYEONG_BYTES: [u8; 3] = [0xEB, 0x85, 0x95];
/// UTF-8 bytes for "你": `E4 BD A0`.
const NI_BYTES: [u8; 3] = [0xE4, 0xBD, 0xA0];
/// UTF-8 bytes for "好": `E5 A5 BD`.
const HAO_BYTES: [u8; 3] = [0xE5, 0xA5, 0xBD];
/// UTF-8 bytes for the waving-hand emoji "👋": `F0 9F 91 8B`.
const WAVING_HAND: [u8; 4] = [0xF0, 0x9F, 0x91, 0x8B];
/// UTF-8 bytes for skin-tone modifier "🏽": `F0 9F 8F BD`.
const SKIN_TONE_MED: [u8; 4] = [0xF0, 0x9F, 0x8F, 0xBD];

fn drive_chunks(chunks: &[&[u8]]) -> Vec<BoundaryEvent> {
    let mut det = VteBoundaryDetector::new();
    let mut sink: Vec<BoundaryEvent> = Vec::new();
    for c in chunks {
        det.feed(c, &mut sink);
    }
    sink
}

/// PTY chunk boundary lands mid-codepoint (`[ED 95] [9C]` splits "한"). The
/// detector must still produce zero events — the bytes are plain text, not
/// boundary markers — and it must not panic or poison its internal state.
/// This is the flagship regression guard against the 한글깨짐 class of bugs.
#[test]
fn korean_han_split_mid_codepoint_produces_zero_events_and_no_panic() {
    // "한" = [ED 95 9C], split AT the first continuation byte.
    let events = drive_chunks(&[&HAN_BYTES[0..2], &HAN_BYTES[2..3]]);
    assert!(
        events.is_empty(),
        "plain CJK output must never synthesize boundary events; got {events:?}"
    );
}

/// Splitting the same codepoint in EVERY possible position: [1,2], [2,1]. Both
/// must yield identical output (none) and neither may corrupt the parser.
#[test]
fn korean_han_every_split_point_is_byte_transparent() {
    for split in 1..HAN_BYTES.len() {
        let events = drive_chunks(&[&HAN_BYTES[0..split], &HAN_BYTES[split..]]);
        assert!(
            events.is_empty(),
            "split at {split} produced spurious events {events:?}"
        );
    }
}

/// Four-byte emoji split mid-sequence. Same contract — zero events, no panic.
#[test]
fn emoji_waving_hand_split_every_position_is_byte_transparent() {
    for split in 1..WAVING_HAND.len() {
        let events = drive_chunks(&[&WAVING_HAND[0..split], &WAVING_HAND[split..]]);
        assert!(
            events.is_empty(),
            "emoji split at {split} produced {events:?}"
        );
    }
}

/// "안녕하세요" style greeting split at a random byte offset mid-stream:
/// one chunk holds the prefix bytes and one continuation byte of the next
/// codepoint, the next chunk holds the remainder. Single-shot feed vs chunked
/// feed must produce the same (empty) events.
#[test]
fn korean_greeting_chunked_matches_singleshot() {
    let mut full: Vec<u8> = Vec::new();
    full.extend_from_slice(&AN_BYTES);
    full.extend_from_slice(&NYEONG_BYTES);
    full.extend_from_slice(&HAN_BYTES); // "한" as filler
    full.extend_from_slice(&GEUL_BYTES); // "글" as filler

    let single = drive_chunks(&[&full]);
    // Split right in the middle of 녕 (bytes 3-5 of the buffer).
    let chunked = drive_chunks(&[&full[0..4], &full[4..7], &full[7..]]);
    assert_eq!(single, chunked);
    assert!(single.is_empty(), "greeting is plain text, no events");
}

/// Mixed ASCII + CJK surrounding a real OSC 133 `A` marker. The detector MUST
/// emit exactly the one `PromptStart`, regardless of how the surrounding
/// multi-byte codepoints are chunked across feed calls.
#[test]
fn osc133_survives_cjk_chunk_boundaries_around_marker() {
    let mut pre: Vec<u8> = Vec::new();
    pre.extend_from_slice(b"prompt>");
    pre.extend_from_slice(&AN_BYTES); // plain CJK before marker
    let marker = b"\x1b]133;A\x1b\\";
    let mut post: Vec<u8> = Vec::new();
    post.extend_from_slice(b"\n");
    post.extend_from_slice(&NI_BYTES);
    post.extend_from_slice(&HAO_BYTES);

    // Chunk the CJK preamble mid-codepoint, then the marker, then the CJK
    // suffix split across the two codepoints.
    let events = drive_chunks(&[
        &pre[0..pre.len() - 1], // splits 안 mid-codepoint
        &pre[pre.len() - 1..],
        marker,
        &post[0..2], // splits 你 mid-codepoint
        &post[2..],
    ]);
    assert_eq!(events, vec![BoundaryEvent::PromptStart]);
}

/// Japanese Hiragana characters (3-byte UTF-8) feeding into an OSC 133 D
/// marker with ASCII separation. The marker must fire with the exit code
/// intact even when the preceding CJK is split mid-codepoint across chunks.
/// A newline between the CJK and the marker ensures VTE is in ground state
/// before the OSC arrives (the marker must be fed as its own byte stream,
/// not glued to a pending continuation byte — real shells always emit the
/// marker after flushing to a line start).
#[test]
fn osc133_d_exit_code_after_japanese_output_carries_expected_code() {
    // ひ = E3 81 B2, ら = E3 82 89, が = E3 81 8C, な = E3 81 AA
    let hiragana: [u8; 12] = [
        0xE3, 0x81, 0xB2, 0xE3, 0x82, 0x89, 0xE3, 0x81, 0x8C, 0xE3, 0x81, 0xAA,
    ];
    let newline = b"\n";
    let marker = b"\x1b]133;D;137\x1b\\";
    // Split the hiragana mid-codepoint, emit a newline to end the output
    // line, then feed the marker.
    let events = drive_chunks(&[
        &hiragana[0..5],
        &hiragana[5..7],
        &hiragana[7..],
        newline,
        marker,
    ]);
    assert_eq!(
        events,
        vec![BoundaryEvent::CommandDone {
            exit_code: Some(137)
        }]
    );
}

/// An OSC 133 `D` payload containing non-UTF-8 bytes for the exit code slot.
/// The detector must NOT panic: exit code falls back to `None` and a
/// CommandDone is still emitted (so the block can close deterministically).
/// This pins the documented policy in `osc_dispatch`.
#[test]
fn osc133_d_with_non_utf8_exit_code_yields_none_not_panic() {
    // Exit code slot is `0xFF 0xFE` — not valid UTF-8 and not a decimal.
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend_from_slice(b"\x1b]133;D;");
    bytes.extend_from_slice(&[0xFF, 0xFE]);
    bytes.extend_from_slice(b"\x1b\\");
    let events = drive_chunks(&[&bytes]);
    assert_eq!(
        events,
        vec![BoundaryEvent::CommandDone { exit_code: None }],
        "non-UTF-8 exit code must surface as None without panic"
    );
}

/// Random binary (including 0x00 NUL bytes) in plain output: the detector
/// must not panic, must emit zero events, and must leave state clean enough
/// that a subsequent legitimate marker still fires.
#[test]
fn random_binary_and_null_bytes_do_not_panic_or_poison_state() {
    let binary: [u8; 9] = [0x00, 0xFF, 0x7F, 0x80, 0x81, 0xFE, 0x00, 0x01, 0x02];
    let events = drive_chunks(&[&binary]);
    assert!(events.is_empty());

    // Now verify state is not poisoned — a legitimate marker still fires.
    let mut det = VteBoundaryDetector::new();
    let mut sink: Vec<BoundaryEvent> = Vec::new();
    det.feed(&binary, &mut sink);
    det.feed(b"\x1b]133;A\x1b\\", &mut sink);
    assert_eq!(sink, vec![BoundaryEvent::PromptStart]);
}

/// OSC 7 carrying a ZWJ-composed emoji path. The emoji encodes 8 bytes
/// (`F0 9F 91 8B` + `F0 9F 8F BD`) and the path bytes are fed in chunks that
/// split the emoji between its code units. The detector must emit one
/// CwdAdvertised with the full path string.
#[test]
fn osc7_with_emoji_zwj_split_across_chunks_produces_one_event() {
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend_from_slice(b"\x1b]7;file://localhost/tmp/");
    bytes.extend_from_slice(&WAVING_HAND);
    bytes.extend_from_slice(&SKIN_TONE_MED);
    bytes.extend_from_slice(b"\x1b\\");

    // Split right inside the waving-hand emoji.
    let split = bytes.iter().position(|&b| b == 0xF0).unwrap() + 2;
    let events = drive_chunks(&[&bytes[..split], &bytes[split..]]);
    // The path is a concatenation of the 4-byte emoji and the 4-byte skin-tone
    // modifier. Assert the event exists and the path contains the expected
    // substring (avoid locale-dependent display quirks by checking bytes).
    assert_eq!(events.len(), 1, "expected one CwdAdvertised event");
    let BoundaryEvent::CwdAdvertised { cwd } = &events[0] else {
        panic!("expected CwdAdvertised, got {:?}", events[0]);
    };
    assert!(
        cwd.starts_with("/tmp/"),
        "cwd must start with /tmp/, got {cwd:?}"
    );
    // Round-trip through UTF-8 without loss: the cwd bytes must include the
    // full waving-hand + skin-tone sequence unchanged.
    let cwd_bytes = cwd.as_bytes();
    assert!(cwd_bytes
        .windows(WAVING_HAND.len())
        .any(|w| w == WAVING_HAND));
    assert!(cwd_bytes
        .windows(SKIN_TONE_MED.len())
        .any(|w| w == SKIN_TONE_MED));
}

/// OSC 7 with a Chinese cwd split at an arbitrary mid-codepoint byte. The
/// resulting event must carry the full round-tripped path.
#[test]
fn osc7_with_chinese_path_split_roundtrips_unchanged() {
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend_from_slice(b"\x1b]7;file://localhost/home/");
    bytes.extend_from_slice(&NI_BYTES);
    bytes.extend_from_slice(&HAO_BYTES);
    bytes.extend_from_slice(b"\x1b\\");

    // Split inside the first Chinese character.
    let events = drive_chunks(&[&bytes[..bytes.len() - 5], &bytes[bytes.len() - 5..]]);
    assert_eq!(
        events,
        vec![BoundaryEvent::CwdAdvertised {
            cwd: "/home/你好".to_string(),
        }]
    );
}
