use std::hint::black_box;
use std::time::Duration;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use mc_secret_scanner::{ScanLimits, ScanProfile, Scanner};

#[path = "support/corpus.rs"]
mod corpus;

use corpus::{anchor_bait, finding_dense, storm, zero_anchor};

fn scan_comprehensive(c: &mut Criterion) {
    let scanner = Scanner::new(ScanProfile::Comprehensive).unwrap();
    let mut group = c.benchmark_group("scan_comprehensive");
    group.warm_up_time(Duration::from_millis(400));
    group.measurement_time(Duration::from_secs(2));
    group.sample_size(20);
    let cases: Vec<(String, String)> = vec![
        ("zero_anchor_256".into(), zero_anchor(256, 11)),
        ("zero_anchor_4k".into(), zero_anchor(4 << 10, 12)),
        ("zero_anchor_64k".into(), zero_anchor(64 << 10, 13)),
        ("zero_anchor_512k".into(), zero_anchor(512 << 10, 14)),
        ("anchor_bait_4k".into(), anchor_bait(4 << 10, 21)),
        ("anchor_bait_64k".into(), anchor_bait(64 << 10, 22)),
        ("dense_4k".into(), finding_dense(4 << 10, 31)),
        ("dense_64k".into(), finding_dense(64 << 10, 32)),
        ("storm_64k".into(), storm(64 << 10)),
    ];
    for (name, input) in &cases {
        group.throughput(Throughput::Bytes(input.len() as u64));
        group.bench_with_input(BenchmarkId::from_parameter(name), input, |b, input| {
            b.iter(|| scanner.scan(black_box(input)).unwrap());
        });
    }
    group.finish();
}

fn scan_conservative(c: &mut Criterion) {
    let scanner = Scanner::new(ScanProfile::Conservative).unwrap();
    let mut group = c.benchmark_group("scan_conservative");
    group.warm_up_time(Duration::from_millis(400));
    group.measurement_time(Duration::from_secs(2));
    group.sample_size(20);
    let cases: Vec<(String, String)> = vec![
        ("zero_anchor_64k".into(), zero_anchor(64 << 10, 13)),
        ("dense_4k".into(), finding_dense(4 << 10, 31)),
    ];
    for (name, input) in &cases {
        group.throughput(Throughput::Bytes(input.len() as u64));
        group.bench_with_input(BenchmarkId::from_parameter(name), input, |b, input| {
            b.iter(|| scanner.scan(black_box(input)).unwrap());
        });
    }
    group.finish();
}

fn construction(c: &mut Criterion) {
    let mut group = c.benchmark_group("construction");
    group.warm_up_time(Duration::from_millis(400));
    group.measurement_time(Duration::from_secs(3));
    group.sample_size(10);
    group.bench_function("scanner_with_limits", |b| {
        b.iter(|| {
            Scanner::with_limits(
                black_box(ScanProfile::Comprehensive),
                black_box(ScanLimits::default()),
            )
            .unwrap()
        });
    });
    group.finish();
}

criterion_group!(benches, scan_comprehensive, scan_conservative, construction);
criterion_main!(benches);
