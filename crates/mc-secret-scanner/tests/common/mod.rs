//! Shared digest helper for secret-scanner integration fixtures.

use sha2::{Digest, Sha256};

/// Returns a 64-character lowercase hexadecimal SHA-256 digest.
///
/// This spelling matches manifests and `SOURCE-INVENTORY.md`.
pub fn digest_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
