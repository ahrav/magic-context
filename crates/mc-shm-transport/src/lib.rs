#![warn(missing_docs)]
#![deny(unsafe_op_in_unsafe_fn)]

//! Transport storage stays charged until publication-ordered completion.
//! Cross-process metadata carries checked offsets and lengths, never pointers.

/// FIFO arena planning and byte-state accounting.
pub mod arena;
/// Shared-memory backend implementations.
pub mod backend;
/// Immutable grant and complete-frame metadata.
pub mod descriptor;
/// Operation-counter evidence gates.
pub mod evidence;
/// Fuzz and corpus-replay decoder entry points.
pub mod harness;
/// Scoped raw-span receive leases.
pub mod lease;
/// Checked close state machine.
pub mod lifecycle;
/// Target profiles and host-wide resource admission.
pub mod profile;

pub use arena::{MAX_FRAME_BYTES, MIN_ARENA_BYTES};
pub use descriptor::{Incarnation, ReleaseIdentity, WIRE_V2_HEADER_BYTES};
pub use lease::{LeaseSpan, ReceiveLease};
