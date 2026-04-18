//! Handshake + control-codec smoke tests (ADR 0004, ADR 0011).
//!
//! Exercises:
//! - Hello from a compatible host produces a Ready response.
//! - Hello from an incompatible host produces an Incompatible response with
//!   a populated reason.
//! - A Request with the same `request_id` replayed across connects is a
//!   no-op at the codec layer (idempotency is a control-layer invariant; the
//!   codec itself just roundtrips the bytes faithfully).

use quanta_proto::protocol::{Hello, Incompatible, ProtocolVersion, Ready};
use quanta_proto::rpc::{CreateSession, RpcMethod, RpcRequest};
use quanta_protocol::{decode_control, encode_control, ControlMessage};

fn simulate_server_reply(hello: &Hello) -> ControlMessage {
    let core = ProtocolVersion::CURRENT;
    if core.is_compatible_with(hello.host_protocol_version) {
        ControlMessage::Ready(Ready {
            core_protocol_version: core,
            core_version: "test-core-0.0.0".into(),
            sidecar_id: "sidecar-01".into(),
            session_recovery_available: false,
        })
    } else {
        ControlMessage::Incompatible(Incompatible {
            reason: format!(
                "host v{} (min {}) vs core v{} (min {})",
                hello.host_protocol_version.version,
                hello.host_protocol_version.min_supported,
                core.version,
                core.min_supported,
            ),
            core_protocol_version: core,
        })
    }
}

#[test]
fn compatible_hello_yields_ready() {
    let hello = Hello {
        host_protocol_version: ProtocolVersion::CURRENT,
        host_version: "host-0.0.0".into(),
        client_id: "test-client".into(),
    };
    // Roundtrip the Hello through the codec (the wire).
    let encoded = encode_control(&ControlMessage::Hello(hello.clone())).unwrap();
    assert!(encoded.ends_with(b"\n"), "lines must be newline-terminated");
    let decoded = decode_control(&encoded).unwrap();
    let hello_back = match decoded {
        ControlMessage::Hello(h) => h,
        other => panic!("expected Hello, got {other:?}"),
    };

    let reply = simulate_server_reply(&hello_back);
    match reply {
        ControlMessage::Ready(r) => {
            assert_eq!(r.core_protocol_version, ProtocolVersion::CURRENT);
            assert!(!r.session_recovery_available);
        }
        other => panic!("expected Ready, got {other:?}"),
    }
}

#[test]
fn incompatible_hello_yields_incompatible_with_reason() {
    // A host that only supports v99, ahead of anything the core knows.
    let hello = Hello {
        host_protocol_version: ProtocolVersion {
            version: 99,
            min_supported: 99,
        },
        host_version: "future-host".into(),
        client_id: "far-future".into(),
    };
    let reply = simulate_server_reply(&hello);
    match reply {
        ControlMessage::Incompatible(inc) => {
            assert!(!inc.reason.is_empty(), "reason must be populated");
            assert!(inc.reason.contains("99"), "reason should mention mismatch");
        }
        other => panic!("expected Incompatible, got {other:?}"),
    }
}

#[test]
fn request_replay_with_same_request_id_roundtrips_identically() {
    // Idempotency smoke: the codec must not mutate `request_id` across
    // encode/decode cycles. The control-layer dedupe is built on top of this
    // invariant.
    let req = RpcRequest {
        request_id: "rpc-idem-42".into(),
        payload: RpcMethod::CreateSession(CreateSession {
            shell: Some("/bin/sh".into()),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        }),
    };
    let msg = ControlMessage::Request(req.clone());
    let encoded1 = encode_control(&msg).unwrap();
    let encoded2 = encode_control(&msg).unwrap();
    // Byte-equal encodings over a second encode: serde + codec must be
    // deterministic on the wire representation of a fixed payload.
    assert_eq!(
        encoded1, encoded2,
        "encode is expected to be deterministic for a fixed control message"
    );

    let decoded1 = decode_control(&encoded1).unwrap();
    let decoded2 = decode_control(&encoded2).unwrap();
    for dec in [decoded1, decoded2] {
        match dec {
            ControlMessage::Request(r) => {
                assert_eq!(r.request_id, "rpc-idem-42");
                match r.payload {
                    RpcMethod::CreateSession(cs) => {
                        assert_eq!(cs.shell.as_deref(), Some("/bin/sh"));
                        assert_eq!(cs.cols, 80);
                        assert_eq!(cs.rows, 24);
                    }
                    other => panic!("expected CreateSession, got {other:?}"),
                }
            }
            other => panic!("expected Request, got {other:?}"),
        }
    }
}

#[test]
fn decode_tolerates_missing_trailing_newline() {
    let hello = ControlMessage::Hello(Hello {
        host_protocol_version: ProtocolVersion::CURRENT,
        host_version: "h".into(),
        client_id: "c".into(),
    });
    let mut bytes = encode_control(&hello).unwrap();
    // Strip the trailing newline and decode; must still parse per
    // `trim_newline`'s contract.
    assert_eq!(bytes.pop(), Some(b'\n'));
    let decoded = decode_control(&bytes).unwrap();
    match decoded {
        ControlMessage::Hello(_) => {}
        other => panic!("expected Hello, got {other:?}"),
    }
}

#[test]
fn ping_pong_roundtrips() {
    let msg = ControlMessage::Ping { seq: 42 };
    let encoded = encode_control(&msg).unwrap();
    let back = decode_control(&encoded).unwrap();
    match back {
        ControlMessage::Ping { seq } => assert_eq!(seq, 42),
        other => panic!("expected Ping, got {other:?}"),
    }
}

#[test]
fn goodbye_roundtrips() {
    let msg = ControlMessage::Goodbye {
        reason: "user closed tab".into(),
    };
    let encoded = encode_control(&msg).unwrap();
    let back = decode_control(&encoded).unwrap();
    match back {
        ControlMessage::Goodbye { reason } => assert_eq!(reason, "user closed tab"),
        other => panic!("expected Goodbye, got {other:?}"),
    }
}
