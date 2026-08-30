//! Fuzz entry point for [`mc_shm_transport::harness::frame_descriptor`], an immutable
//! byte decoder with no fd, mmap, provider, or thread effects.
//! Running under libFuzzer requires nightly (`cargo +nightly fuzz run
//! frame_descriptor`); the target compiles on stable.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = mc_shm_transport::harness::frame_descriptor(data);
});
