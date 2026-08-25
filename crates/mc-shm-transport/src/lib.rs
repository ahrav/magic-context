#![warn(missing_docs)]
#![deny(unsafe_op_in_unsafe_fn)]

//! Transport storage stays charged until publication-ordered completion. commentlint: allow(JUDGE)
//! Cross-process metadata carries checked offsets and lengths, never pointers. commentlint: allow(JUDGE)

/// FIFO arena planning and byte-state accounting. commentlint: allow(JUDGE)
pub mod arena;
/// Shared-memory backend implementations. commentlint: allow(JUDGE)
pub mod backend;
/// Immutable grant and complete-frame metadata. commentlint: allow(JUDGE)
pub mod descriptor;
/// Operation-counter evidence gates. commentlint: allow(JUDGE)
pub mod evidence;
/// Scoped raw-span receive leases. commentlint: allow(JUDGE)
pub mod lease;
/// Checked close state machine. commentlint: allow(JUDGE)
pub mod lifecycle;
/// Target profiles and host-wide resource admission. commentlint: allow(JUDGE)
pub mod profile;

pub use arena::{MAX_FRAME_BYTES, MIN_ARENA_BYTES};
pub use descriptor::{Incarnation, ReleaseIdentity, WIRE_V2_HEADER_BYTES};
pub use lease::{LeaseSpan, ReceiveLease};
