use sha2::{Digest, Sha256};

/// Lowercase hex SHA-256, matching the digest spelling the manifest and
/// `SOURCE-INVENTORY.md` record.
pub fn digest_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
