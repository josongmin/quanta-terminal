//! Keystroke → rendered cell latency benchmark (RFC §13.12 — p95 ≤ 16 ms).
//!
//! **Status: stub.** The real benchmark measures the round trip from a
//! synthetic `KeyboardEvent` through the input encoder, PTY, VT engine,
//! reducer, renderer dirty-rect, and GPU flush. None of those layers
//! exist end-to-end at the time this benchmark lands; the goal is to
//! pin the criterion wiring so the baseline numbers in
//! `docs/perf-baselines.md` can be populated stage-by-stage as each
//! EPIC delivers its layer.
//!
//! What this file does today: simulates the reducer-apply stage by
//! repeatedly calling [`quanta_metrics::record_stage`] with a small
//! synthetic delta. It fails **nothing** — it exists so CI's
//! `cargo bench -p quanta-perf-harness --no-run` compiles and the
//! perf workflow has a target to run.
//!
//! When EPIC-B (VT engine) and EPIC-D (renderer) land, replace the
//! synthetic loop with the actual stage invocations. The assertion
//! wiring (> 10 % regression fails CI) already lives in
//! `.github/workflows/perf.yml`.

use std::time::Duration;

use criterion::{criterion_group, criterion_main, Criterion};
use quanta_metrics::{record_stage, InMemoryRecorder, PerfStage};

/// Cheap synthetic reducer stand-in. Spins through a fixed-size byte
/// buffer summing bytes so the compiler does not fold it into a
/// constant, then reports a stage observation.
fn simulate_reducer_apply(recorder: &InMemoryRecorder, payload: &[u8]) -> u64 {
    let start = std::time::Instant::now();
    let mut checksum: u64 = 0;
    for &b in payload {
        // `wrapping_add` keeps the optimiser from hoisting the loop.
        checksum = checksum.wrapping_add(u64::from(b));
    }
    let elapsed = start.elapsed();
    record_stage(recorder, PerfStage::ReducerApply, elapsed);
    checksum
}

fn bench_keystroke_latency(c: &mut Criterion) {
    let recorder = InMemoryRecorder::new();

    // Payload size roughly matches a single keystroke's worth of
    // echo + prompt-update delta bytes on a typical zsh line. Not a
    // load-bearing number — it's a synthetic stand-in.
    let payload = vec![0x42u8; 1_024];

    let mut group = c.benchmark_group("keystroke_latency");
    // p95 budget is 16 ms; sampling noise at sub-ms scales is high on
    // a shared CI runner. Keep the group's minimum measurement time
    // conservative so the run is stable but quick.
    group.measurement_time(Duration::from_secs(5));
    group.bench_function("reducer_apply_stub", |b| {
        b.iter(|| simulate_reducer_apply(&recorder, &payload));
    });
    group.finish();
}

criterion_group!(benches, bench_keystroke_latency);
criterion_main!(benches);
