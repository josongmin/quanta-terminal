//! DCS (Device Control String) partial-sequence recovery tests.
//!
//! The `vte` parser (adapter layer) drives hook/put/unhook for DCS. The
//! engine currently only recognises `DCS 1 $ q` / `DCS 2 $ q` (synchronized
//! update begin/end); every other DCS payload is accumulated but emits no
//! event (`DcsKind::Unknown`).
//!
//! What matters for these tests is **state-machine hygiene**: however the
//! DCS payload is terminated (ST, BEL, another ESC, truncation), the parser
//! must return to Ground in time for the next CSI / OSC / printable to be
//! handled correctly. "Recovery" here means: after a malformed or
//! unrecognised DCS, can the grid still react to `ESC [ H` etc.?

mod common;

use common::grid;
use quanta_vt::TerminalEvent;

/// Utility: did the feed emit a `SynchronizedUpdate::Begin`?
fn saw_sync_begin(events: &[TerminalEvent]) -> bool {
    use quanta_vt::SyncUpdatePayload;
    events
        .iter()
        .any(|e| matches!(e, TerminalEvent::SynchronizedUpdate(SyncUpdatePayload::Begin)))
}

/// Utility: did the feed emit a `SynchronizedUpdate::End`?
fn saw_sync_end(events: &[TerminalEvent]) -> bool {
    use quanta_vt::SyncUpdatePayload;
    events
        .iter()
        .any(|e| matches!(e, TerminalEvent::SynchronizedUpdate(SyncUpdatePayload::End)))
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Well-formed DCS envelopes — sanity that the happy path works before
//    stressing recovery.
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn dcs_complete_with_st_returns_to_ground() {
    // Full DCS-ignored payload followed by ST, then a plain print.
    // If the parser returns to Ground, "X" must land at (0,0).
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1bPunknown-payload-abc\x1b\\X");
    let snap = g.snapshot();
    assert_eq!(snap.cells[0][0].grapheme.as_str(), "X");
}

#[test]
fn dcs_bel_terminates_and_trailing_print_reaches_ground() {
    // Upstream `vte` does **not** accept BEL (0x07) as an ST surrogate
    // inside DCS. The adapter works around that by pre-filtering the
    // byte stream: when we detect BEL inside a DCS envelope we rewrite
    // it to `ESC \` before handing it to vte, matching the behaviour
    // most real-world apps already expect (they use BEL for both OSC
    // and DCS termination). This test pins the working path.
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1bPfoo\x07Y");
    let snap = g.snapshot();
    assert_eq!(
        snap.cells[0][0].grapheme.as_str(),
        "Y",
        "BEL must terminate the DCS so the trailing 'Y' reaches Ground"
    );

    // A follow-up CSI H + print must also work without any recovery
    // kick — Ground is already restored.
    let _ = g.feed(b"\x1b[H!");
    let snap = g.snapshot();
    assert_eq!(
        snap.cells[0][0].grapheme.as_str(),
        "!",
        "CSI H after the BEL-terminated DCS must land '!' at origin"
    );
}

#[test]
fn dcs_bel_termination_within_single_feed_mixed_with_sync() {
    // BEL-terminated DCS followed immediately by a synchronised-update
    // DCS — the prefilter must hand control cleanly back to vte so the
    // subsequent sync event still fires. Exercises the prefilter's
    // DcsActive → Ground transition on rewritten ST.
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1bPjunk\x07\x1bP=1$q\x1b\\X");
    assert!(
        saw_sync_begin(&events),
        "sync begin should fire after BEL-terminated DCS"
    );
    let snap = g.snapshot();
    assert_eq!(
        snap.cells[0][0].grapheme.as_str(),
        "X",
        "trailing print must land after BEL-DCS + sync-DCS"
    );
}

#[test]
fn dcs_sync_begin_emits_event() {
    // The one DCS we actually react to: `ESC P 1 $ q ESC \`.
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1bP=1$q\x1b\\");
    assert!(
        saw_sync_begin(&events),
        "expected SynchronizedUpdate::Begin; got {events:?}"
    );
}

#[test]
fn dcs_sync_end_emits_event() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1bP=2$q\x1b\\");
    assert!(
        saw_sync_end(&events),
        "expected SynchronizedUpdate::End; got {events:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────
// 2. The core recovery scenario: a DCS hook is taken but the payload is
//    cut off mid-stream by a CAN / SUB / brand-new ESC. The grid must
//    still respond to the follow-up CSI `H` (cursor home).
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn dcs_partial_then_cancel_then_csi_recovers() {
    // CAN (0x18) aborts any in-flight escape per ECMA-48 §5.4.2. After
    // CAN the parser is back in Ground and a normal CSI must dispatch.
    let mut g = grid(5, 10);
    let _ = g.feed(b"\x1b[3;3H");
    assert_eq!(g.cursor().row, 2);
    assert_eq!(g.cursor().col, 2);

    // Enter DCS, push some bytes, then CAN → followed by CSI H (home).
    let _ = g.feed(b"\x1bPpartial\x18\x1b[H");
    assert_eq!(
        (g.cursor().row, g.cursor().col),
        (0, 0),
        "CSI H after DCS + CAN must re-home the cursor"
    );
}

#[test]
fn dcs_partial_then_sub_then_csi_recovers() {
    // SUB (0x1A) — like CAN but also displays a substitute character in
    // some engines. For our purposes the parser MUST still return to
    // Ground so the trailing CSI is honoured.
    let mut g = grid(5, 10);
    let _ = g.feed(b"\x1b[3;3H\x1bPhalfway\x1a\x1b[H");
    assert_eq!((g.cursor().row, g.cursor().col), (0, 0));
}

#[test]
fn dcs_partial_then_new_esc_csi_recovers() {
    // No explicit terminator — a fresh ESC starts a new escape sequence,
    // which forces the DCS to close (implicit abort). The follow-up
    // `ESC [ H` must dispatch CUP.
    let mut g = grid(5, 10);
    let _ = g.feed(b"\x1b[4;5H");
    let _ = g.feed(b"\x1bPbroken\x1b[H");
    // The first `\x1b` after `broken` is the only ESC; `[H` is the CSI
    // body. If the parser recovers, cursor is (0, 0).
    assert_eq!((g.cursor().row, g.cursor().col), (0, 0));
}

#[test]
fn dcs_esc_followed_by_non_backslash_does_not_abort() {
    // `ESC P ... ESC X` where X is not `\` — in strict vte this is
    // ambiguous: the inner ESC might start a nested escape. We don't
    // assert the inner behaviour, only that the parser eventually comes
    // back to Ground for a subsequent print. "Z" is our Ground probe.
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1bPfoo\x1bAbarZ");
    // Whatever happens to the DCS body and the `ESC A` in the middle,
    // a trailing printable must land somewhere on the grid.
    let snap = g.snapshot();
    let row0: String = snap.cells[0].iter().map(|c| c.grapheme.as_str()).collect();
    assert!(
        row0.contains('Z'),
        "expected 'Z' somewhere on row 0 after DCS + inner ESC + print; got {row0:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Stress — payload length, repeated abort/recover cycles, memory.
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn dcs_long_payload_does_not_panic_and_recovers() {
    // 64 KiB of `A`s inside a DCS envelope — the accumulator should just
    // buffer it, dispatch as Unknown on unhook, and free the buffer.
    let mut g = grid(5, 10);
    let mut bytes = Vec::with_capacity(70_000);
    bytes.extend_from_slice(b"\x1bP");
    bytes.extend(std::iter::repeat(b'A').take(65_536));
    bytes.extend_from_slice(b"\x1b\\"); // ST
    bytes.extend_from_slice(b"\x1b[H"); // CUP home
    bytes.extend_from_slice(b"Q");

    let _ = g.feed(&bytes);
    let snap = g.snapshot();
    assert_eq!(
        snap.cells[0][0].grapheme.as_str(),
        "Q",
        "trailing 'Q' after long DCS must print at origin"
    );
}

#[test]
fn dcs_partial_flushed_across_multiple_feeds() {
    // The parser must tolerate the DCS envelope being split across
    // `feed()` calls: bytes arrive via a PTY one chunk at a time.
    let mut g = grid(5, 10);
    let _ = g.feed(b"\x1bPabc");
    let _ = g.feed(b"def\x1b");
    let _ = g.feed(b"\\"); // completes ST
    let _ = g.feed(b"\x1b[H");
    let _ = g.feed(b"!");
    let snap = g.snapshot();
    assert_eq!(
        snap.cells[0][0].grapheme.as_str(),
        "!",
        "split-feed DCS + CSI H + print must place '!' at origin"
    );
}

#[test]
fn dcs_repeated_abort_recovery_stays_stable() {
    // Hammer the Ground↔DCS transitions to check the accumulator is
    // properly reset each unhook. We alternate half-DCS + CSI H and
    // verify the cursor is home every cycle.
    let mut g = grid(5, 10);
    for _ in 0..32 {
        let _ = g.feed(b"\x1b[4;5H");
        let _ = g.feed(b"\x1bPxyz\x18\x1b[H");
        assert_eq!(
            (g.cursor().row, g.cursor().col),
            (0, 0),
            "cursor must reset every cycle"
        );
    }
}

#[test]
fn dcs_sync_begin_then_partial_dcs_then_csi() {
    // Real-world flow: the app enters sync mode, then sends an unknown
    // DCS, then normal CSI rendering. The engine should surface Begin,
    // ignore the unknown DCS, and still honour the CSI.
    let mut g = grid(5, 10);
    let events = g.feed(b"\x1bP=1$q\x1b\\\x1bPweird-blob\x1b\\\x1b[2;3H");
    assert!(saw_sync_begin(&events), "sync begin should fire");
    assert_eq!(
        (g.cursor().row, g.cursor().col),
        (1, 2),
        "CSI after two DCSes must still move the cursor"
    );
}
