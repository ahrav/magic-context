//! Cross-artifact conformance: constants the Rust runtime hardcodes must
//! equal the values the generated release artifacts publish, and the Rust
//! canonical manifest encoder must reproduce the TypeScript-generated
//! closure digests exactly. Each equality is load-bearing at runtime — a
//! drifted fingerprint label mismatches every presented credential
//! fingerprint, and a drifted canonical encoding makes every qualified
//! closure digest unverifiable at spawn — so the drift must fail the build,
//! not the deployment.

use mc_host::broca::subprocess::{
    CREDENTIAL_FINGERPRINT_CANONICALIZATION, CREDENTIAL_FINGERPRINT_DOMAIN,
    CREDENTIAL_ROW_CAP_BYTES, CREDENTIAL_VALUE_CAP_BYTES,
};
use mc_host::harness_closure::{manifest_digest, ClosureManifest};

#[test]
fn credential_constants_match_the_release_contract() {
    let contract: serde_json::Value =
        serde_json::from_str(mc_module::release_contract::RELEASE_CONTRACT_JSON)
            .expect("release contract parses");

    let fingerprint = &contract["credential_fingerprint"];
    assert_eq!(
        fingerprint["domain"].as_str(),
        Some(CREDENTIAL_FINGERPRINT_DOMAIN),
        "fingerprint key-derivation domain must match the published contract"
    );
    assert_eq!(
        fingerprint["canonicalization"].as_str(),
        Some(CREDENTIAL_FINGERPRINT_CANONICALIZATION),
        "fingerprint canonicalization id must match the published contract"
    );

    let caps = &contract["harness_unavailable"];
    assert_eq!(
        caps["value_cap_bytes"].as_u64(),
        Some(CREDENTIAL_VALUE_CAP_BYTES as u64),
        "credential value cap must match the published contract"
    );
    assert_eq!(
        caps["row_cap_bytes"].as_u64(),
        Some(CREDENTIAL_ROW_CAP_BYTES as u64),
        "credential row cap must match the published contract"
    );
}

#[test]
fn provider_credential_matrix_matches_the_published_doc() {
    let doc: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../release/mc-host-provider-credentials.json"
        ))
        .expect("provider credentials doc is readable"),
    )
    .expect("provider credentials doc parses");

    // Every published (harness, provider) row and alias must resolve through
    // the runtime's canonicalization to exactly the published canonical
    // name, and the published credential variable must match the runtime's
    // row selection; a published row the runtime cannot serve (or the
    // reverse) splits qualification from runtime behavior.
    let runtime_variable = |provider: &str| match provider {
        "anthropic" => "ANTHROPIC_API_KEY",
        "google" => "GEMINI_API_KEY",
        "openai" => "OPENAI_API_KEY",
        other => panic!("published provider {other} has no runtime variable"),
    };
    let harnesses = doc["harnesses"]
        .as_object()
        .expect("harnesses object is published");
    assert_eq!(
        harnesses.keys().collect::<Vec<_>>(),
        vec!["opencode", "pi"],
        "published harness set must match the runtime allowlist"
    );
    for (harness, spec) in harnesses {
        let providers = spec["providers"]
            .as_object()
            .expect("providers object is published");
        assert_eq!(
            providers.keys().collect::<Vec<_>>(),
            vec!["anthropic", "google", "openai"],
            "published provider set for {harness} must match the runtime allowlist"
        );
        for (provider, row) in providers {
            assert_eq!(
                mc_host::broca::subprocess::canonical_provider(harness, provider),
                Ok(provider.as_str()),
                "canonical provider {provider} must be accepted for {harness}"
            );
            assert_eq!(
                row["credential_variables"]
                    .as_array()
                    .expect("credential_variables is an array")
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>(),
                vec![runtime_variable(provider)],
                "published variable for {harness}/{provider} must match the runtime row selection"
            );
        }
        let aliases = spec["aliases"]
            .as_object()
            .expect("aliases object is published");
        for (alias, spec) in aliases {
            let canonical = spec["canonical"].as_str().expect("alias canonical name");
            assert_eq!(
                mc_host::broca::subprocess::canonical_provider(harness, alias),
                Ok(canonical),
                "published {harness} alias {alias} must canonicalize identically at runtime"
            );
        }
    }
    // The runtime accepts nothing beyond the published rows: unpublished
    // names fail closed for both harnesses.
    for harness in ["opencode", "pi"] {
        assert!(
            mc_host::broca::subprocess::canonical_provider(harness, "bedrock").is_err(),
            "unpublished provider must stay rejected for {harness}"
        );
    }
    assert!(
        mc_host::broca::subprocess::canonical_provider("opencode", "google-antigravity").is_err(),
        "Pi-only aliases must stay rejected for opencode"
    );
}

#[test]
fn rust_canonical_encoding_reproduces_every_qualified_closure_digest() {
    for (name, digest, bytes) in mc_module::production_inputs::QUALIFIED_HARNESS_CLOSURES {
        let manifest: ClosureManifest =
            serde_json::from_str(bytes).expect("qualified closure manifest parses");
        // `manifest_digest` validates the manifest, re-encodes it through the
        // Rust canonical encoder (sorted keys, two-space pretty form), and
        // hashes those bytes. Equality with the TypeScript-generated digest
        // proves the two hand-written canonical encoders agree byte-for-byte
        // on every shipped manifest; any encoder change that breaks the
        // agreement fails here instead of surfacing at spawn as
        // `closure_incomplete`.
        assert_eq!(
            manifest_digest(&manifest).expect("manifest validates and digests"),
            *digest,
            "Rust-derived canonical digest for {name} must equal the generated digest"
        );
    }
}
