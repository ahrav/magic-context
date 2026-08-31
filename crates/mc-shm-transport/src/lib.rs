#![warn(missing_docs)]
#![deny(unsafe_op_in_unsafe_fn)]

pub mod arena;
pub mod backend;
pub mod descriptor;
pub mod evidence;
pub mod harness;
pub mod lease;
pub mod lifecycle;
pub mod profile;

pub use arena::{MAX_FRAME_BYTES, MIN_ARENA_BYTES};
pub use descriptor::{Incarnation, ReleaseIdentity, WIRE_V2_HEADER_BYTES};
pub use lease::{LeaseSpan, ReceiveLease};
