//! OSC 52 (clipboard) subparameter-chain tests.
//!
//! OSC 52 syntax per xterm (`Ps = 52`):
//!
//! ```text
//!   OSC 52 ; Pc ; Pd ST
//! ```
//!
//! where `Pc` is zero-or-more selection characters from
//! `c p q s 0 1 2 3 4 5 6 7` (clipboard / primary / secondary / select /
//! cut-buffers 0–7) and `Pd` is base64 payload — or the literal `?` to
//! request a read.
//!
//! The engine (see `crates/quanta-vt/src/adapters/vte_processor.rs`) parses
//! OSC 52 and emits [`TerminalEvent::ClipboardRequest`] with
//! [`ClipboardPayload::Set { selection, extra_selections, data }`] or
//! `Query { selection, extra_selections }`. Base64 decoding, clipboard
//! integration, and payload-size policy are **out of scope for the VT
//! engine** — they live in the session / host adapter layer. These tests
//! pin the engine-side contract.

mod common;

use common::grid;
use quanta_vt::{ClipboardPayload, TerminalEvent};

/// Collect every clipboard payload emitted by a feed.
fn clipboard_payloads(events: &[TerminalEvent]) -> Vec<ClipboardPayload> {
    events
        .iter()
        .filter_map(|e| match e {
            TerminalEvent::ClipboardRequest(p) => Some(p.clone()),
            _ => None,
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Happy path: OSC 52 ; c ; <b64> ST — the canonical write to the
//    system clipboard.
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn osc_52_set_clipboard_st_terminated() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]52;c;aGVsbG8=\x1b\\");
    let payloads = clipboard_payloads(&events);
    assert_eq!(
        payloads,
        vec![ClipboardPayload::Set {
            selection: b'c',
            extra_selections: Vec::new(),
            data: "aGVsbG8=".to_string(),
        }]
    );
}

#[test]
fn osc_52_set_clipboard_bel_terminated() {
    // BEL-termination is accepted by most real-world apps (tmux,
    // vim-osc52). Our `vte` adapter exposes it as `bell_terminated: true`
    // in `osc_dispatch` but we don't expose that flag — the event must
    // still fire with the correct payload.
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]52;c;aGVsbG8=\x07");
    assert_eq!(
        clipboard_payloads(&events),
        vec![ClipboardPayload::Set {
            selection: b'c',
            extra_selections: Vec::new(),
            data: "aGVsbG8=".to_string(),
        }]
    );
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Selection prefixes — `p` (primary), `s` (select), `q` (secondary),
//    cut-buffers. Current engine reads the FIRST byte of the second
//    parameter as the selection code; multi-char prefixes collapse to
//    the first byte. These tests pin that behaviour.
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn osc_52_primary_selection() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]52;p;Zm9v\x07");
    assert_eq!(
        clipboard_payloads(&events),
        vec![ClipboardPayload::Set {
            selection: b'p',
            extra_selections: Vec::new(),
            data: "Zm9v".to_string(),
        }]
    );
}

#[test]
fn osc_52_select_secondary_cutbuffer() {
    // Three single-char prefixes in one feed.
    let mut g = grid(3, 10);
    let events = g.feed(
        b"\x1b]52;s;YWFh\x07\
          \x1b]52;q;YmJi\x07\
          \x1b]52;0;Y2Nj\x07",
    );
    let payloads = clipboard_payloads(&events);
    assert_eq!(payloads.len(), 3);
    assert!(matches!(
        payloads[0],
        ClipboardPayload::Set {
            selection: b's',
            ref extra_selections,
            ref data
        } if data == "YWFh" && extra_selections.is_empty()
    ));
    assert!(matches!(
        payloads[1],
        ClipboardPayload::Set {
            selection: b'q',
            ref extra_selections,
            ref data
        } if data == "YmJi" && extra_selections.is_empty()
    ));
    assert!(matches!(
        payloads[2],
        ClipboardPayload::Set {
            selection: b'0',
            ref extra_selections,
            ref data
        } if data == "Y2Nj" && extra_selections.is_empty()
    ));
}

#[test]
fn osc_52_multi_selection_prefix_pc_preserves_all_targets() {
    // xterm docs: the `Pc` field can be multiple chars, e.g. `pc` to
    // target both primary and clipboard. The engine surfaces the first
    // char as `selection` (primary target, ergonomic for consumers that
    // only care about one) and the remainder via `extra_selections` so
    // host adapters can broadcast the write to every requested target.
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]52;pc;YWJj\x07");
    assert_eq!(
        clipboard_payloads(&events),
        vec![ClipboardPayload::Set {
            selection: b'p',
            extra_selections: vec![b'c'],
            data: "YWJj".to_string(),
        }],
        "multi-char selection must expose all targets"
    );
}

#[test]
fn osc_52_multi_selection_prefix_multiple_extras_preserved() {
    // Three-char selection (primary + clipboard + secondary) should
    // keep every target.
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]52;pcq;YWJj\x07");
    assert_eq!(
        clipboard_payloads(&events),
        vec![ClipboardPayload::Set {
            selection: b'p',
            extra_selections: vec![b'c', b'q'],
            data: "YWJj".to_string(),
        }]
    );
}

#[test]
fn osc_52_multi_selection_query_preserves_all_targets() {
    // Multi-selection query must also keep every target so the host
    // adapter can respond to the right selection set.
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]52;pc;?\x07");
    assert_eq!(
        clipboard_payloads(&events),
        vec![ClipboardPayload::Query {
            selection: b'p',
            extra_selections: vec![b'c'],
        }]
    );
}

#[test]
fn osc_52_empty_selection_defaults_to_c() {
    // `OSC 52 ; ; <payload> ST` — empty selection field. xterm treats
    // this as `s0` (cut-buffer 0). Our engine falls back to `c`
    // (clipboard) — a reasonable default but worth pinning.
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]52;;aGVsbG8=\x07");
    assert_eq!(
        clipboard_payloads(&events),
        vec![ClipboardPayload::Set {
            selection: b'c',
            extra_selections: Vec::new(),
            data: "aGVsbG8=".to_string(),
        }],
        "missing selection defaults to 'c'"
    );
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Query (`?`) — the read-clipboard side.
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn osc_52_query_clipboard() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]52;c;?\x07");
    assert_eq!(
        clipboard_payloads(&events),
        vec![ClipboardPayload::Query {
            selection: b'c',
            extra_selections: Vec::new(),
        }]
    );
}

#[test]
fn osc_52_query_primary_selection() {
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]52;p;?\x1b\\");
    assert_eq!(
        clipboard_payloads(&events),
        vec![ClipboardPayload::Query {
            selection: b'p',
            extra_selections: Vec::new(),
        }]
    );
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Robustness — malformed base64, missing payload, trailing garbage.
//    The engine must NOT decode base64 (that's the host layer's job), so
//    "malformed" means "still forwarded as-is, no crash".
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn osc_52_malformed_base64_still_dispatched() {
    // `!@#` is not valid base64. Engine should still emit the event
    // with the raw string; the session actor / host decides how to fail.
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]52;c;!@#not-base64!@#\x07");
    assert_eq!(
        clipboard_payloads(&events),
        vec![ClipboardPayload::Set {
            selection: b'c',
            extra_selections: Vec::new(),
            data: "!@#not-base64!@#".to_string(),
        }]
    );
}

#[test]
fn osc_52_missing_payload_is_empty_set() {
    // `OSC 52 ; c ; ST` — no third param. Current engine emits an
    // empty-string Set. (An alternative would be to treat this as a
    // no-op or a clear; pinning the current behaviour.)
    let mut g = grid(3, 10);
    let events = g.feed(b"\x1b]52;c\x07");
    assert_eq!(
        clipboard_payloads(&events),
        vec![ClipboardPayload::Set {
            selection: b'c',
            extra_selections: Vec::new(),
            data: String::new(),
        }]
    );
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Payload-size stress — a 64 KiB base64 blob.
//
//    **Observed behaviour / production gap**: the upstream `vte` crate
//    caps OSC parameter buffers at ~1 KiB (in practice we observe 1021
//    bytes of payload surviving). Anything beyond that is silently
//    dropped, and the OSC is still dispatched with the truncated body.
//    For OSC 52 this means large clipboard writes from the shell (e.g.
//    `base64 big.bin | xclip`) will be clipped at the VT layer without
//    any event indicating truncation.
//
//    This test pins the current quirk so that if we later swap parsers
//    or raise the `vte` limit, the change is visible.
// ─────────────────────────────────────────────────────────────────────────

/// The observed per-OSC-parameter ceiling from the upstream `vte` crate.
/// Encoded as a test-local constant so the intent is obvious.
const OSC_PARAM_BUFFER_CAP: usize = 1021;

#[test]
fn osc_52_64k_payload_truncated_at_vte_buffer_cap() {
    let mut g = grid(3, 10);
    let payload_len = 65_536;
    let mut bytes = Vec::with_capacity(payload_len + 16);
    bytes.extend_from_slice(b"\x1b]52;c;");
    bytes.extend(std::iter::repeat(b'A').take(payload_len));
    bytes.extend_from_slice(b"\x07");

    let events = g.feed(&bytes);
    let payloads = clipboard_payloads(&events);
    assert_eq!(payloads.len(), 1, "one clipboard event is still emitted");
    match &payloads[0] {
        ClipboardPayload::Set {
            selection,
            extra_selections,
            data,
        } => {
            assert_eq!(*selection, b'c');
            assert!(
                extra_selections.is_empty(),
                "single-char selection should not populate extras"
            );
            assert!(
                data.len() <= payload_len,
                "truncated payload must not exceed input length"
            );
            assert_eq!(
                data.len(),
                OSC_PARAM_BUFFER_CAP,
                "engine currently truncates at the vte parser's OSC param cap"
            );
            assert!(
                data.chars().all(|c| c == 'A'),
                "the surviving bytes must still all be the original 'A' payload"
            );
        }
        other => panic!("expected Set; got {other:?}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Interleaving — OSC 52 must not disturb the rest of the stream.
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn osc_52_does_not_consume_following_csi() {
    let mut g = grid(3, 10);
    let _ = g.feed(b"\x1b]52;c;aGk=\x07\x1b[H");
    assert_eq!((g.cursor().row, g.cursor().col), (0, 0));
}

#[test]
fn osc_52_batched_back_to_back_all_emit() {
    // Several OSC 52 write/query events in one feed should produce one
    // event per envelope, in order.
    let mut g = grid(3, 10);
    let events = g.feed(
        b"\x1b]52;c;YQ==\x07\
          \x1b]52;p;Yg==\x1b\\\
          \x1b]52;c;?\x07",
    );
    let payloads = clipboard_payloads(&events);
    assert_eq!(payloads.len(), 3);
    assert!(matches!(
        payloads[0],
        ClipboardPayload::Set {
            selection: b'c',
            ref extra_selections,
            ref data
        } if data == "YQ==" && extra_selections.is_empty()
    ));
    assert!(matches!(
        payloads[1],
        ClipboardPayload::Set {
            selection: b'p',
            ref extra_selections,
            ref data
        } if data == "Yg==" && extra_selections.is_empty()
    ));
    assert!(matches!(
        payloads[2],
        ClipboardPayload::Query {
            selection: b'c',
            ref extra_selections,
        } if extra_selections.is_empty()
    ));
}
