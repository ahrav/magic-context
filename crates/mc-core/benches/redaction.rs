use std::hint::black_box;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use mc_core::redaction::Redactor;
use mc_secret_scanner::MAX_INPUT_BYTES;

fn inputs(bytes: usize) -> Vec<(&'static str, String)> {
    let mut keyed = "password=hunter-two ".repeat(bytes / 20 + 1);
    keyed.truncate(bytes);
    vec![("clean", "x".repeat(bytes)), ("keyed", keyed)]
}

fn redaction(c: &mut Criterion) {
    let redactor = Redactor::new().unwrap();
    let mut group = c.benchmark_group("redaction");
    for bytes in [64, 1_024, 16_384, 131_072, MAX_INPUT_BYTES] {
        for (shape, input) in inputs(bytes) {
            group.throughput(Throughput::Bytes(bytes as u64));
            group.bench_with_input(BenchmarkId::new(shape, bytes), &input, |b, input| {
                b.iter(|| redactor.redact(black_box(input)).unwrap())
            });
        }
    }
    group.finish();
}

criterion_group!(benches, redaction);
criterion_main!(benches);
