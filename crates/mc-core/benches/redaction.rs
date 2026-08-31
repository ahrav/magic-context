use std::hint::black_box;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use mc_core::redaction::{RedactionMode, Redactor};

fn redaction(c: &mut Criterion) {
    let redactor = Redactor::new(RedactionMode::LegacyComparison).unwrap();
    let mut group = c.benchmark_group("redaction_comparison");
    for bytes in [64, 1_024, 16_384, 131_072] {
        let input = "x".repeat(bytes);
        group.throughput(Throughput::Bytes(bytes as u64));
        group.bench_with_input(BenchmarkId::from_parameter(bytes), &input, |b, input| {
            b.iter(|| redactor.redact(black_box(input)).unwrap());
        });
    }
    group.finish();
}

criterion_group!(benches, redaction);
criterion_main!(benches);
