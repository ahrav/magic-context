//! Fuzz entry point for [`mc_shm_transport::harness::provider_sample`], an immutable
//! byte decoder with no fd, mmap, provider, or thread effects.
//! Running under libFuzzer requires nightly (`cargo +nightly fuzz run
//! provider_sample`); the target compiles on stable. commentlint: allow(JUDGE)
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = mc_shm_transport::harness::provider_sample(data);
});
