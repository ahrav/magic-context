use sha2::{Digest, Sha256};

fn digest_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn pinned_corpus_and_overlay_match_reviewed_sources() {
    assert_eq!(
        digest_hex(include_bytes!("../default_rules.yaml")),
        mc_secret_scanner::UPSTREAM_CORPUS_SHA256
    );
    assert_eq!(
        digest_hex(include_bytes!("../conservative_overlay.yaml")),
        mc_secret_scanner::CONSERVATIVE_OVERLAY_SHA256
    );
}

#[test]
fn provenance_names_every_release_blocking_source() {
    let inventory = include_str!("../SOURCE-INVENTORY.md");
    for required in [
        "https://github.com/ahrav/gossip-rs",
        "3d2869011138cd7812a12f893dc93635a961b0d7",
        "Watched default branch: `main`",
        "909e835f6d19a923aefa84484cd7fa215ffad973",
        mc_secret_scanner::UPSTREAM_CORPUS_SHA256,
        mc_secret_scanner::CONSERVATIVE_OVERLAY_SHA256,
        "Copyright (c) 2026 ahrav",
        "MIT",
    ] {
        assert!(inventory.contains(required), "missing provenance field");
    }
    let dispositions = include_str!("../UPSTREAM-DISPOSITIONS.md");
    assert!(dispositions.contains("Accepted as lift baseline"));
    assert!(dispositions.contains("No post-baseline drift has been reviewed"));

    let gate = include_str!("../../../scripts/check-secret-scanner-upstream-drift.sh");
    for outcome in [
        "fetch-unavailable",
        "missing-ref",
        "source-inventory-mismatch",
        "source-drift",
    ] {
        assert!(gate.contains(outcome), "missing drift outcome {outcome}");
    }
    for path in [
        "crates/scanner-engine/default_rules.yaml",
        "crates/scanner-engine/src/api.rs",
        "crates/scanner-engine/src/rules/yaml.rs",
        "crates/scanner-engine/src/engine/helpers/entropy.rs",
        "crates/scanner-engine/src/engine/offline_validate.rs",
        "crates/scanner-engine/src/engine/safelist.rs",
        "crates/scanner-engine/src/engine/window_validate.rs",
        "LICENSE",
    ] {
        assert!(gate.contains(path), "unwatched source {path}");
    }
}
