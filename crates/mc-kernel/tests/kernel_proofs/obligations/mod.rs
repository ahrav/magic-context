//! One module per design-record correctness obligation the `kernel_proofs` binary proves.

pub mod o10_idempotency;
pub mod o1_staging;
pub mod o2_atomic_repair;
pub mod o3_branch;
pub mod o5_correction;
pub mod o6_deletion;
pub mod o7_stale;
pub mod o8_restart_backup;
pub mod o9_egress;
