//! Setup-handshake transcript shared by `mc-host` and `mc-shm-native`, so the two handshake implementations cannot desynchronize.

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Wire version stamped into a grant and echoed by the activating peer.
pub const PROTOCOL_VERSION: u8 = 2;

/// Nonce bytes each side contributes.
pub const NONCE_LEN: usize = 32;
/// Proof bytes carried by each auth message.
pub const PROOF_LEN: usize = 32;
/// Daemon identity bytes bound into every proof.
pub const DAEMON_ID_LEN: usize = 16;

/// Upper bound on one authentication message body.
pub const MAX_AUTH_MESSAGE_LEN: usize = 4096;
/// Upper bound on one setup message body.
pub const MAX_SETUP_MESSAGE_LEN: usize = 16 * 1024;
/// Descriptors a grant transfers: one ring per direction.
pub const RING_DESCRIPTOR_COUNT: usize = 2;

/// Separates the host's key-possession proof from other MAC inputs.
pub const SERVER_PROOF_DOMAIN: &str = "subc-server-v1";
/// Separates the peer's key-possession proof from other MAC inputs.
pub const CLIENT_AUTH_DOMAIN: &str = "subc-client-v1";
/// Role string a connecting peer presents.
pub const DEFAULT_CLIENT_ROLE: &str = "client";

/// Including `daemon_ver` in the MAC prevents peers without the key from altering the reported daemon version. The length prefix keeps the version boundary unambiguous, so no two distinct (version, id) pairs produce the same MAC input.
pub fn compute_proof(
    key: &[u8],
    domain: &str,
    client_nonce: &[u8; NONCE_LEN],
    server_nonce: &[u8; NONCE_LEN],
    daemon_ver: &str,
    daemon_id: &[u8],
) -> [u8; PROOF_LEN] {
    let daemon_ver_bytes = daemon_ver.as_bytes();
    let daemon_ver_len =
        u32::try_from(daemon_ver_bytes.len()).expect("auth messages bound daemon_ver to u32");
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(domain.as_bytes());
    mac.update(client_nonce);
    mac.update(server_nonce);
    mac.update(&daemon_ver_len.to_be_bytes());
    mac.update(daemon_ver_bytes);
    mac.update(daemon_id);
    mac.finalize().into_bytes().into()
}

/// Committed proof vectors, exposed outside `cfg(test)` so both ends assert against these literals rather than against their own output.
pub mod vectors {
    use super::{DAEMON_ID_LEN, NONCE_LEN, PROOF_LEN};

    /// Daemon version the committed proofs are computed over.
    pub const DAEMON_VER: &str = "mc-host/0.1.0";

    /// Host proof over the committed inputs.
    pub const SERVER_PROOF: [u8; PROOF_LEN] = [
        64, 154, 84, 68, 23, 100, 116, 189, 2, 121, 137, 79, 177, 172, 107, 52, 108, 174, 152, 208,
        218, 25, 249, 160, 154, 212, 42, 68, 91, 108, 85, 131,
    ];

    /// Peer proof over the committed inputs.
    pub const CLIENT_AUTH: [u8; PROOF_LEN] = [
        184, 138, 243, 55, 0, 189, 88, 52, 54, 27, 4, 112, 129, 214, 202, 57, 252, 146, 75, 221,
        119, 177, 247, 0, 193, 206, 206, 26, 90, 147, 247, 187,
    ];

    /// Key `00..1f`, client nonce `20..3f`, server nonce `40..5f`, daemon ID `60..6f`.
    pub fn inputs() -> (
        [u8; 32],
        [u8; NONCE_LEN],
        [u8; NONCE_LEN],
        [u8; DAEMON_ID_LEN],
    ) {
        (
            std::array::from_fn(|index| index as u8),
            std::array::from_fn(|index| index as u8 + 0x20),
            std::array::from_fn(|index| index as u8 + 0x40),
            std::array::from_fn(|index| index as u8 + 0x60),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::vectors;
    use super::*;

    #[test]
    fn committed_vectors_pin_the_shared_construction() {
        let (key, client_nonce, server_nonce, daemon_id) = vectors::inputs();
        assert_eq!(
            compute_proof(
                &key,
                SERVER_PROOF_DOMAIN,
                &client_nonce,
                &server_nonce,
                vectors::DAEMON_VER,
                &daemon_id,
            ),
            vectors::SERVER_PROOF,
        );
        assert_eq!(
            compute_proof(
                &key,
                CLIENT_AUTH_DOMAIN,
                &client_nonce,
                &server_nonce,
                vectors::DAEMON_VER,
                &daemon_id,
            ),
            vectors::CLIENT_AUTH,
        );
    }

    #[test]
    fn daemon_ver_is_bound_into_the_proof() {
        let (key, client_nonce, server_nonce, daemon_id) = vectors::inputs();
        let baseline = compute_proof(
            &key,
            SERVER_PROOF_DOMAIN,
            &client_nonce,
            &server_nonce,
            vectors::DAEMON_VER,
            &daemon_id,
        );
        let tampered = compute_proof(
            &key,
            SERVER_PROOF_DOMAIN,
            &client_nonce,
            &server_nonce,
            "mc-host/9.9.9",
            &daemon_id,
        );
        assert_ne!(baseline, tampered, "daemon_ver must change the proof");
    }

    #[test]
    fn daemon_ver_length_prefix_prevents_field_sliding() {
        let key = [7u8; 32];
        let client_nonce = [1u8; NONCE_LEN];
        let server_nonce = [2u8; NONCE_LEN];
        assert_ne!(
            compute_proof(
                &key,
                SERVER_PROOF_DOMAIN,
                &client_nonce,
                &server_nonce,
                "ab",
                b"cd"
            ),
            compute_proof(
                &key,
                SERVER_PROOF_DOMAIN,
                &client_nonce,
                &server_nonce,
                "abc",
                b"d"
            ),
        );
    }

    #[test]
    fn domains_separate_the_two_proofs() {
        let (key, client_nonce, server_nonce, daemon_id) = vectors::inputs();
        assert_ne!(
            compute_proof(
                &key,
                SERVER_PROOF_DOMAIN,
                &client_nonce,
                &server_nonce,
                vectors::DAEMON_VER,
                &daemon_id,
            ),
            compute_proof(
                &key,
                CLIENT_AUTH_DOMAIN,
                &client_nonce,
                &server_nonce,
                vectors::DAEMON_VER,
                &daemon_id,
            ),
        );
    }
}
