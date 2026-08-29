//! Platform-width file mode conversion shared by the closure and generation
//! stagers.
//!
//! Both stagers read a `mode` committed as `u32` by a manifest and hand it to
//! rustix, so the conversion belongs to neither of them alone.

/// Permission bits as rustix's platform-width `RawMode`.
///
/// `RawMode` is `u32` on Linux and `u16` on the Darwin targets, while the
/// manifest commits `mode` as `u32`, so the two cannot meet without an explicit
/// conversion — leaving it implicit compiles on Linux and fails on Darwin. Only
/// the permission and set-id bits are meaningful to any caller here, and every
/// value passed is already within them (0o600 or 0o700 for staged output, and a
/// manifest mode that validation requires to equal `mode & 0o777`), so the mask
/// documents that range rather than narrowing a value that could exceed it.
#[allow(clippy::unnecessary_cast)]
pub(crate) fn raw_mode(mode: u32) -> rustix::fs::RawMode {
    (mode & 0o7777) as rustix::fs::RawMode
}
