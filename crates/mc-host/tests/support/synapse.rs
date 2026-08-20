//! Shared harness for Synapse protocol tests: a deterministic embedding
//! engine, a fake primary component, and a real-loopback composite host
//! whose secondary is a `SynapseComponent`.

#![allow(dead_code)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::raw_client::{self, Discovered, RawFrame};
use mc_host::synapse::inference::InferenceError;
use mc_host::synapse::{
    EmbeddingEngine, LaneInfo, SynapseComponent, SynapseLimits, SYNAPSE_MODULE_ID,
};
use mc_host::{
    BindOutcome, CancellationToken, CompositeComponent, HealthReport, HostConfig, HostError,
    HostInit, HostLimits, InitError, ManifestSnapshot, PrimaryComponent, RequestCtx,
    RequestOutcome, RouteHandle, RouteIdentity, StaticComposite,
};

pub const ROOT: &str = "/workspace/project";
pub const BUDGET: Duration = Duration::from_secs(5);

pub fn test_lane() -> LaneInfo {
    LaneInfo {
        model: "tiny-test-model".to_owned(),
        fingerprint: "a2b4c6d8e0f01234a2b4c6d8e0f01234a2b4c6d8e0f01234a2b4c6d8e0f01234".to_owned(),
        table_epoch: 1,
        dims: 8,
        max_tokens: 512,
        provenance: serde_json::json!({"source": "deterministic test engine"}),
        recommended_rows: 16,
        recommended_token_budget: 8192,
    }
}

/// Hash-derived unit vectors: deterministic, text-sensitive, and valid
/// under the backend's finiteness and norm invariants.
pub struct DeterministicEngine {
    pub dims: usize,
    pub delay: Mutex<Duration>,
    pub calls: AtomicUsize,
    pub texts_embedded: AtomicUsize,
    pub fail_next: Mutex<Option<InferenceError>>,
}

impl DeterministicEngine {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            dims: 8,
            delay: Mutex::new(Duration::ZERO),
            calls: AtomicUsize::new(0),
            texts_embedded: AtomicUsize::new(0),
            fail_next: Mutex::new(None),
        })
    }

    pub fn set_delay(&self, delay: Duration) {
        *self.delay.lock().expect("delay lock") = delay;
    }

    pub fn fail_next(&self, error: InferenceError) {
        *self.fail_next.lock().expect("fail lock") = Some(error);
    }

    pub fn vector_for(&self, text: &str) -> Vec<f32> {
        use sha2::Digest;
        let digest = sha2::Sha256::digest(text.as_bytes());
        let mut vector: Vec<f32> = digest
            .iter()
            .take(self.dims)
            .map(|b| f32::from(*b) + 1.0)
            .collect();
        let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
        for v in &mut vector {
            *v /= norm;
        }
        vector
    }
}

impl EmbeddingEngine for DeterministicEngine {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, InferenceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let delay = *self.delay.lock().expect("delay lock");
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }
        if let Some(error) = self.fail_next.lock().expect("fail lock").take() {
            return Err(error);
        }
        self.texts_embedded.fetch_add(texts.len(), Ordering::SeqCst);
        Ok(texts.iter().map(|text| self.vector_for(text)).collect())
    }
}

/// Minimal always-accepting primary so the composite can start.
pub struct EchoPrimary;

impl CompositeComponent for EchoPrimary {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: "magic-context".to_owned(),
            module_version: "0.0.1".to_owned(),
            provides: vec![serde_json::json!({"role": "tool_provider"})],
            control_ops: Vec::new(),
        }
    }

    async fn bind(&self, _route: RouteHandle, _identity: RouteIdentity) -> BindOutcome {
        BindOutcome::Accept
    }

    async fn handle(&self, ctx: RequestCtx) -> RequestOutcome {
        let Ok(mut body) = ctx.reserve_output(ctx.body.len()).await else {
            return RequestOutcome::Error {
                code: "internal_error".to_owned(),
                message: "reservation failed".to_owned(),
            };
        };
        body.extend_from_slice(&ctx.body)
            .expect("reservation matches body");
        RequestOutcome::Response {
            body,
            binary: ctx.binary,
        }
    }

    async fn route_gone(&self, _route: RouteHandle) {}

    async fn health(&self) -> HealthReport {
        HealthReport::ok()
    }

    async fn shutdown(&self) {}
}

impl PrimaryComponent for EchoPrimary {
    async fn initialize(&self, _init: HostInit) -> Result<(), InitError> {
        Ok(())
    }
}

pub struct SynapseHost {
    pub info: Discovered,
    shutdown: CancellationToken,
    join: Option<tokio::task::JoinHandle<Result<(), HostError>>>,
    _data_root: tempfile::TempDir,
}

impl SynapseHost {
    pub async fn start(synapse: SynapseComponent) -> Self {
        Self::start_with(synapse, |_| {}).await
    }

    pub async fn start_with(
        synapse: SynapseComponent,
        tweak: impl FnOnce(&mut HostConfig),
    ) -> Self {
        let composite = StaticComposite::new(EchoPrimary, synapse).expect("distinct component ids");
        let data_root = tempfile::tempdir().expect("temp data root");
        let mut config = HostConfig {
            data_dir: Some(data_root.path().to_path_buf()),
            daemon_ver: "mc-host/test".to_owned(),
            limits: HostLimits {
                max_resident_bytes: mc_host::config::MIN_RESIDENT_BYTES * 2,
                ..Default::default()
            },
            ..Default::default()
        };
        config.timing.frame_deadline = Duration::from_secs(5);
        config.timing.shutdown_deadline = Duration::from_secs(5);
        config.timing.route_close_budget = Duration::from_secs(2);
        config.timing.lifecycle_callback_deadline = Duration::from_secs(3);
        tweak(&mut config);

        let publication = super::connection_file(data_root.path());
        let shutdown = CancellationToken::new();
        let run_shutdown = shutdown.clone();
        let join = tokio::spawn(async move { mc_host::run(composite, config, run_shutdown).await });

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if join.is_finished() {
                panic!(
                    "host exited before publishing: {:?}",
                    join.await.expect("run task joins")
                );
            }
            if std::fs::read(&publication).is_ok() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "host did not publish in time"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let info = raw_client::discover(&publication).expect("publication validates");
        Self {
            info,
            shutdown,
            join: Some(join),
            _data_root: data_root,
        }
    }

    pub async fn client(&self) -> raw_client::RawClient {
        raw_client::RawClient::connect(&self.info)
            .await
            .expect("authenticated connection")
    }

    pub async fn shutdown(mut self) -> Result<(), HostError> {
        self.shutdown.cancel();
        let join = self.join.take().expect("host runs once");
        tokio::time::timeout(Duration::from_secs(20), join)
            .await
            .expect("host finishes within its shutdown budget")
            .expect("run task joins")
    }
}

impl Drop for SynapseHost {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

pub async fn open_synapse_route(client: &mut raw_client::RawClient) -> (u16, u32) {
    client
        .route_open_target(
            "management_surface",
            SYNAPSE_MODULE_ID,
            ROOT,
            "opencode",
            "s1",
        )
        .await
        .expect("synapse route binds")
}

/// One `{method, params}` application call over an open synapse route,
/// returning the terminal frame.
pub async fn call(
    client: &mut raw_client::RawClient,
    channel: u16,
    epoch: u32,
    method: &str,
    params: serde_json::Value,
) -> RawFrame {
    let corr = client.next_corr();
    let body = serde_json::to_vec(&serde_json::json!({"method": method, "params": params}))
        .expect("request serializes");
    client
        .send_frame(
            raw_client::TY_REQUEST,
            raw_client::FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &body,
        )
        .await
        .expect("send request");
    // Correlation-filtered so unsolicited frames (e.g. liveness pings) can
    // never be mistaken for the terminal.
    let (_skipped, frame) = client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("terminal");
    frame
}

pub fn sha256_hex(text: &str) -> String {
    mc_host::synapse::protocol::sha256_hex(text.as_bytes())
}

/// Delegates to the production canonical-key algorithm, which is itself
/// anchored by the committed JavaScript golden vectors.
pub fn request_key(lane: &LaneInfo, items: &[(String, String)]) -> String {
    let batch_items: Vec<mc_host::synapse::jobs::BatchItem> = items
        .iter()
        .map(|(id, text)| mc_host::synapse::jobs::BatchItem {
            id: id.clone(),
            content_sha256: sha256_hex(text),
            text: text.clone(),
        })
        .collect();
    mc_host::synapse::protocol::canonical_request_key(lane, &batch_items)
}

pub fn constraints(lane: &LaneInfo) -> serde_json::Value {
    serde_json::json!({
        "model": lane.model,
        "required_fingerprint": lane.fingerprint,
        "required_epoch": lane.table_epoch,
        "allow_equivalent": false,
        "accept_declared": false,
    })
}

pub fn batch_params(lane: &LaneInfo, items: &[(String, String)]) -> serde_json::Value {
    let mut params = constraints(lane);
    params["request_key"] = request_key(lane, items).into();
    params["items"] = items
        .iter()
        .map(|(id, text)| {
            serde_json::json!({
                "id": id,
                "text": text,
                "content_sha256": sha256_hex(text),
            })
        })
        .collect::<Vec<_>>()
        .into();
    params
}

pub fn items(specs: &[(&str, &str)]) -> Vec<(String, String)> {
    specs
        .iter()
        .map(|(id, text)| ((*id).to_owned(), (*text).to_owned()))
        .collect()
}

pub fn ready_component(
    engine: Arc<DeterministicEngine>,
    limits: SynapseLimits,
) -> SynapseComponent {
    SynapseComponent::ready_with_engine(test_lane(), engine, limits)
}
