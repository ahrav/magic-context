//! Fixed ring transport and complete-frame metadata decoding.

/// Sealed descriptor-ring and FIFO arena. commentlint: allow(JUDGE)
pub mod ring;
/// Pure exact-consumption sample-prefix decoding. commentlint: allow(JUDGE)
pub mod sample;
