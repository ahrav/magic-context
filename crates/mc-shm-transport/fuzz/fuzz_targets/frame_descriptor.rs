//! Frame-descriptor fuzzing treats every byte slice as valid harness input.
//!
//! Malformed descriptors must return through harness validation rather than panic;
//! any panic is a fuzz finding.

#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = mc_shm_transport::harness::frame_descriptor(data);
});
