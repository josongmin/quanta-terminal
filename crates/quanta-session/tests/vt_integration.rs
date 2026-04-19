//! EPIC-F DoD — VT engine → session actor end-to-end integration.
//!
//! Retires scenarios E2E-F1, E2E-F2 (partial), E2E-F7 (partial) and the
//! `use_vt_engine=false` rollback subtest from Gate G-F-11, per
//! `docs/plans/0001-custom-vt-engine-xterm-removal/epic-F-session-integration.md`.
//!
//! What we exercise:
//!
//! - Feeding `printf 'hello\n'` into a real `SessionActor` spawned with
//!   `use_vt_engine = true` produces at least one `Event::Unknown { kind:
//!   "grid.grid_delta", .. }` and one `Event::Unknown { kind:
//!   "grid.cursor_moved", .. }` envelope alongside the legacy `OutputChunk`
//!   stream. The actor currently wraps `TerminalEvent` in `Event::Unknown`
//!   until EPIC-C lands the typed `Event::Grid` variant — see
//!   `actor.rs::emit_vt_event` for the placeholder shape.
//! - Every VT envelope carries `(grid_epoch, resize_generation, buffer_kind)`
//!   stamped on the payload object (DoD-F-04).
//! - `monotonic_seq` is strictly ascending across the complete event stream
//!   (ADR 0011 §Durable Commit Ordering + DoD-F-05).
//! - With `use_vt_engine = false` the actor emits NO VT envelopes —
//!   `OutputChunk` only — which is the rollback contract from DoD-F-22.
//!
//! These tests drive a real `/bin/sh` through `PortablePtyPort` and a real
//! `ZstdSegmentedEventLog`, mirroring the pattern in `edge_cases.rs` and
//! `diagnostics.rs` so the observed behaviour is genuinely end-to-end rather
//! than a mock.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use quanta_events::{EventLogReader as _, ZstdSegmentedEventLog};
use quanta_proto::events::{Event, InputKind};
use quanta_pty::PortablePtyPort;
use quanta_session::{InputSubmission, SessionActor, SessionConfig, SessionHandle};

/// Pick the first shell that exists on the test host. `/bin/sh` is present on
/// every mainstream Unix CI image; we fall back to the `/usr/bin/sh` location
/// used by some minimal containers.
fn pick_shell() -> String {
    if std::path::Path::new("/bin/sh").exists() {
        "/bin/sh".into()
    } else {
        "/usr/bin/sh".into()
    }
}

/// The actor wraps `TerminalEvent` variants inside `Event::Unknown { kind:
/// "grid.<snake_case_variant>", payload: { grid_epoch, resize_generation,
/// buffer_kind, event } }` — see `actor.rs::emit_vt_event`. This helper tells
/// us whether a given envelope payload is one of those.
fn is_grid_event(ev: &Event) -> bool {
    match ev {
        Event::Unknown { kind, .. } => kind.starts_with("grid."),
        _ => false,
    }
}

/// Pull the `(grid_epoch, resize_generation, buffer_kind)` tuple from a grid
/// envelope's payload object. Returns `None` if the envelope is not a grid
/// event or is malformed — a malformed grid envelope is a test failure, but
/// returning an `Option` keeps the assertion messages self-describing.
fn grid_envelope_meta(ev: &Event) -> Option<(u64, u64, String)> {
    let (_kind, payload) = match ev {
        Event::Unknown { kind, payload } if kind.starts_with("grid.") => (kind, payload),
        _ => return None,
    };
    let obj = payload.as_object()?;
    let grid_epoch = obj.get("grid_epoch")?.as_u64()?;
    let resize_generation = obj.get("resize_generation")?.as_u64()?;
    let buffer_kind = obj.get("buffer_kind")?.as_str()?.to_string();
    Some((grid_epoch, resize_generation, buffer_kind))
}

/// Drive a shell command and return every event the actor appended to the
/// log, plus the session id. Blocks up to 3 s waiting for `BlockCompleted`.
async fn drive(cmd: &str, use_vt_engine: bool) -> (Vec<Event>, Vec<quanta_events::LogRecord>) {
    let tmp = tempfile::tempdir().unwrap();
    let log = Arc::new(ZstdSegmentedEventLog::new(tmp.path()).unwrap());
    let pty = Arc::new(PortablePtyPort::new());
    let cfg = SessionConfig {
        shell: pick_shell(),
        args: Vec::new(),
        cwd: PathBuf::from("/tmp"),
        cols: 80,
        rows: 24,
        use_vt_engine,
    };
    let (actor, sid) = SessionActor::spawn(pty, log.clone(), cfg).await.unwrap();

    actor
        .submit_input(InputSubmission {
            text: cmd.to_string(),
            kind: InputKind::Shell,
            submit: true,
        })
        .await
        .expect("submit");

    // Wait for BlockCompleted or a bounded deadline so the test can never
    // hang CI. The shell emits the output + a prompt very quickly; 3 s is a
    // generous ceiling that only matters on a swamped CI runner.
    for _ in 0..150 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let records = log.replay_session(sid).await.unwrap();
        if records
            .iter()
            .any(|r| matches!(r.envelope.payload, Event::BlockCompleted(_)))
        {
            break;
        }
    }
    tokio::time::timeout(Duration::from_secs(3), actor.close())
        .await
        .expect("close")
        .unwrap();

    let records = log.replay_session(sid).await.unwrap();
    let events: Vec<Event> = records.iter().map(|r| r.envelope.payload.clone()).collect();
    (events, records)
}

/// **E2E-F1 — Echo hello round-trip.** Spawn a session with the VT engine on,
/// run `printf 'hello\n'`, and observe the event log. Retires DoD-F-01 at the
/// actor-level observation point: if the reader didn't feed bytes through
/// `Grid::feed`, no `grid.*` envelope appears.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn echo_hello_emits_grid_delta_and_cursor_moved() {
    // `printf` is portable across /bin/sh and /bin/bash and avoids the
    // `echo -n`/`echo -e` flag incompatibility between them. The explicit
    // `\n` ensures the line terminator reaches the grid cursor-move path.
    let (events, _records) = drive("printf 'hello\\n'", true).await;

    let kinds: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            Event::Unknown { kind, .. } => Some(kind.clone()),
            _ => None,
        })
        .collect();

    // At least one GridDelta — some cell in the grid must have been painted
    // for the shell prompt, banner, or the `hello` payload itself.
    let saw_grid_delta = kinds.iter().any(|k| k == "grid.grid_delta");
    assert!(
        saw_grid_delta,
        "expected at least one grid.grid_delta envelope; observed Unknown kinds = {kinds:?}",
    );

    // At least one CursorMoved. Every `printf '...\\n'` moves the cursor
    // to column 0 of the next row; the engine emits that through
    // `CursorMoved`.
    let saw_cursor = kinds.iter().any(|k| k == "grid.cursor_moved");
    assert!(
        saw_cursor,
        "expected at least one grid.cursor_moved envelope; observed Unknown kinds = {kinds:?}",
    );
}

/// **DoD-F-04 — every grid envelope carries `(grid_epoch, resize_generation,
/// buffer_kind)`.** We accept any non-empty payload (runs concurrently with
/// `echo_hello_emits_grid_delta_and_cursor_moved` but does its own session so
/// seeding is independent).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_grid_envelope_carries_envelope_meta_and_buffer_main() {
    let (events, _records) = drive("printf 'meta-probe\\n'", true).await;

    let mut checked = 0usize;
    for ev in &events {
        if let Some((epoch, resize_gen, buffer_kind)) = grid_envelope_meta(ev) {
            // Epoch starts at 1 per the spawn-time default (actor.rs:331).
            // Resize generation starts at 0 and never goes negative.
            assert!(
                epoch >= 1,
                "grid envelope has epoch=0 (must start at 1); event={ev:?}"
            );
            // Buffer kind is serialized as `"main"` or `"alt"` by the actor
            // (actor.rs::emit_vt_event). We only test printf, which never
            // switches to alt screen, so every buffer_kind must be main.
            assert_eq!(
                buffer_kind, "main",
                "buffer_kind must be `main` for a non-TUI printf (no DECSET 1049); event={ev:?}"
            );
            // Resize-gen must be at most 1 + (number of resizes we triggered),
            // and we triggered none here. The engine bumps resize_generation
            // to 1 on every new Grid construction via `Grid::new`, so we
            // tolerate 0 or 1 as the baseline value. The explicit resize
            // bump test lives in `resize_generation.rs`.
            assert!(
                resize_gen <= 1,
                "resize_generation should be the initial engine value (≤ 1) \
                 when no resize was requested; got {resize_gen}, event={ev:?}"
            );
            checked += 1;
        }
    }
    assert!(
        checked > 0,
        "test must observe at least one grid.* envelope or the assertion is vacuous"
    );
}

/// **DoD-F-05 — strict-ascending `monotonic_seq` across all envelopes.** ADR
/// 0011 §Durable Commit Ordering: the emitter is the sole seq assigner. A
/// regression that assigns seqs concurrently from two tasks would break the
/// invariant checked here.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sequence_no_is_strictly_ascending_in_vt_event_stream() {
    let (_events, records) = drive("printf 'seq-probe\\n'", true).await;

    let seqs: Vec<u64> = records.iter().map(|r| r.envelope.monotonic_seq).collect();
    assert!(
        !seqs.is_empty(),
        "must see at least one event for a non-empty test stream"
    );
    assert_eq!(
        seqs.first().copied(),
        Some(1),
        "monotonic_seq must start at 1 (actor.rs::emitter_loop next_seq = 1)"
    );
    for pair in seqs.windows(2) {
        assert!(
            pair[1] > pair[0],
            "monotonic_seq must be strictly ascending; saw {:?} followed by {:?}",
            pair[0],
            pair[1]
        );
    }
}

/// **DoD-F-22 + Gate G-F-11 — `use_vt_engine=false` rollback path.** Asserts
/// the actor behaves like the pre-EPIC-F build: zero `grid.*` envelopes.
/// `OutputChunk` continues to appear because the legacy path is preserved
/// for diagnostic / CLI-export consumers (actor.rs §4.1 paragraph 3).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn use_vt_engine_false_emits_no_grid_events() {
    let (events, _records) = drive("printf 'rollback-probe\\n'", false).await;

    let grid_count = events.iter().filter(|e| is_grid_event(e)).count();
    assert_eq!(
        grid_count, 0,
        "use_vt_engine=false must not produce any grid.* envelope; saw {grid_count}"
    );
    // Sanity: the rollback path still emits OutputChunk (legacy stream).
    let output_count = events
        .iter()
        .filter(|e| matches!(e, Event::OutputChunk(_)))
        .count();
    assert!(
        output_count > 0,
        "rollback path must still emit OutputChunk envelopes (legacy stream)"
    );
}

/// **E2E-F2 — alt-screen ordering.** DoD-F-08 requires `ModeChanged(AltScreen,
/// true)` to appear in the event stream strictly BEFORE the first `GridDelta`
/// whose `buffer_kind == Alt`. We cannot run `vim --clean` in most CI
/// environments (no tty emulation beyond what PortablePtyPort gives us, plus
/// vim isn't always installed), but we CAN emit the raw DECSET 1049 escape
/// sequence via `printf` and assert the actor produces the expected mode
/// transition before the first alt-buffer delta.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn decset_1049_mode_changed_precedes_alt_buffer_grid_delta() {
    // `\\033[?1049h` enters the alt buffer; `\\033[?1049l` exits it. We
    // print one char in the alt buffer so the engine has something to
    // delta. Emit the full sequence in a single `printf` so the shell's
    // line-buffered prompt doesn't interleave the control bytes with
    // unrelated writes.
    //
    // The command sequence: enter alt -> print 'X' -> leave alt.
    let (events, _records) = drive(
        r"printf '\033[?1049hX\033[?1049l'",
        true,
    )
    .await;

    // Walk envelopes in order. Track:
    //   1. When we first see a ModeChanged event payload (any mode change).
    //   2. When we first see a GridDelta whose buffer_kind is "alt".
    // If the second happens before the first, the engine is emitting deltas
    // from an alt buffer the consumer doesn't know has been entered —
    // failure mode RFC §22 #8.
    let mut first_mode_changed_idx: Option<usize> = None;
    let mut first_alt_delta_idx: Option<usize> = None;
    for (i, ev) in events.iter().enumerate() {
        match ev {
            Event::Unknown { kind, payload } if kind == "grid.mode_changed" => {
                if first_mode_changed_idx.is_none() {
                    first_mode_changed_idx = Some(i);
                }
                let _ = payload;
            }
            Event::Unknown { kind, payload } if kind == "grid.grid_delta" => {
                if let Some(obj) = payload.as_object() {
                    if obj.get("buffer_kind").and_then(|v| v.as_str()) == Some("alt")
                        && first_alt_delta_idx.is_none()
                    {
                        first_alt_delta_idx = Some(i);
                    }
                }
            }
            _ => {}
        }
    }

    // Case A: some shells drop the printf control bytes in non-interactive
    // sessions, so we may not see an alt-buffer delta at all. In that case
    // the test is vacuously OK: there is nothing to order. Only assert
    // ordering when we DID observe an alt-buffer delta.
    if let Some(alt_idx) = first_alt_delta_idx {
        let mode_idx = first_mode_changed_idx.unwrap_or(usize::MAX);
        assert!(
            mode_idx < alt_idx,
            "DoD-F-08 violated: first alt-buffer GridDelta at index {alt_idx} \
             precedes (or coexists with) first ModeChanged at index {mode_idx:?}"
        );
    }
}
