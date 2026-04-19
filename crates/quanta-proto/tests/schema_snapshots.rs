//! Frozen JSON schema snapshots for every major payload type.
//!
//! This test is an explicit CI gate on the wire format. If any event payload
//! or envelope changes shape, the pretty-printed JSON output diverges from
//! the on-disk golden file and the test fails. Updating a golden file
//! requires a deliberate human edit: the test refuses to regenerate silently.
//!
//! Fixtures live at `tests/fixtures/schemas/<name>.golden.json`. The naming
//! is 1:1 with the [`Event`] variant (snake-case) or envelope role. To add a
//! new payload, write a constructor below, add the entry to `CASES`, and
//! check in the fresh golden file.
//!
//! The test constructs envelopes / payloads with HARD-CODED ULIDs and a
//! fixed wall-clock so the serialized form is byte-deterministic. Random
//! ids would defeat the snapshot's purpose.

use std::path::PathBuf;
use std::str::FromStr;

use quanta_proto::envelope::{BufferKind, Envelope, Producer, SchemaVersion};
use quanta_proto::events::{
    BlockCanceled, BlockCompleted, BlockCreated, BlockDetached, BlockStarted, BoundaryConfidence,
    BoundarySignal, CwdSource, DetachReason, DiagnosticCategory, DiagnosticDetected,
    DiagnosticSeverity, Event, InputKind, OutputChunk, OutputStream, SessionCreated,
    SessionEndReason, SessionEnded,
};
use quanta_proto::events_grid::{
    BellKindWire, BellRequestedPayload, BlankTag, CellSpanWire, ClipboardOpWire,
    ClipboardRequestPayload, ClipboardSelectionWire, CursorMovedPayload, CursorShapeWire,
    CursorStateWire, GraphemeRunWire, GridDeltaPayload, GridMetaWire, GridSnapshotPayload,
    HyperlinkAddedPayload, HyperlinkRemovedPayload, ModeChangeWire, ModeChangedPayload,
    MouseEncodingWire, MouseTrackingModeWire, RowDeltaWire, SyncPhaseWire,
    SynchronizedUpdatePayload, TerminalModeStateWire, TitleChangedPayload, TitleScopeWire, Utf8Run,
};
use quanta_proto::ids::{BlockId, DiagnosticId, EventId, SessionId, SpanId, WorkspaceId};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// Fixed session id so every envelope snapshot collides on session.
fn fixed_session() -> SessionId {
    SessionId::from_str("01J00000000000000000000001").expect("fixed session ulid parses")
}

fn fixed_block() -> BlockId {
    BlockId::from_str("01J00000000000000000000002").expect("fixed block ulid parses")
}

fn fixed_workspace() -> WorkspaceId {
    WorkspaceId::from_str("01J00000000000000000000003").expect("fixed workspace ulid parses")
}

fn fixed_event() -> EventId {
    EventId::from_str("01J0000000000000000000000A").expect("fixed event ulid parses")
}

fn fixed_span() -> SpanId {
    SpanId::from_str("01J0000000000000000000000S").expect("fixed span ulid parses")
}

fn fixed_diagnostic() -> DiagnosticId {
    DiagnosticId::from_str("01J0000000000000000000000D").expect("fixed diagnostic ulid parses")
}

fn fixed_ts() -> OffsetDateTime {
    // Pin a fixed wall-clock so envelope snapshots are byte-deterministic.
    // Parsed once per test; the RFC3339 form matches what the envelope
    // serializer emits, so round-trips are stable.
    OffsetDateTime::parse("2026-04-19T00:00:00Z", &Rfc3339).expect("fixed ts parses")
}

fn env(producer: Producer, ev: Event) -> Envelope<Event> {
    // Build via raw constructor so we can pin event_id + wall_clock_ts.
    Envelope {
        event_id: fixed_event(),
        monotonic_seq: 1,
        session_id: fixed_session(),
        block_id: Some(fixed_block()),
        wall_clock_ts: fixed_ts(),
        producer_id: producer,
        schema_version: SchemaVersion::ONE,
        causation_id: None,
        grid_epoch: 0,
        resize_generation: 0,
        buffer_kind: BufferKind::Main,
        payload: ev,
    }
}

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("schemas")
}

/// Compare the pretty-printed JSON of `value` against the golden file named
/// `<name>.golden.json`. If the `REGEN_SCHEMAS` env var is set, rewrite the
/// golden instead of failing; this is an escape hatch for a deliberate
/// schema change — CI never sets the var.
fn assert_snapshot<T: serde::Serialize>(name: &str, value: &T) {
    let actual =
        serde_json::to_string_pretty(value).expect("value must serialize to JSON for snapshot");
    let path = fixtures_root().join(format!("{name}.golden.json"));
    if std::env::var_os("REGEN_SCHEMAS").is_some() {
        std::fs::create_dir_all(path.parent().expect("snapshot parent exists"))
            .expect("create fixtures dir");
        let mut with_trailing = actual.clone();
        if !with_trailing.ends_with('\n') {
            with_trailing.push('\n');
        }
        std::fs::write(&path, with_trailing).expect("write regenerated snapshot");
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "missing golden snapshot {}: {err}.\n\
             If this is a deliberate schema change, re-run with \
             `REGEN_SCHEMAS=1 cargo test -p quanta-proto --test schema_snapshots` \
             and commit the updated fixtures.",
            path.display()
        );
    });
    let expected_trimmed = expected.trim_end_matches('\n');
    assert_eq!(
        actual,
        expected_trimmed,
        "schema snapshot mismatch for {name}\n\nIf this is intentional, rerun with \
         REGEN_SCHEMAS=1 to update {}.",
        path.display()
    );
}

#[test]
fn block_created_snapshot() {
    let ev = Event::BlockCreated(BlockCreated {
        block_id: fixed_block(),
        ordinal: 7,
        input_text: "cargo test".into(),
        input_kind: InputKind::Shell,
        cwd: "/workspace".into(),
        cwd_source: CwdSource::Launch,
        is_compound: false,
    });
    assert_snapshot("block_created", &env(Producer::Block, ev));
}

#[test]
fn block_started_snapshot() {
    let ev = Event::BlockStarted(BlockStarted {
        block_id: fixed_block(),
        pid: Some(1234),
    });
    assert_snapshot("block_started", &env(Producer::Block, ev));
}

#[test]
fn block_completed_snapshot() {
    let ev = Event::BlockCompleted(BlockCompleted {
        block_id: fixed_block(),
        exit_code: Some(0),
        termination_signal: None,
        boundary_signal: BoundarySignal::Osc133,
        boundary_confidence: BoundaryConfidence::Authoritative,
    });
    assert_snapshot("block_completed", &env(Producer::Block, ev));
}

#[test]
fn block_canceled_snapshot() {
    let ev = Event::BlockCanceled(BlockCanceled {
        block_id: fixed_block(),
    });
    assert_snapshot("block_canceled", &env(Producer::Block, ev));
}

#[test]
fn block_errored_snapshot() {
    // No `BlockErrored` variant exists today; we surface the same intent
    // through a detached block with `SidecarCrash` reason so the
    // "something went wrong with this block" wire shape is still pinned.
    let ev = Event::BlockDetached(BlockDetached {
        block_id: fixed_block(),
        reason: DetachReason::SidecarCrash,
    });
    assert_snapshot("block_errored", &env(Producer::Block, ev));
}

#[test]
fn output_chunk_snapshot() {
    let ev = Event::OutputChunk(OutputChunk {
        span_id: fixed_span(),
        block_id: fixed_block(),
        stream: OutputStream::Stdout,
        seq: 0,
        byte_offset_start: 0,
        byte_offset_end: 5,
        bytes_b64: "aGVsbG8=".into(),
    });
    assert_snapshot("output_chunk", &env(Producer::Output, ev));
}

#[test]
fn diagnostic_detected_snapshot() {
    let ev = Event::DiagnosticDetected(DiagnosticDetected {
        diagnostic_id: fixed_diagnostic(),
        block_id: fixed_block(),
        parser_id: "rustc".into(),
        category: DiagnosticCategory::Compiler,
        severity: DiagnosticSeverity::Error,
        confidence: 0.95,
        message: "mismatched types".into(),
        path: Some("src/main.rs".into()),
        line: Some(12),
        column: Some(4),
        end_line: Some(12),
        end_column: Some(20),
        symbol: Some("T".into()),
    });
    assert_snapshot("diagnostic_detected", &env(Producer::Diagnostic, ev));
}

#[test]
fn session_created_snapshot() {
    let ev = Event::SessionCreated(SessionCreated {
        session_id: fixed_session(),
        workspace_id: Some(fixed_workspace()),
        shell: "/bin/zsh".into(),
        launch_cwd: "/workspace".into(),
    });
    assert_snapshot("session_created", &env(Producer::Session, ev));
}

#[test]
fn session_ended_snapshot() {
    let ev = Event::SessionEnded(SessionEnded {
        reason: SessionEndReason::ShellExited,
    });
    assert_snapshot("session_ended", &env(Producer::Session, ev));
}

/// Envelope builder for grid-reducer events. Carries the
/// `(grid_epoch, resize_generation, buffer_kind)` tuple required by ADR 0017 §1.
fn grid_env(
    ev: Event,
    grid_epoch: u64,
    sequence_no: u64,
    resize_generation: u64,
    buffer_kind: BufferKind,
) -> Envelope<Event> {
    Envelope {
        event_id: fixed_event(),
        monotonic_seq: sequence_no,
        session_id: fixed_session(),
        block_id: None,
        wall_clock_ts: fixed_ts(),
        producer_id: Producer::Grid,
        schema_version: SchemaVersion::ONE,
        causation_id: None,
        grid_epoch,
        resize_generation,
        buffer_kind,
        payload: ev,
    }
}

/// 2×4 blank grid — the canonical "hello, brand-new terminal" snapshot.
fn sample_grid_snapshot() -> GridSnapshotPayload {
    GridSnapshotPayload {
        rows: 2,
        cols: 4,
        buffer_kind: BufferKind::Main,
        row_deltas: (0..2)
            .map(|row| RowDeltaWire {
                row,
                revision_before: 0,
                revision_after: 1,
                spans: vec![CellSpanWire {
                    cols: 4,
                    sgr: "0x0000000000000000".into(),
                    graphemes: GraphemeRunWire::Blank(BlankTag::Blank),
                    hyperlink_id: 0,
                    ext: None,
                }],
                continuation: false,
                hyperlink_refs: vec![],
            })
            .collect(),
        cursor: Some(CursorStateWire {
            row: 0,
            col: 0,
            visible: true,
            shape: CursorShapeWire::Block,
            blinking: true,
            pending_wrap: false,
        }),
        mode_state: TerminalModeStateWire::default(),
        meta: GridMetaWire::default(),
    }
}

#[test]
fn grid_snapshot_snapshot() {
    let ev = Event::GridSnapshot(sample_grid_snapshot());
    assert_snapshot("grid_snapshot", &grid_env(ev, 1, 0, 0, BufferKind::Main));
}

#[test]
fn grid_delta_snapshot() {
    let ev = Event::GridDelta(GridDeltaPayload {
        row_deltas: vec![RowDeltaWire {
            row: 10,
            revision_before: 17,
            revision_after: 18,
            spans: vec![
                // "한" — 3 UTF-8 bytes, occupies 2 cols.
                CellSpanWire {
                    cols: 2,
                    sgr: "0x018000FF00FF000033".into(),
                    graphemes: GraphemeRunWire::Inline {
                        utf8: Utf8Run::Bytes(vec![237, 149, 156]),
                    },
                    hyperlink_id: 0,
                    ext: None,
                },
                // Blank tail.
                CellSpanWire {
                    cols: 78,
                    sgr: "0x0000000000000000".into(),
                    graphemes: GraphemeRunWire::Blank(BlankTag::Blank),
                    hyperlink_id: 0,
                    ext: None,
                },
            ],
            continuation: false,
            hyperlink_refs: vec![],
        }],
        scrolls: vec![],
        scrollback_appended: 0,
    });
    assert_snapshot("grid_delta", &grid_env(ev, 1, 42, 0, BufferKind::Main));
}

#[test]
fn cursor_moved_snapshot() {
    let ev = Event::CursorMoved(CursorMovedPayload {
        cursor: CursorStateWire {
            row: 0,
            col: 0,
            visible: true,
            shape: CursorShapeWire::Block,
            blinking: false,
            pending_wrap: false,
        },
    });
    assert_snapshot(
        "grid_cursor_moved",
        &grid_env(ev, 1, 55, 0, BufferKind::Alt),
    );
}

#[test]
fn mode_changed_snapshot() {
    let state = TerminalModeStateWire {
        decckm: false,
        bracketed_paste: false,
        focus_reporting: false,
        mouse_tracking: MouseTrackingModeWire::ButtonEvent,
        mouse_encoding: MouseEncodingWire::Sgr,
        modify_other_keys: 0,
        kitty_keyboard: 0,
        alt_screen: true,
        synchronized_update: false,
    };
    let ev = Event::ModeChanged(ModeChangedPayload {
        changes: vec![
            ModeChangeWire::AltScreen { value: true },
            ModeChangeWire::MouseTracking {
                value: MouseTrackingModeWire::ButtonEvent,
            },
            ModeChangeWire::MouseEncoding {
                value: MouseEncodingWire::Sgr,
            },
        ],
        state,
    });
    assert_snapshot(
        "grid_mode_changed",
        &grid_env(ev, 1, 54, 0, BufferKind::Main),
    );
}

#[test]
fn title_changed_snapshot() {
    let ev = Event::TitleChanged(TitleChangedPayload {
        title: "user@host: ~/projects/quanta-terminal".into(),
        scope: TitleScopeWire::Both,
    });
    assert_snapshot(
        "grid_title_changed",
        &grid_env(ev, 1, 12, 0, BufferKind::Main),
    );
}

#[test]
fn bell_requested_snapshot() {
    let ev = Event::BellRequested(BellRequestedPayload {
        kind_of_bell: BellKindWire::Audible,
    });
    assert_snapshot(
        "grid_bell_requested",
        &grid_env(ev, 1, 88, 0, BufferKind::Main),
    );
}

#[test]
fn hyperlink_added_snapshot() {
    let ev = Event::HyperlinkAdded(HyperlinkAddedPayload {
        id: 1,
        uri: "https://example.com/very/long/path?q=1".into(),
        params: Some("id=ln1".into()),
    });
    assert_snapshot(
        "grid_hyperlink_added",
        &grid_env(ev, 1, 120, 0, BufferKind::Main),
    );
}

#[test]
fn hyperlink_removed_snapshot() {
    let ev = Event::HyperlinkRemoved(HyperlinkRemovedPayload { id: 1 });
    assert_snapshot(
        "grid_hyperlink_removed",
        &grid_env(ev, 1, 9001, 0, BufferKind::Main),
    );
}

#[test]
fn clipboard_request_snapshot() {
    let ev = Event::ClipboardRequest(ClipboardRequestPayload {
        selection: ClipboardSelectionWire::Clipboard,
        op: ClipboardOpWire::Set {
            base64_data: "SGVsbG8sIHdvcmxkIQ==".into(),
        },
    });
    assert_snapshot(
        "grid_clipboard_request",
        &grid_env(ev, 1, 33, 0, BufferKind::Main),
    );
}

#[test]
fn synchronized_update_begin_snapshot() {
    let ev = Event::SynchronizedUpdate(SynchronizedUpdatePayload {
        phase: SyncPhaseWire::Begin,
    });
    assert_snapshot(
        "grid_synchronized_update_begin",
        &grid_env(ev, 1, 500, 0, BufferKind::Alt),
    );
}

#[test]
fn synchronized_update_end_snapshot() {
    let ev = Event::SynchronizedUpdate(SynchronizedUpdatePayload {
        phase: SyncPhaseWire::End,
    });
    assert_snapshot(
        "grid_synchronized_update_end",
        &grid_env(ev, 1, 501, 0, BufferKind::Alt),
    );
}

/// Every grid-envelope carries the three grid ordering fields on the wire.
/// Separately verifies the new fields materialize and round-trip.
#[test]
fn grid_envelope_ordering_round_trips() {
    let ev = Event::BellRequested(BellRequestedPayload {
        kind_of_bell: BellKindWire::Visual,
    });
    let e = grid_env(ev, 3, 99, 5, BufferKind::Alt);
    let j = serde_json::to_string(&e).unwrap();
    // The three grid fields must appear on wire for non-default tuples.
    assert!(j.contains("\"grid_epoch\":3"));
    assert!(j.contains("\"resize_generation\":5"));
    assert!(j.contains("\"buffer_kind\":\"alt\""));
    let back: Envelope<Event> = serde_json::from_str(&j).unwrap();
    assert_eq!(back.grid_epoch, 3);
    assert_eq!(back.resize_generation, 5);
    assert_eq!(back.buffer_kind, BufferKind::Alt);
}

/// Back-compat: a golden JSON emitted by "this build" must parse cleanly into
/// typed `Envelope<Event>` (no `Unknown` fallback) for every golden we ship.
/// This is the read-side sibling of the write-side snapshot tests above.
#[test]
fn every_golden_round_trips_to_typed_variant() {
    for entry in std::fs::read_dir(fixtures_root()).expect("read fixtures dir") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = std::fs::read_to_string(&path).expect("read fixture");
        let env: Envelope<Event> = serde_json::from_str(&raw)
            .unwrap_or_else(|err| panic!("golden {} failed to parse: {err}", path.display()));
        assert!(
            !matches!(env.payload, Event::Unknown { .. }),
            "golden {} must parse to a typed variant, not Unknown",
            path.display()
        );
    }
}

/// Forward-compat: if a future schema adds an optional field to an event
/// payload, old builds receiving the new JSON must still parse cleanly into
/// the typed variant. We simulate that by injecting an unknown field into
/// each golden and asserting the decode still succeeds.
#[test]
fn golden_json_tolerates_new_optional_fields() {
    for entry in std::fs::read_dir(fixtures_root()).expect("read fixtures dir") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = std::fs::read_to_string(&path).expect("read fixture");
        let mut v: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON fixture");
        // Inject an unknown field at the payload level.
        if let Some(payload) = v.get_mut("payload").and_then(|p| p.as_object_mut()) {
            payload.insert(
                "reserved_by_future_version".to_string(),
                serde_json::Value::String("ignore me".into()),
            );
        }
        let env: Envelope<Event> = serde_json::from_value(v).unwrap_or_else(|err| {
            panic!("forward-compat parse failed for {}: {err}", path.display())
        });
        assert!(
            !matches!(env.payload, Event::Unknown { .. }),
            "unknown field should be tolerated on {}, not collapse to Unknown",
            path.display()
        );
    }
}
