//! Byte-offset bookkeeping under multi-byte input.
//!
//! The OutputStore contract is byte-indexed: offsets count octets, not
//! codepoints or grapheme clusters. When a PTY read splits a CJK codepoint
//! across chunks, the store must:
//!
//! 1. preserve each chunk's bytes verbatim (no `String` conversion);
//! 2. report contiguous `[start, end)` intervals that always sum to
//!    `total_bytes`;
//! 3. concatenate the raw bytes in append order without loss.
//!
//! These tests use fixed byte arrays — random corpora would undermine
//! determinism per the brief.

use quanta_output::OutputStore;
use quanta_proto::events::OutputStream;
use quanta_proto::ids::BlockId;

/// UTF-8 bytes for "한" (= ED 95 9C).
const HAN: [u8; 3] = [0xED, 0x95, 0x9C];
/// UTF-8 bytes for "👋" (= F0 9F 91 8B).
const EMOJI: [u8; 4] = [0xF0, 0x9F, 0x91, 0x8B];

/// Splitting a 3-byte codepoint between two appends must produce contiguous
/// half-open intervals whose concatenation reconstructs the exact codepoint.
#[test]
fn codepoint_split_between_two_appends_preserves_bytes_and_offsets() {
    let mut store = OutputStore::new();
    let block = BlockId::new();

    let a = store
        .append(block, OutputStream::Stdout, &HAN[0..2])
        .expect("first append");
    let b = store
        .append(block, OutputStream::Stdout, &HAN[2..3])
        .expect("second append");

    assert_eq!(a.byte_offset_start, 0);
    assert_eq!(a.byte_offset_end, 2);
    assert_eq!(b.byte_offset_start, 2);
    assert_eq!(b.byte_offset_end, 3);
    assert_eq!(store.total_bytes(&block), 3);
    assert_eq!(store.concatenate(&block), HAN.to_vec());
}

/// A 4-byte emoji split across four single-byte appends: every split point
/// is accounted for in the offset math.
#[test]
fn emoji_split_byte_by_byte_has_perfectly_contiguous_offsets() {
    let mut store = OutputStore::new();
    let block = BlockId::new();

    let mut prev_end = 0u64;
    for (i, b) in EMOJI.iter().enumerate() {
        let outcome = store
            .append(block, OutputStream::Stdout, std::slice::from_ref(b))
            .expect("append");
        assert_eq!(outcome.byte_offset_start, prev_end, "gap at chunk {i}");
        assert_eq!(outcome.byte_offset_end, prev_end + 1, "length wrong at {i}");
        prev_end = outcome.byte_offset_end;
    }
    assert_eq!(store.total_bytes(&block), 4);
    assert_eq!(store.concatenate(&block), EMOJI.to_vec());
}

/// Interleaving stdout and stderr on the same block must still keep a single
/// monotonic offset line — the byte offset is per-block, not per-stream.
#[test]
fn interleaved_streams_share_one_monotonic_offset_line() {
    let mut store = OutputStore::new();
    let block = BlockId::new();

    let a = store
        .append(block, OutputStream::Stdout, &HAN)
        .expect("stdout");
    let b = store
        .append(block, OutputStream::Stderr, &EMOJI)
        .expect("stderr");
    let c = store
        .append(block, OutputStream::Stdout, &HAN)
        .expect("stdout again");

    assert_eq!((a.byte_offset_start, a.byte_offset_end), (0, 3));
    assert_eq!((b.byte_offset_start, b.byte_offset_end), (3, 7));
    assert_eq!((c.byte_offset_start, c.byte_offset_end), (7, 10));
    assert_eq!(store.total_bytes(&block), 10);
}

/// Null bytes inside a CJK-flavored PTY chunk must survive the round-trip.
/// The store is binary-safe, not text.
#[test]
fn null_bytes_inside_cjk_chunk_survive_roundtrip() {
    let mut store = OutputStore::new();
    let block = BlockId::new();
    let mut payload: Vec<u8> = Vec::new();
    payload.extend_from_slice(&HAN);
    payload.push(0x00);
    payload.push(0x00);
    payload.extend_from_slice(&EMOJI);

    let outcome = store.append(block, OutputStream::Stdout, &payload).unwrap();
    assert_eq!(outcome.byte_offset_end, 9);
    assert_eq!(store.concatenate(&block), payload);
}

/// Invalid UTF-8 bytes (lone continuation bytes, etc.) must NOT corrupt
/// offset bookkeeping. The store never decodes to `String`.
#[test]
fn invalid_utf8_bytes_do_not_corrupt_offsets() {
    let mut store = OutputStore::new();
    let block = BlockId::new();
    // Lone continuation byte (illegal UTF-8 leading byte in context).
    let junk: [u8; 5] = [0x9C, 0xFF, 0xC0, 0xFE, 0x80];
    let outcome = store.append(block, OutputStream::Stdout, &junk).unwrap();
    assert_eq!(outcome.byte_offset_end, 5);
    assert_eq!(store.concatenate(&block), junk.to_vec());
}

/// Deterministic table-driven analogue of a property test: a fixed set of
/// chunk sequences, including multi-byte splits, nulls, lone continuation
/// bytes, and empty inserts. For each fixture we assert:
///
/// 1. seq numbers are 0, 1, 2, ... strictly monotonic across non-empty appends;
/// 2. offsets form an unbroken [0, total) chain;
/// 3. empty appends are `None`;
/// 4. `concatenate` returns the exact input bytes in append order.
///
/// A table of fixed fixtures is used instead of a randomized strategy so the
/// test is reproducible byte-for-byte — the CJK bug class demands determinism.
#[test]
fn offset_math_is_consistent_across_named_chunk_fixtures() {
    // Deliberately include the mid-codepoint boundary cases that are the root
    // of the 한글깨짐 class of bugs.
    let fixtures: Vec<Vec<&[u8]>> = vec![
        vec![&HAN[0..2], &HAN[2..3]],
        vec![&EMOJI[0..1], &EMOJI[1..2], &EMOJI[2..3], &EMOJI[3..4]],
        vec![&HAN, &[], &EMOJI, &[], &[0x00, 0x00]],
        vec![&[0xFF, 0xFE], &HAN[1..], &EMOJI],
        vec![b"ascii", &HAN, b"\n", &EMOJI],
        // Lone continuation bytes as a full chunk — valid on the wire, rare
        // on a shell but legal bytes either way.
        vec![&[0x80], &[0x81, 0x82]],
    ];

    for (i, chunks) in fixtures.iter().enumerate() {
        let mut store = OutputStore::new();
        let block = BlockId::new();
        let mut expected: Vec<u8> = Vec::new();
        let mut last_end: u64 = 0;
        let mut expected_seq: u64 = 0;

        for (j, c) in chunks.iter().enumerate() {
            if c.is_empty() {
                assert!(
                    store.append(block, OutputStream::Stdout, c).is_none(),
                    "fixture {i} chunk {j}: empty append must be None"
                );
                continue;
            }
            let outcome = store
                .append(block, OutputStream::Stdout, c)
                .expect("non-empty append yields Some");
            assert_eq!(outcome.seq, expected_seq, "fixture {i} chunk {j}: seq");
            assert_eq!(
                outcome.byte_offset_start, last_end,
                "fixture {i} chunk {j}: start"
            );
            assert_eq!(
                outcome.byte_offset_end,
                last_end + c.len() as u64,
                "fixture {i} chunk {j}: end"
            );
            expected.extend_from_slice(c);
            last_end = outcome.byte_offset_end;
            expected_seq += 1;
        }

        assert_eq!(
            store.total_bytes(&block),
            last_end,
            "fixture {i}: total vs last_end"
        );
        assert_eq!(
            store.total_bytes(&block),
            expected.len() as u64,
            "fixture {i}: total vs expected"
        );
        assert_eq!(
            store.concatenate(&block),
            expected,
            "fixture {i}: concatenate"
        );
    }
}
