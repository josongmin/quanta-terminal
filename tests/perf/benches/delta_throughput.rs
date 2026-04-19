//! Delta-throughput benchmark — 1 MB/s synthetic stream.
//!
//! **Status: stub.** Feeds a 1 MB synthetic byte stream through a
//! placeholder reducer stand-in. Post-EPIC-B / EPIC-C, wire in the
//! real VT engine + delta encoder so the benchmark reflects actual
//! apply cost.
//!
//! RFC §13.12 target: sustain 60 fps while ingesting ~1 MB/s of PTY
//! output (roughly what `yes | head -10000` produces). Translated to
//! a per-frame apply budget of ~16 ms + delta throughput of ~16 KB /
//! frame at 60 fps. This bench measures the aggregate apply cost for
//! the full 1 MB.

use std::time::Duration;

use criterion::{criterion_group, criterion_main, Criterion};
use quanta_metrics::{record_stage, InMemoryRecorder, PerfStage};

/// Build a deterministic 1 MB byte stream. A repeating pattern keeps
/// the benchmark reproducible without forcing the compiler to
/// constant-fold — we consume the bytes in a checksum, not a branch.
fn synthetic_stream_1mb() -> Vec<u8> {
    // 1 MiB. The scale matches RFC §13.12's "200 KB/s steady" delta
    // rate multiplied by ~5 s of production output.
    let size = 1024 * 1024;
    (0..size).map(|i| ((i * 31) & 0xff) as u8).collect()
}

fn apply_stream(recorder: &InMemoryRecorder, stream: &[u8]) -> u64 {
    let start = std::time::Instant::now();
    // Sum in 128-byte chunks as a stand-in for the reducer's
    // per-event walk.
    let mut checksum: u64 = 0;
    for chunk in stream.chunks(128) {
        for &b in chunk {
            checksum = checksum.wrapping_add(u64::from(b));
        }
    }
    let elapsed = start.elapsed();
    record_stage(recorder, PerfStage::ReducerApply, elapsed);
    checksum
}

fn bench_delta_throughput(c: &mut Criterion) {
    let recorder = InMemoryRecorder::new();
    let stream = synthetic_stream_1mb();

    let mut group = c.benchmark_group("delta_throughput");
    group.throughput(criterion::Throughput::Bytes(stream.len() as u64));
    group.measurement_time(Duration::from_secs(5));
    group.bench_function("apply_1mib_stub", |b| {
        b.iter(|| apply_stream(&recorder, &stream));
    });
    group.finish();
}

criterion_group!(benches, bench_delta_throughput);
criterion_main!(benches);
