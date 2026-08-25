//! Stable-rust replay of every checked-in fuzz corpus input.
//!
//! Runs on stable with no libFuzzer or nightly requirement. Each corpus
//! file passes through the same production decoder entry points the fuzz
//! targets call; the harness asserts internally that no accepted input
//! yields an out-of-range view.

use std::fs;
use std::path::Path;

use mc_shm_transport::harness;

const EXPECTED_SEEDS: [&str; 5] = ["empty", "all-zero", "all-ff", "valid", "near-valid"];

fn replay(target: &str, decoder: fn(&[u8]) -> bool) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fuzz/corpus")
        .join(target);
    for seed in EXPECTED_SEEDS {
        assert!(
            dir.join(seed).is_file(),
            "corpus seed {target}/{seed} is missing"
        );
    }
    let mut replayed = 0usize;
    for entry in fs::read_dir(&dir).expect("corpus directory is readable") {
        let path = entry.expect("corpus entry is readable").path();
        if !path.is_file() {
            continue;
        }
        let bytes = fs::read(&path).expect("corpus file is readable");
        let accepted = decoder(&bytes);
        if path.file_name().is_some_and(|name| name == "valid") {
            assert!(accepted, "corpus seed {target}/valid must be accepted");
        }
        replayed += 1;
    }
    assert!(
        replayed >= EXPECTED_SEEDS.len(),
        "corpus for {target} lost seeds"
    );
}

#[test]
fn frame_descriptor_corpus_replays_without_panic() {
    replay("frame_descriptor", harness::frame_descriptor);
}

#[test]
fn provider_grant_corpus_replays_without_panic() {
    replay("provider_grant", harness::provider_grant);
}

#[test]
fn provider_sample_corpus_replays_without_panic() {
    replay("provider_sample", harness::provider_sample);
}
