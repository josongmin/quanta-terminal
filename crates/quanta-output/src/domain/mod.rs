//! Output span storage — pure, in-memory.
//!
//! The store appends bytes per block, maintaining a running byte offset and a
//! monotonically increasing sequence number per span.

use std::collections::HashMap;

use quanta_proto::events::OutputStream;
use quanta_proto::ids::{BlockId, SpanId};

/// A stored span of bytes from one of the PTY streams, attributed to a block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputSpan {
    pub span_id: SpanId,
    pub block_id: BlockId,
    pub stream: OutputStream,
    pub seq: u64,
    pub byte_offset_start: u64,
    pub byte_offset_end: u64,
    pub bytes: Vec<u8>,
}

/// Outcome of a single append, suitable for producing an `OutputChunk` event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppendOutcome {
    pub span_id: SpanId,
    pub seq: u64,
    pub byte_offset_start: u64,
    pub byte_offset_end: u64,
}

#[derive(Default)]
struct BlockBookkeeping {
    next_seq: u64,
    next_offset: u64,
    spans: Vec<OutputSpan>,
}

/// In-memory output span store.
#[derive(Debug, Default)]
pub struct OutputStore {
    blocks: HashMap<BlockId, BlockBookkeeping>,
}

impl std::fmt::Debug for BlockBookkeeping {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BlockBookkeeping")
            .field("next_seq", &self.next_seq)
            .field("next_offset", &self.next_offset)
            .field("spans_len", &self.spans.len())
            .finish()
    }
}

impl OutputStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Append bytes to a block's output. Returns the outcome describing the
    /// new span. Empty appends are skipped and return `None`.
    pub fn append(
        &mut self,
        block_id: BlockId,
        stream: OutputStream,
        bytes: &[u8],
    ) -> Option<AppendOutcome> {
        if bytes.is_empty() {
            return None;
        }
        let book = self.blocks.entry(block_id).or_default();
        let seq = book.next_seq;
        book.next_seq += 1;
        let start = book.next_offset;
        let end = start + bytes.len() as u64;
        book.next_offset = end;

        let span_id = SpanId::new();
        book.spans.push(OutputSpan {
            span_id,
            block_id,
            stream,
            seq,
            byte_offset_start: start,
            byte_offset_end: end,
            bytes: bytes.to_vec(),
        });

        Some(AppendOutcome {
            span_id,
            seq,
            byte_offset_start: start,
            byte_offset_end: end,
        })
    }

    /// Iterate spans for a block in append order.
    pub fn iter_block<'a>(
        &'a self,
        block_id: &BlockId,
    ) -> Box<dyn Iterator<Item = &'a OutputSpan> + 'a> {
        match self.blocks.get(block_id) {
            Some(b) => Box::new(b.spans.iter()),
            None => Box::new(std::iter::empty()),
        }
    }

    /// Total bytes stored for a block.
    #[must_use]
    pub fn total_bytes(&self, block_id: &BlockId) -> u64 {
        self.blocks.get(block_id).map_or(0, |b| b.next_offset)
    }

    /// Concatenated bytes for a block, in append order.
    #[must_use]
    pub fn concatenate(&self, block_id: &BlockId) -> Vec<u8> {
        let Some(b) = self.blocks.get(block_id) else {
            return Vec::new();
        };
        let cap = usize::try_from(b.next_offset).unwrap_or(usize::MAX);
        let mut out = Vec::with_capacity(cap);
        for s in &b.spans {
            out.extend_from_slice(&s.bytes);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_assigns_monotonic_offsets_and_seqs() {
        let mut store = OutputStore::new();
        let block = BlockId::new();
        let a = store.append(block, OutputStream::Stdout, b"ab").unwrap();
        let b = store.append(block, OutputStream::Stdout, b"cde").unwrap();
        assert_eq!(a.seq, 0);
        assert_eq!(a.byte_offset_start, 0);
        assert_eq!(a.byte_offset_end, 2);
        assert_eq!(b.seq, 1);
        assert_eq!(b.byte_offset_start, 2);
        assert_eq!(b.byte_offset_end, 5);
    }

    #[test]
    fn empty_append_is_a_noop() {
        let mut store = OutputStore::new();
        let block = BlockId::new();
        assert!(store.append(block, OutputStream::Stdout, b"").is_none());
        assert_eq!(store.total_bytes(&block), 0);
    }

    #[test]
    fn concatenate_preserves_order() {
        let mut store = OutputStore::new();
        let block = BlockId::new();
        store
            .append(block, OutputStream::Stdout, b"hello ")
            .unwrap();
        store.append(block, OutputStream::Stdout, b"world").unwrap();
        assert_eq!(store.concatenate(&block), b"hello world");
    }

    #[test]
    fn iter_block_returns_empty_for_unknown_block() {
        let store = OutputStore::new();
        let block = BlockId::new();
        assert_eq!(store.iter_block(&block).count(), 0);
    }

    #[test]
    fn concatenate_unknown_block_returns_empty_vec() {
        let store = OutputStore::new();
        let block = BlockId::new();
        assert_eq!(store.concatenate(&block), Vec::<u8>::new());
    }

    #[test]
    fn total_bytes_accumulates_across_appends() {
        let mut store = OutputStore::new();
        let block = BlockId::new();
        store.append(block, OutputStream::Stdout, b"aa").unwrap();
        store.append(block, OutputStream::Stderr, b"bbb").unwrap();
        store.append(block, OutputStream::Stdout, b"cccc").unwrap();
        assert_eq!(store.total_bytes(&block), 9);
    }

    #[test]
    fn spans_are_independent_per_block() {
        // Two distinct blocks must have independent seq/offset bookkeeping.
        let mut store = OutputStore::new();
        let a = BlockId::new();
        let b = BlockId::new();
        let oa1 = store.append(a, OutputStream::Stdout, b"aaa").unwrap();
        let ob1 = store.append(b, OutputStream::Stdout, b"bb").unwrap();
        let oa2 = store.append(a, OutputStream::Stdout, b"AA").unwrap();
        assert_eq!(oa1.seq, 0);
        assert_eq!(ob1.seq, 0);
        assert_eq!(oa2.seq, 1);
        assert_eq!(oa2.byte_offset_start, 3);
        assert_eq!(store.total_bytes(&a), 5);
        assert_eq!(store.total_bytes(&b), 2);
    }

    #[test]
    fn iter_block_yields_spans_in_append_order() {
        let mut store = OutputStore::new();
        let block = BlockId::new();
        store.append(block, OutputStream::Stdout, b"one").unwrap();
        store.append(block, OutputStream::Stderr, b"two").unwrap();
        store.append(block, OutputStream::Stdout, b"three").unwrap();
        let bytes: Vec<&[u8]> = store
            .iter_block(&block)
            .map(|s| s.bytes.as_slice())
            .collect();
        assert_eq!(bytes, vec![&b"one"[..], &b"two"[..], &b"three"[..]]);
        let seqs: Vec<u64> = store.iter_block(&block).map(|s| s.seq).collect();
        assert_eq!(seqs, vec![0, 1, 2]);
    }

    #[test]
    fn append_outcome_offsets_are_half_open_intervals() {
        // [start, end) — end must equal start + len(bytes).
        let mut store = OutputStore::new();
        let block = BlockId::new();
        let o = store
            .append(block, OutputStream::Stdout, b"1234567")
            .unwrap();
        assert_eq!(o.byte_offset_start, 0);
        assert_eq!(o.byte_offset_end, 7);
        let o2 = store.append(block, OutputStream::Stdout, b"!").unwrap();
        assert_eq!(o2.byte_offset_start, 7);
        assert_eq!(o2.byte_offset_end, 8);
    }

    #[test]
    fn total_bytes_of_unknown_block_is_zero() {
        let store = OutputStore::new();
        assert_eq!(store.total_bytes(&BlockId::new()), 0);
    }

    #[test]
    fn stream_tag_is_preserved_on_span() {
        let mut store = OutputStore::new();
        let block = BlockId::new();
        store.append(block, OutputStream::Stdout, b"o").unwrap();
        store.append(block, OutputStream::Stderr, b"e").unwrap();
        let streams: Vec<OutputStream> = store.iter_block(&block).map(|s| s.stream).collect();
        assert_eq!(streams, vec![OutputStream::Stdout, OutputStream::Stderr]);
    }
}
