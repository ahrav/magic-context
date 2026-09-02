//! Validates peer-controlled descriptors before exposing lease-bound shared-memory spans.

#![warn(missing_docs)]
#![deny(unsafe_op_in_unsafe_fn)]

/// Allocates arena spans and accounts for their states.
pub mod arena;
/// Implements transport backends.
pub mod backend;
/// Validates peer-controlled frame descriptors.
pub mod descriptor;
/// Counts operations used to qualify transport behavior.
pub mod evidence;
/// Decodes untrusted bytes for fuzz and contract tests.
pub mod harness;
/// Binds mapped frame spans to receive lease lifetimes.
pub mod lease;
/// Enforces ordered transport shutdown.
pub mod lifecycle;
/// Validates hardware profiles and accounts for admission.
pub mod profile;
/// Setup-handshake proof transcript shared by both peers.
pub mod setup_auth;

pub use arena::{MAX_FRAME_BYTES, MIN_ARENA_BYTES};
pub use descriptor::{Incarnation, ReleaseIdentity, WIRE_V2_HEADER_BYTES};
pub use lease::{LeaseSpan, ReceiveLease};
