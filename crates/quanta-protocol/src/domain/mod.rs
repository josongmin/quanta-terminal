//! Codec domain — pure encode/decode of control-plane and event-plane frames.

use serde::{Deserialize, Serialize};

use quanta_proto::envelope::Envelope;
use quanta_proto::events::Event;
use quanta_proto::protocol::{Hello, Incompatible, Ready};
use quanta_proto::rpc::{RpcMethod, RpcRequest, RpcResponse};

/// A single control-plane message. The client sends `Hello`, requests, and
/// `Goodbye`; the server replies with `Ready` / `Incompatible` / responses.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlMessage {
    Hello(Hello),
    Ready(Ready),
    Incompatible(Incompatible),
    /// A concrete RPC request wrapped in `RpcRequest`.
    Request(RpcRequest<RpcMethod>),
    /// A raw-JSON response; the method's result shape is carried as `serde_json::Value`
    /// so the codec does not need to know every concrete RPC type.
    Response(RpcResponse<serde_json::Value>),
    Ping {
        seq: u64,
    },
    Pong {
        seq: u64,
    },
    Goodbye {
        reason: String,
    },
    /// Resume-cursor replay failed for `session_id`. Emitted by the server
    /// when `ControlHandler::replay_since` returns `LogUnavailable`. The
    /// host should surface "resume failed; please reconnect fresh" to the
    /// UI rather than silently showing an empty session (FIX 2).
    ReplayFailed {
        session_id: String,
        reason: String,
    },
}

/// Encode a control-plane message as a newline-terminated JSON line.
pub fn encode_control(msg: &ControlMessage) -> Result<Vec<u8>, serde_json::Error> {
    let mut v = serde_json::to_vec(msg)?;
    v.push(b'\n');
    Ok(v)
}

/// Decode a single newline-delimited JSON control message from `line`.
///
/// The trailing newline is tolerated but not required.
pub fn decode_control(line: &[u8]) -> Result<ControlMessage, serde_json::Error> {
    let trimmed = trim_newline(line);
    serde_json::from_slice(trimmed)
}

/// Encode an event envelope as a length-prefixed `MessagePack` frame.
pub fn encode_event(env: &Envelope<Event>) -> Result<Vec<u8>, rmp_serde::encode::Error> {
    let body = rmp_serde::to_vec_named(env)?;
    let len_u32 = u32::try_from(body.len())
        .map_err(|_| rmp_serde::encode::Error::Syntax("frame > u32::MAX".into()))?;
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&len_u32.to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// Decode a `MessagePack` frame body (i.e. the payload after the 4-byte length
/// prefix has been stripped).
pub fn decode_event(frame: &[u8]) -> Result<Envelope<Event>, rmp_serde::decode::Error> {
    rmp_serde::from_slice(frame)
}

fn trim_newline(b: &[u8]) -> &[u8] {
    if let Some(stripped) = b.strip_suffix(b"\n") {
        if let Some(stripped) = stripped.strip_suffix(b"\r") {
            stripped
        } else {
            stripped
        }
    } else {
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use quanta_proto::envelope::{Envelope, Producer, SchemaVersion};
    use quanta_proto::events::{BlockCreated, CwdSource, InputKind};
    use quanta_proto::ids::{BlockId, SessionId};

    #[test]
    fn control_roundtrips() {
        let msg = ControlMessage::Ping { seq: 7 };
        let line = encode_control(&msg).unwrap();
        assert!(line.ends_with(b"\n"));
        let back = decode_control(&line).unwrap();
        match back {
            ControlMessage::Ping { seq } => assert_eq!(seq, 7),
            _ => panic!("unexpected"),
        }
    }

    #[test]
    fn event_frame_roundtrips() {
        let env = Envelope::new(
            SessionId::new(),
            1,
            Producer::Block,
            SchemaVersion::ONE,
            Event::BlockCreated(BlockCreated {
                block_id: BlockId::new(),
                ordinal: 0,
                input_text: "echo hi".into(),
                input_kind: InputKind::Shell,
                cwd: "/tmp".into(),
                cwd_source: CwdSource::Launch,
                is_compound: false,
            }),
        );
        let frame = encode_event(&env).unwrap();
        assert_eq!(
            u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize,
            frame.len() - 4
        );
        let back = decode_event(&frame[4..]).unwrap();
        assert_eq!(back.monotonic_seq, 1);
    }
}
