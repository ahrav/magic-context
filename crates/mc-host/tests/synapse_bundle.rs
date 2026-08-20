//! Bundle validation and certified-inference conformance for the committed
//! synapse-tiny fixture.
//!
//! Tests that touch native inference need a real ONNX Runtime shared
//! library. Set `MC_SYNAPSE_TEST_ORT_LIBRARY` to its path; without it those
//! tests skip (loudly) while every pre-ORT rejection path still runs.

use std::path::{Path, PathBuf};

use mc_host::synapse::inference::InferenceError;
use mc_host::synapse::{SynapseComponent, SynapseConfig, SynapseLimits, SynapseStatus};
use mc_host::{CompositeComponent, SecondaryComponent};
use sha2::{Digest, Sha256};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/synapse-tiny")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn ort_library() -> Option<(PathBuf, String)> {
    let path = match std::env::var_os("MC_SYNAPSE_TEST_ORT_LIBRARY") {
        Some(path) => PathBuf::from(path),
        None => {
            eprintln!(
                "skipping: MC_SYNAPSE_TEST_ORT_LIBRARY is unset, no native ONNX Runtime available"
            );
            return None;
        }
    };
    let bytes = std::fs::read(&path).expect("ORT library is readable");
    let hash = sha256_hex(&bytes);
    Some((path, hash))
}

fn copy_fixture_to(dir: &Path) {
    for entry in std::fs::read_dir(fixture_dir()).expect("fixture dir") {
        let entry = entry.expect("fixture entry");
        std::fs::copy(entry.path(), dir.join(entry.file_name())).expect("copy fixture file");
    }
}

fn config_for(dir: &Path, ort: &(PathBuf, String)) -> SynapseConfig {
    SynapseConfig {
        bundle_dir: dir.to_path_buf(),
        ort_library: ort.0.clone(),
        ort_library_sha256: ort.1.clone(),
        limits: SynapseLimits::default(),
    }
}

/// A syntactically valid ORT identity for rejection paths that fail before
/// any native loading; the file never has to exist.
fn pre_ort_identity() -> (PathBuf, String) {
    (
        PathBuf::from("/nonexistent/libonnxruntime.so"),
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef".to_owned(),
    )
}

async fn initialize(config: SynapseConfig) -> SynapseComponent {
    let component = SynapseComponent::new(Some(config));
    component
        .initialize()
        .await
        .expect("expected artifact faults never fail initialization");
    component
}

fn disabled_reason(component: &SynapseComponent) -> String {
    match component.status() {
        SynapseStatus::Disabled { reason } => reason,
        other => panic!("expected a disabled lane, got {other:?}"),
    }
}

async fn expect_disabled_with(mutate: impl FnOnce(&Path), expected_fragment: &str) {
    let dir = tempfile::tempdir().expect("temp bundle dir");
    copy_fixture_to(dir.path());
    mutate(dir.path());
    let component = initialize(config_for(dir.path(), &pre_ort_identity())).await;
    let reason = disabled_reason(&component);
    assert!(
        reason.contains(expected_fragment),
        "reason {reason:?} does not mention {expected_fragment:?}"
    );
}

fn edit_manifest(dir: &Path, edit: impl FnOnce(&mut serde_json::Value)) {
    let path = dir.join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).expect("manifest")).expect("manifest json");
    edit(&mut manifest);
    std::fs::write(&path, serde_json::to_vec(&manifest).expect("serialize")).expect("write");
}

fn corpus() -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(fixture_dir().join("corpus.json")).expect("corpus"))
        .expect("corpus json")
}

// ---------------------------------------------------------------------------
// Pre-ORT rejection paths: these must all disable Synapse before any native
// model construction, so they run without an ONNX Runtime library.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unconfigured_component_is_disabled_not_fatal() {
    let component = SynapseComponent::new(None);
    component.initialize().await.expect("initialize");
    assert!(disabled_reason(&component).contains("no bundle configured"));

    let outcome = component
        .bind(
            mc_host::RouteHandle {
                channel: 1,
                epoch: 1,
            },
            identity(),
        )
        .await;
    match outcome {
        mc_host::BindOutcome::Reject { code, .. } => assert_eq!(code, "artifact_invalid"),
        mc_host::BindOutcome::Accept => panic!("a disabled lane must not accept binds"),
    }
    assert_eq!(
        component.health().await.status,
        mc_host::HealthStatus::Degraded
    );
}

fn identity() -> mc_host::RouteIdentity {
    mc_host::RouteIdentity {
        project_root: PathBuf::from("/workspace/project"),
        harness: "opencode".to_owned(),
        session: "s1".to_owned(),
        consumer_module_id: None,
        consumer_launch_nonce: None,
        consumer_capabilities: Vec::new(),
        admission_facts: None,
    }
}

#[tokio::test]
async fn one_bit_changes_to_each_artifact_disable_the_lane() {
    for name in [
        "model.onnx",
        "embedding.bin",
        "tokenizer.json",
        "config.json",
        "special_tokens_map.json",
        "tokenizer_config.json",
        "corpus.json",
    ] {
        expect_disabled_with(
            move |dir| {
                let path = dir.join(name);
                let mut bytes = std::fs::read(&path).expect("artifact");
                let last = bytes.len() - 1;
                bytes[last] ^= 0x01;
                std::fs::write(&path, bytes).expect("write");
            },
            "hash mismatch",
        )
        .await;
    }
}

#[tokio::test]
async fn missing_artifact_disables_the_lane() {
    expect_disabled_with(
        |dir| std::fs::remove_file(dir.join("embedding.bin")).expect("remove"),
        "missing",
    )
    .await;
}

#[tokio::test]
async fn unlisted_extra_file_disables_the_lane() {
    expect_disabled_with(
        |dir| std::fs::write(dir.join("extra-initializer.bin"), b"x").expect("write"),
        "unlisted",
    )
    .await;
}

#[tokio::test]
async fn symlinked_artifact_disables_the_lane() {
    expect_disabled_with(
        |dir| {
            let real = dir.join("model.onnx");
            let moved = dir.join("model.onnx.real");
            std::fs::rename(&real, &moved).expect("rename");
            std::os::unix::fs::symlink(&moved, &real).expect("symlink");
        },
        "unlisted",
    )
    .await;
}

#[tokio::test]
async fn duplicate_manifest_key_disables_the_lane() {
    expect_disabled_with(
        |dir| {
            let path = dir.join("manifest.json");
            let text = std::fs::read_to_string(&path).expect("manifest");
            let duplicated = text.replacen(
                "\"schema_version\":",
                "\"table_epoch\": 9, \"schema_version\":",
                1,
            );
            std::fs::write(&path, duplicated).expect("write");
        },
        "strict JSON",
    )
    .await;
}

#[tokio::test]
async fn manifest_field_bounds_disable_the_lane() {
    expect_disabled_with(
        |dir| edit_manifest(dir, |m| m["schema_version"] = 2.into()),
        "schema version",
    )
    .await;
    expect_disabled_with(
        |dir| edit_manifest(dir, |m| m["model_file"]["name"] = "/etc/passwd".into()),
        "path separator",
    )
    .await;
    expect_disabled_with(
        |dir| edit_manifest(dir, |m| m["model_file"]["name"] = "..".into()),
        "reserved",
    )
    .await;
    expect_disabled_with(
        |dir| edit_manifest(dir, |m| m["model_file"]["sha256"] = "0".repeat(64).into()),
        "placeholder",
    )
    .await;
    expect_disabled_with(
        |dir| edit_manifest(dir, |m| m["model_file"]["sha256"] = "abc123".into()),
        "64 lowercase hex",
    )
    .await;
    expect_disabled_with(
        |dir| edit_manifest(dir, |m| m["pooling"] = "max".into()),
        "pooling",
    )
    .await;
    expect_disabled_with(
        |dir| edit_manifest(dir, |m| m["quantization"] = "int4".into()),
        "quantization",
    )
    .await;
    expect_disabled_with(
        |dir| edit_manifest(dir, |m| m["output"] = serde_json::json!({"name": "logits"})),
        "allowlisted",
    )
    .await;
    expect_disabled_with(
        |dir| edit_manifest(dir, |m| m["output"] = serde_json::json!({"index": 8})),
        "bound",
    )
    .await;
    expect_disabled_with(
        |dir| {
            edit_manifest(dir, |m| {
                m["output"] = serde_json::json!({"name": "last_hidden_state", "index": 0})
            })
        },
        "exactly one",
    )
    .await;
    expect_disabled_with(|dir| edit_manifest(dir, |m| m["dims"] = 0.into()), "dims").await;
    expect_disabled_with(
        |dir| edit_manifest(dir, |m| m["max_tokens"] = 16.into()),
        "model_max_length",
    )
    .await;
    expect_disabled_with(
        |dir| edit_manifest(dir, |m| m["unexpected_field"] = 1.into()),
        "schema invalid",
    )
    .await;
}

#[tokio::test]
async fn missing_pad_token_disables_the_lane() {
    expect_disabled_with(
        |dir| {
            let path = dir.join("tokenizer_config.json");
            let contents = br#"{"model_max_length": 8}"#;
            std::fs::write(&path, contents).expect("write");
            edit_manifest(dir, |m| {
                m["tokenizer"]["tokenizer_config"]["sha256"] = sha256_hex(contents).into();
            });
        },
        "pad_token",
    )
    .await;
}

#[tokio::test]
async fn missing_bundle_directory_disables_the_lane() {
    let dir = tempfile::tempdir().expect("temp dir");
    let gone = dir.path().join("never-created");
    let component = initialize(config_for(&gone, &pre_ort_identity())).await;
    assert!(disabled_reason(&component).contains("missing"));
}

// ---------------------------------------------------------------------------
// Native paths: exercised only when a certified ONNX Runtime library is
// available to this process.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn certified_bundle_loads_and_serves_expected_vectors() {
    let Some(ort) = ort_library() else { return };
    let dir = tempfile::tempdir().expect("temp bundle dir");
    copy_fixture_to(dir.path());
    let component = initialize(config_for(dir.path(), &ort)).await;
    let lane = match component.status() {
        SynapseStatus::Ready(lane) => lane,
        other => panic!("expected a ready lane, got {other:?}"),
    };
    assert_eq!(lane.model, "tiny-test-model");
    assert_eq!(lane.dims, 8);
    assert_eq!(lane.table_epoch, 1);
    assert_eq!(lane.recommended_rows, 16);

    let corpus = corpus();
    let tolerance = corpus["tolerance"].as_f64().expect("tolerance") as f32;
    for item in corpus["items"].as_array().expect("items") {
        let text = item["text"].as_str().expect("text");
        let expected: Vec<f32> = item["expected"]
            .as_array()
            .expect("expected")
            .iter()
            .map(|v| v.as_f64().expect("component") as f32)
            .collect();
        let got = component.embed_blocking(&[text]).expect("embed");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].len(), expected.len(), "dims for {text}");
        for (g, e) in got[0].iter().zip(&expected) {
            assert!(
                (g - e).abs() <= tolerance,
                "component drift beyond tolerance for {text}"
            );
        }
    }

    // Repeatability within tolerance, not bit-exactness.
    let first = component
        .embed_blocking(&["alpha beta gamma"])
        .expect("embed");
    let second = component
        .embed_blocking(&["alpha beta gamma"])
        .expect("embed");
    for (a, b) in first[0].iter().zip(&second[0]) {
        assert!((a - b).abs() <= tolerance);
    }

    // The tokenizer truncates at max_tokens, so tokens past the boundary
    // cannot change the vector.
    let truncated = component
        .embed_blocking(&["alpha beta gamma delta epsilon zeta eta theta"])
        .expect("embed");
    let overflowing = component
        .embed_blocking(&["alpha beta gamma delta epsilon zeta eta theta iota kappa"])
        .expect("embed");
    for (a, b) in truncated[0].iter().zip(&overflowing[0]) {
        assert!((a - b).abs() <= tolerance);
    }

    // Zero-token inputs are refused before native inference.
    for text in ["", "   "] {
        match component.embed_blocking(&[text]) {
            Err(InferenceError::Input(_)) => {}
            other => panic!("expected an input rejection for {text:?}, got {other:?}"),
        }
    }
    assert!(matches!(component.status(), SynapseStatus::Ready(_)));
}

#[tokio::test]
async fn wrong_but_dimension_compatible_output_fails_certification() {
    let Some(ort) = ort_library() else { return };
    let dir = tempfile::tempdir().expect("temp bundle dir");
    copy_fixture_to(dir.path());
    edit_manifest(dir.path(), |m| {
        m["output"] = serde_json::json!({"name": "token_embeddings"});
    });
    let component = initialize(config_for(dir.path(), &ort)).await;
    assert!(disabled_reason(&component).contains("semantic certification"));
}

#[tokio::test]
async fn wrong_pooling_fails_certification() {
    let Some(ort) = ort_library() else { return };
    let dir = tempfile::tempdir().expect("temp bundle dir");
    copy_fixture_to(dir.path());
    edit_manifest(dir.path(), |m| m["pooling"] = "cls".into());
    let component = initialize(config_for(dir.path(), &ort)).await;
    assert!(disabled_reason(&component).contains("semantic certification"));
}

#[tokio::test]
async fn wrong_ort_identity_disables_the_lane() {
    let Some(ort) = ort_library() else { return };
    let dir = tempfile::tempdir().expect("temp bundle dir");
    copy_fixture_to(dir.path());

    let mut wrong_hash = config_for(dir.path(), &ort);
    wrong_hash.ort_library_sha256 =
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef".to_owned();
    let component = initialize(wrong_hash).await;
    assert!(disabled_reason(&component).contains("hash mismatch"));

    let mut missing = config_for(dir.path(), &ort);
    missing.ort_library = dir.path().join("libnothere.so");
    let component = initialize(missing).await;
    assert!(disabled_reason(&component).contains("missing"));

    let mut placeholder = config_for(dir.path(), &ort);
    placeholder.ort_library_sha256 = "0".repeat(64);
    let component = initialize(placeholder).await;
    assert!(disabled_reason(&component).contains("not a real digest"));
}
