//! Windowed redaction throughput over fixed, seeded corpora.
//!
//! Cells: `windowed/<entry>/<corpus>/<MiB>` where `entry` is `redact`
//! (`Redactor::redact_windowed` with the kernel's detection cap) or
//! `detect_bytes` (`Redactor::detect_windowed_bytes`).
//!
//! `detect_bytes` returns at the first finding, so it is measured only over
//! clean corpora; on a secret-bearing corpus it would scan one window and be
//! credited the whole input's bytes. Setup asserts each corpus is what its
//! `clean` flag claims.
//!
//! `MC_WINDOWED_SIZES=1,8` restricts sizes (MiB); the Criterion filter
//! argument restricts cells by name.

use std::hint::black_box;
use std::time::Duration;

use criterion::{
    criterion_group, criterion_main, BenchmarkId, Criterion, SamplingMode, Throughput,
};
use mc_core::redaction::Redactor;

#[path = "support/windowed_corpus.rs"]
mod corpus;

use corpus::{invalid_utf8_bytes, seed_for, MIB, SIZES, TEXT_CORPORA};

/// Mirrors `mc_kernel::cas::MAX_PAYLOAD_DETECTIONS`, which is not exported.
const MAX_PAYLOAD_DETECTIONS: usize = 4096;

fn sizes() -> Vec<usize> {
    match std::env::var("MC_WINDOWED_SIZES") {
        Ok(list) => list
            .split(',')
            .filter(|item| !item.trim().is_empty())
            .map(|item| item.trim().parse::<usize>().expect("MiB size") * MIB)
            .collect(),
        Err(_) => SIZES.to_vec(),
    }
}

/// `secret_dense` carries one finding per 4 KiB, so above 16 MiB the kernel
/// cap of 4096 detections turns the scan into an early `DetectionLimit` exit.
fn cell_sizes(name: &str) -> Vec<usize> {
    let cap = if name == "secret_dense" {
        16 * MIB
    } else {
        usize::MAX
    };
    sizes().into_iter().filter(|&size| size <= cap).collect()
}

fn windowed(c: &mut Criterion) {
    let redactor = Redactor::new().unwrap();
    let mut group = c.benchmark_group("windowed");
    group.sampling_mode(SamplingMode::Flat);
    group.warm_up_time(Duration::from_millis(500));
    group.measurement_time(Duration::from_secs(2));
    group.sample_size(10);

    for corpus in TEXT_CORPORA {
        let name = corpus.name;
        for size in cell_sizes(name) {
            let input = (corpus.generate)(size, seed_for(name, size));
            let mib = size / MIB;
            let found = redactor.detect_windowed(&input).unwrap();
            assert_eq!(
                found, !corpus.clean,
                "{name}/{mib}: corpus classification does not match the scanner"
            );
            group.throughput(Throughput::Bytes(input.len() as u64));
            group.bench_with_input(
                BenchmarkId::new(format!("redact/{name}"), mib),
                &input,
                |b, input| {
                    b.iter(|| {
                        redactor
                            .redact_windowed(black_box(input), MAX_PAYLOAD_DETECTIONS)
                            .unwrap()
                    })
                },
            );
            if corpus.clean {
                group.bench_with_input(
                    BenchmarkId::new(format!("detect_bytes/{name}"), mib),
                    &input,
                    |b, input| {
                        b.iter(|| {
                            redactor
                                .detect_windowed_bytes(black_box(input.as_bytes()))
                                .unwrap()
                        })
                    },
                );
            }
        }
    }

    for size in cell_sizes("invalid_utf8_bytes") {
        let input = invalid_utf8_bytes(size, seed_for("invalid_utf8_bytes", size));
        let mib = size / MIB;
        assert!(
            !redactor.detect_windowed_bytes(&input).unwrap(),
            "invalid_utf8_bytes/{mib}: corpus is not clean"
        );
        group.throughput(Throughput::Bytes(input.len() as u64));
        group.bench_with_input(
            BenchmarkId::new("detect_bytes/invalid_utf8_bytes", mib),
            &input,
            |b, input| {
                b.iter(|| {
                    redactor
                        .detect_windowed_bytes(black_box(input.as_slice()))
                        .unwrap()
                })
            },
        );
    }
    group.finish();
}

criterion_group!(benches, windowed);
criterion_main!(benches);
