//! Both closure and generation stagers use this platform-width mode conversion.
//! stagers.
//!
//! Both stagers pass manifest-committed `u32` `mode` values to rustix.

///
/// `RawMode` is `u32` on Linux and `u16` on Darwin, whereas manifest `mode` is `u32`.
/// Without the cast, the function compiles on Linux and fails on Darwin.
/// Callers use only permission and set-ID bits.
/// Staged output uses `0o600` or `0o700`; manifest validation requires `mode == mode & 0o777`.
/// All callers constrain `mode` to `0o7777`, so the mask preserves every caller value.
#[allow(clippy::unnecessary_cast)]
pub(crate) fn raw_mode(mode: u32) -> rustix::fs::RawMode {
    (mode & 0o7777) as rustix::fs::RawMode
}
