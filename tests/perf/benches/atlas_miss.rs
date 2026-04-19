//! Atlas-miss recovery benchmark.
//!
//! **Status: stub.** The real benchmark measures the glyph-atlas
//! miss path: pick a grapheme not in the LRU, rasterize it, upload
//! the bitmap, and render it into the dirty row. RFC §13.13 budgets
//! this at ~3 ms p95 for a single miss.
//!
//! Before the renderer lands (EPIC-D) there's nothing to measure.
//! This file exists so criterion's test-bench discovery has the
//! target registered and the workflow has a named entry to run.

use std::time::Duration;

use criterion::{criterion_group, criterion_main, Criterion};
use quanta_metrics::{record_stage, InMemoryRecorder, PerfStage};

fn simulate_atlas_miss(recorder: &InMemoryRecorder) {
    let start = std::time::Instant::now();
    // Pretend-work: a 64 × 64 bitmap fill at 4 bytes per pixel.
    let mut pixels = [0u8; 64 * 64 * 4];
    for (i, px) in pixels.iter_mut().enumerate() {
        *px = (i as u8).wrapping_mul(13);
    }
    // Prevent the compiler from eliding the whole thing.
    criterion::black_box(&pixels);
    let elapsed = start.elapsed();
    record_stage(recorder, PerfStage::AtlasMissRecovery, elapsed);
}

fn bench_atlas_miss(c: &mut Criterion) {
    let recorder = InMemoryRecorder::new();

    let mut group = c.benchmark_group("atlas_miss");
    group.measurement_time(Duration::from_secs(3));
    group.bench_function("rasterize_64x64_stub", |b| {
        b.iter(|| simulate_atlas_miss(&recorder));
    });
    group.finish();
}

criterion_group!(benches, bench_atlas_miss);
criterion_main!(benches);
