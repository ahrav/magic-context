//! End-to-end Synapse lane over a real authenticated host route with the
//! committed synapse-tiny bundle and the certified FastEmbed backend.
//!
//! Vector-serving tests need a native ONNX Runtime library via
//! `MC_SYNAPSE_TEST_ORT_LIBRARY`; the degraded-bundle path runs without it.

mod support;

use std::path::{Path, PathBuf};
use std::time::Duration;

use mc_host::synapse::{SynapseComponent, SynapseConfig, SynapseLimits};
use sha2::{Digest, Sha256};
use support::synapse::{call, open_synapse_route, SynapseHost, BUDGET, ROOT};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/synapse-tiny")
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn ort_library() -> Option<(PathBuf, String)> {
    let path = match std::env::var_os("MC_SYNAPSE_TEST_ORT_LIBRARY") {
        Some(path) => PathBuf::from(path),
        None => {
            eprintln!("skipping: MC_SYNAPSE_TEST_ORT_LIBRARY is unset");
            return None;
        }
    };
    let bytes = std::fs::read(&path).expect("ORT library is readable");
    let hash = sha256_hex(&bytes);
    Some((path, hash))
}

fn fixture_manifest() -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(fixture_dir().join("manifest.json")).expect("manifest"))
        .expect("manifest json")
}

fn fixture_lane_constraints() -> serde_json::Value {
    let manifest = fixture_manifest();
    serde_json::json!({
        "model": manifest["model"],
        "required_fingerprint": manifest["fingerprint"],
        "required_epoch": manifest["table_epoch"],
        "allow_equivalent": false,
        "accept_declared": false,
    })
}

#[tokio::test]
async fn corrupt_bundle_degrades_synapse_and_keeps_magic_context_routable() {
    let dir = tempfile::tempdir().expect("temp bundle dir");
    for entry in std::fs::read_dir(fixture_dir()).expect("fixture dir") {
        let entry = entry.expect("entry");
        std::fs::copy(entry.path(), dir.path().join(entry.file_name())).expect("copy");
    }
    // One flipped byte in the model artifact.
    let model_path = dir.path().join("model.onnx");
    let mut bytes = std::fs::read(&model_path).expect("model");
    bytes[0] ^= 0x01;
    std::fs::write(&model_path, bytes).expect("write");

    let component = SynapseComponent::new(Some(SynapseConfig {
        bundle_dir: dir.path().to_path_buf(),
        ort_library: PathBuf::from("/nonexistent/libonnxruntime.so"),
        ort_library_sha256: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
            .to_owned(),
        limits: SynapseLimits::default(),
    }));
    let host = SynapseHost::start(component).await;
    let mut client = host.client().await;

    // The catalog still advertises both static identities.
    let corr = client
        .control(&serde_json::json!({"op": "catalog.list"}))
        .await
        .expect("catalog request");
    let frame = client.frame_within(BUDGET).await.expect("catalog");
    assert_eq!(frame.corr, corr);
    let modules = frame.json()["modules"].as_array().expect("modules").len();
    assert_eq!(modules, 2);

    let err = client
        .route_open_target("management_surface", "synapse", ROOT, "opencode", "s1")
        .await
        .expect_err("corrupt bundles reject the synapse bind");
    assert_eq!(err, "artifact_invalid");

    // Magic Context requests still complete.
    let (channel, epoch) = client
        .route_open("magic-context", ROOT, "opencode", "s1")
        .await
        .expect("magic-context binds");
    let corr = client.next_corr();
    client
        .send_frame(
            support::raw_client::TY_REQUEST,
            support::raw_client::FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            b"{\"ping\":true}",
        )
        .await
        .expect("send echo");
    let frame = client.frame_within(BUDGET).await.expect("echo terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.json()["ping"], true);

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn all_four_operations_serve_certified_vectors_over_the_wire() {
    let Some((ort_library, ort_hash)) = ort_library() else {
        return;
    };
    let component = SynapseComponent::new(Some(SynapseConfig {
        bundle_dir: fixture_dir(),
        ort_library,
        ort_library_sha256: ort_hash,
        limits: SynapseLimits {
            max_page_vectors: 2,
            ..Default::default()
        },
    }));
    let host = SynapseHost::start(component).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let manifest = fixture_manifest();
    let lane = fixture_lane_constraints();

    // models.list pins the certified identity.
    let frame = call(
        &mut client,
        channel,
        epoch,
        "models.list",
        serde_json::json!({}),
    )
    .await;
    let models = frame.json()["result"]["models"].clone();
    assert_eq!(models[0]["model"], manifest["model"]);
    assert_eq!(models[0]["fingerprint"], manifest["fingerprint"]);
    assert_eq!(models[0]["dims"], manifest["dims"]);
    assert_eq!(models[0]["certified"], true);

    // embed.query returns the corpus-certified vector.
    let corpus: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture_dir().join("corpus.json")).expect("corpus"))
            .expect("corpus json");
    let tolerance = corpus["tolerance"].as_f64().expect("tolerance");
    let probe = &corpus["items"][0];
    let mut params = lane.clone();
    params["text"] = probe["text"].clone();
    let frame = call(&mut client, channel, epoch, "embed.query", params).await;
    let result = frame.json()["result"].clone();
    assert_eq!(result["fingerprint"], manifest["fingerprint"]);
    let got = result["vectors"][0]["vector"].as_array().expect("vector");
    let expected = probe["expected"].as_array().expect("expected");
    assert_eq!(got.len(), expected.len());
    for (g, e) in got.iter().zip(expected) {
        let g = g.as_f64().expect("component");
        let e = e.as_f64().expect("component");
        assert!((g - e).abs() <= tolerance, "query drift beyond tolerance");
    }

    // embed.batch + paged embed.result over three corpus texts.
    let texts: Vec<&str> = corpus["items"]
        .as_array()
        .expect("items")
        .iter()
        .take(3)
        .map(|item| item["text"].as_str().expect("text"))
        .collect();
    let items: Vec<(String, String)> = texts
        .iter()
        .enumerate()
        .map(|(index, text)| (format!("item:{index}"), (*text).to_owned()))
        .collect();
    let lane_info = mc_host::synapse::LaneInfo {
        model: manifest["model"].as_str().expect("model").to_owned(),
        fingerprint: manifest["fingerprint"].as_str().expect("fp").to_owned(),
        table_epoch: manifest["table_epoch"].as_u64().expect("epoch"),
        dims: manifest["dims"].as_u64().expect("dims") as usize,
        max_tokens: manifest["max_tokens"].as_u64().expect("max"),
        provenance: serde_json::Value::Null,
        recommended_rows: 16,
        recommended_token_budget: 8192,
    };
    let params = support::synapse::batch_params(&lane_info, &items);
    let frame = call(&mut client, channel, epoch, "embed.batch", params).await;
    let descriptor = frame.json()["result"].clone();
    let job_id = descriptor["job_id"].as_str().expect("job").to_owned();
    assert_eq!(descriptor["done"], false);

    let key = support::synapse::request_key(&lane_info, &items);
    let mut collected: Vec<(String, Vec<f64>)> = Vec::new();
    let mut cursor = serde_json::Value::Null;
    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let mut params = lane.clone();
        params["job_id"] = job_id.clone().into();
        params["request_key"] = key.clone().into();
        params["cursor"] = cursor.clone();
        let frame = call(&mut client, channel, epoch, "embed.result", params).await;
        let result = frame.json()["result"].clone();
        if !result["vectors"].is_array() {
            assert_eq!(result["done"], false, "pending is explicit");
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
            continue;
        }
        for vector in result["vectors"].as_array().expect("vectors") {
            collected.push((
                vector["id"].as_str().expect("id").to_owned(),
                vector["vector"]
                    .as_array()
                    .expect("vector")
                    .iter()
                    .map(|v| v.as_f64().expect("component"))
                    .collect(),
            ));
        }
        if result["done"] == true {
            break;
        }
        cursor = result["next_cursor"].clone();
    }
    assert_eq!(collected.len(), 3);
    for (index, (id, vector)) in collected.iter().enumerate() {
        assert_eq!(id, &format!("item:{index}"));
        let expected = corpus["items"][index]["expected"]
            .as_array()
            .expect("expected");
        for (g, e) in vector.iter().zip(expected) {
            assert!((g - e.as_f64().expect("component")).abs() <= tolerance);
        }
    }

    host.shutdown().await.expect("graceful shutdown");
}
