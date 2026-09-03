//! Validates peer-controlled descriptors before exposing lease-bound shared-memory spans.

#![warn(missing_docs)]
#![deny(unsafe_op_in_unsafe_fn)]

/// Rejects invalid cursor arithmetic while planning arena reservations.
pub mod arena;
/// Contains descriptor-ring transport and complete-frame sample decoding.
pub mod backend;
/// Defines and validates peer-controlled transport descriptors.
pub mod descriptor;
/// Classifies forbidden transport operations from operation counters.
pub mod evidence;
/// Exposes strict byte decoders for fuzzing and corpus replay.
pub mod harness;
/// Binds mapped spans to receive-lease lifetimes.
pub mod lease;
/// Enforces close-state ordering before transport resources are released.
pub mod lifecycle;
/// Checks profile topology and resource limits before admission.
pub mod profile;
/// Setup-handshake proof transcript shared by both peers.
pub mod setup_auth;

pub use arena::{MAX_FRAME_BYTES, MIN_ARENA_BYTES};
pub use descriptor::{Incarnation, ReleaseIdentity, WIRE_V2_HEADER_BYTES};
pub use lease::{LeaseSpan, ReceiveLease};
