//! Backends use same direct producer and scoped receive ownership.

#[cfg(feature = "iceoryx")]
/// iceoryx2 complete-frame sample adapter.
pub mod iceoryx;
/// Sealed descriptor-ring and FIFO arena.
pub mod ring;
/// Pure exact-consumption sample-prefix decoding.
pub mod sample;
