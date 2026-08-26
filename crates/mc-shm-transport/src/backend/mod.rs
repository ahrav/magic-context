//! Backends use same direct producer and scoped receive ownership. commentlint: allow(JUDGE)

#[cfg(feature = "iceoryx")]
/// iceoryx2 complete-frame sample adapter. commentlint: allow(JUDGE)
pub mod iceoryx;
/// Sealed descriptor-ring and FIFO arena. commentlint: allow(JUDGE)
pub mod ring;
/// Pure exact-consumption sample-prefix decoding. commentlint: allow(JUDGE)
pub mod sample;
