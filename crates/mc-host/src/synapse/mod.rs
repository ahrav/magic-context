//! The Synapse embedding component: an optional, certified, CPU-only local
//! model behind the `synapse/management_surface` target.
//!
//! Expected artifact faults (missing configuration, invalid bundle,
//! incompatible ONNX Runtime, failed certification) disable only this
//! component: its catalog identity stays published, its bind rejects with
//! `artifact_invalid`, and internal health reports degraded. Lifecycle
//! panics and invariant violations remain host-fatal through the composite.
//!
//! Jobs are process-local and ephemeral. Route loss cancels only response
//! waiters; every started native inference call is owned by the component's
//! incarnation tracker until it stops, and shutdown drains that tracker
//! before releasing anything.

pub mod bundle;
pub mod inference;
pub mod jobs;
pub mod protocol;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::composite::{CompositeComponent, SecondaryComponent};
use crate::handler::{
    BindOutcome, HealthReport, HealthStatus, InitError, ManifestSnapshot, RequestCtx,
    RequestOutcome, RouteHandle, RouteIdentity,
};
use bundle::BundleManifest;
use inference::{Backend, InferenceError, OrtIdentity};
use jobs::{AdmitOutcome, JobTable, PollOutcome};
use protocol::{Request, RequestError};

pub const SYNAPSE_MODULE_ID: &str = "synapse";

/// Finite host-owned capacities for the Synapse lane. Requests can never
/// select these; they live in trusted startup configuration only.
#[derive(Debug, Clone)]
pub struct SynapseLimits {
    pub max_queued_jobs: usize,
    pub max_queued_request_bytes: u64,
    pub max_retained_jobs: usize,
    pub max_retained_result_bytes: u64,
    pub max_batch_items: usize,
    pub max_batch_text_bytes: usize,
    pub max_text_bytes: usize,
    pub max_page_vectors: usize,
    pub max_page_encoded_bytes: usize,
    pub retention: std::time::Duration,
    pub retry_after_ms: u64,
}

impl Default for SynapseLimits {
    fn default() -> Self {
        Self {
            max_queued_jobs: 64,
            max_queued_request_bytes: 64 * 1024 * 1024,
            max_retained_jobs: 64,
            max_retained_result_bytes: 64 * 1024 * 1024,
            max_batch_items: 64,
            max_batch_text_bytes: 8 * 1024 * 1024,
            max_text_bytes: 1024 * 1024,
            max_page_vectors: 16,
            max_page_encoded_bytes: 2 * 1024 * 1024,
            retention: std::time::Duration::from_secs(15 * 60),
            retry_after_ms: 50,
        }
    }
}

/// Trusted startup configuration for the optional bundle. `None` at the
/// component level means the deployment ships without Synapse.
#[derive(Debug, Clone)]
pub struct SynapseConfig {
    pub bundle_dir: PathBuf,
    pub ort_library: PathBuf,
    pub ort_library_sha256: String,
    pub limits: SynapseLimits,
}

/// Catalog-facing lane identity, pinned from the verified manifest.
#[derive(Debug, Clone)]
pub struct LaneInfo {
    pub model: String,
    pub fingerprint: String,
    pub table_epoch: u64,
    pub dims: usize,
    pub provenance: serde_json::Value,
    pub recommended_rows: u32,
    pub recommended_token_budget: u32,
}

impl LaneInfo {
    fn from_manifest(manifest: &BundleManifest) -> Self {
        Self {
            model: manifest.model.clone(),
            fingerprint: manifest.fingerprint.clone(),
            table_epoch: manifest.table_epoch,
            dims: manifest.dims as usize,
            provenance: manifest.provenance.clone(),
            recommended_rows: manifest.recommended_batch.rows,
            recommended_token_budget: manifest.recommended_batch.token_budget,
        }
    }
}

/// Blocking embedding seam. The certified FastEmbed [`Backend`] is the
/// production implementation; tests substitute a deterministic engine so
/// protocol and job behavior stay hermetic without a native runtime.
pub trait EmbeddingEngine: Send + Sync + 'static {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, InferenceError>;
}

impl EmbeddingEngine for Backend {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, InferenceError> {
        Backend::embed(self, texts)
    }
}

struct ReadyLane {
    backend: Arc<dyn EmbeddingEngine>,
    lane: LaneInfo,
}

#[derive(Debug, Clone)]
pub enum SynapseStatus {
    Ready(LaneInfo),
    Disabled { reason: String },
    Failing { reason: String },
}

enum LaneState {
    Disabled { reason: String },
    Ready(Arc<ReadyLane>),
    Failing { reason: String },
}

struct SynapseInner {
    config: Option<SynapseConfig>,
    limits: SynapseLimits,
    state: Mutex<LaneState>,
    jobs: JobTable,
    /// One permit: at most one native inference call runs at a time, and
    /// waiters are served FIFO.
    cpu: Arc<tokio::sync::Semaphore>,
    /// Owns every started native call through shutdown.
    tracker: TaskTracker,
    /// Cancels queued (not yet started) work and closes admission.
    closing: CancellationToken,
}

pub struct SynapseComponent {
    inner: Arc<SynapseInner>,
}

impl SynapseComponent {
    pub fn new(config: Option<SynapseConfig>) -> Self {
        let limits = config
            .as_ref()
            .map(|config| config.limits.clone())
            .unwrap_or_default();
        Self {
            inner: Arc::new(SynapseInner {
                config,
                jobs: JobTable::new(limits.clone()),
                limits,
                state: Mutex::new(LaneState::Disabled {
                    reason: "not initialized".to_owned(),
                }),
                cpu: Arc::new(tokio::sync::Semaphore::new(1)),
                tracker: TaskTracker::new(),
                closing: CancellationToken::new(),
            }),
        }
    }

    /// Test seam: a component whose lane is immediately ready over the
    /// supplied engine, bypassing bundle loading and ORT.
    pub fn ready_with_engine(
        lane: LaneInfo,
        engine: Arc<dyn EmbeddingEngine>,
        limits: SynapseLimits,
    ) -> Self {
        Self {
            inner: Arc::new(SynapseInner {
                config: None,
                jobs: JobTable::new(limits.clone()),
                limits,
                state: Mutex::new(LaneState::Ready(Arc::new(ReadyLane {
                    backend: engine,
                    lane,
                }))),
                cpu: Arc::new(tokio::sync::Semaphore::new(1)),
                tracker: TaskTracker::new(),
                closing: CancellationToken::new(),
            }),
        }
    }

    pub fn status(&self) -> SynapseStatus {
        match &*self.inner.state.lock().expect("synapse state lock") {
            LaneState::Ready(lane) => SynapseStatus::Ready(lane.lane.clone()),
            LaneState::Disabled { reason } => SynapseStatus::Disabled {
                reason: reason.clone(),
            },
            LaneState::Failing { reason } => SynapseStatus::Failing {
                reason: reason.clone(),
            },
        }
    }

    fn ready_lane(&self) -> Option<Arc<ReadyLane>> {
        match &*self.inner.state.lock().expect("synapse state lock") {
            LaneState::Ready(lane) => Some(Arc::clone(lane)),
            _ => None,
        }
    }

    /// `Invariant` errors mark the lane failing before the error is
    /// returned, so no later caller can obtain a vector from a suspect
    /// backend.
    pub fn embed_blocking(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, InferenceError> {
        let Some(lane) = self.ready_lane() else {
            let reason = match self.status() {
                SynapseStatus::Disabled { reason } | SynapseStatus::Failing { reason } => reason,
                SynapseStatus::Ready(_) => unreachable!("ready lanes embed"),
            };
            return Err(InferenceError::Artifact(reason));
        };
        embed_via(&self.inner, &lane, texts)
    }
}

fn mark_failing(inner: &SynapseInner, reason: String) {
    let mut state = inner.state.lock().expect("synapse state lock");
    if matches!(&*state, LaneState::Ready(_)) {
        *state = LaneState::Failing { reason };
    }
}

fn embed_via(
    inner: &SynapseInner,
    lane: &ReadyLane,
    texts: &[&str],
) -> Result<Vec<Vec<f32>>, InferenceError> {
    settle_inference(inner, Ok(lane.backend.embed(texts)))
}

/// One owner for the inference-disposition policy: an `Invariant` failure or
/// a panicked blocking task marks the lane failing BEFORE the error reaches
/// any sink, so no suspect vector can be served by a later caller.
fn settle_inference(
    inner: &SynapseInner,
    joined: Result<Result<Vec<Vec<f32>>, InferenceError>, tokio::task::JoinError>,
) -> Result<Vec<Vec<f32>>, InferenceError> {
    match joined {
        Ok(Ok(vectors)) => Ok(vectors),
        Ok(Err(InferenceError::Invariant(reason))) => {
            mark_failing(inner, reason.clone());
            Err(InferenceError::Invariant(reason))
        }
        Ok(Err(other)) => Err(other),
        Err(_join) => {
            let reason = "inference task panicked".to_owned();
            mark_failing(inner, reason.clone());
            Err(InferenceError::Invariant(reason))
        }
    }
}

/// Why a query produced no vectors: host shutdown is distinct from every
/// engine-reported error so an engine can never spoof a cancellation.
enum QueryFault {
    Cancelled,
    Engine(InferenceError),
}

fn request_error(error: RequestError) -> RequestOutcome {
    RequestOutcome::Error {
        code: error.code.to_owned(),
        message: error.message,
    }
}

fn app_error(code: &str, message: &str) -> RequestOutcome {
    RequestOutcome::Error {
        code: code.to_owned(),
        message: message.to_owned(),
    }
}

async fn respond(ctx: &RequestCtx, body: Vec<u8>) -> RequestOutcome {
    let Ok(mut output) = ctx.reserve_output(body.len()).await else {
        return app_error("internal_error", "output reservation failed");
    };
    if output.extend_from_slice(&body).is_err() {
        return app_error("internal_error", "output reservation too small");
    }
    RequestOutcome::Response {
        body: output,
        binary: false,
    }
}

impl SynapseComponent {
    async fn handle_query(
        &self,
        ctx: &RequestCtx,
        lane: Arc<ReadyLane>,
        text: String,
        deadline_ms: Option<u64>,
    ) -> RequestOutcome {
        if self.inner.closing.is_cancelled() {
            return app_error("cancelled", "the host is shutting down");
        }
        let content_sha256 = protocol::sha256_hex(text.as_bytes());
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<Vec<f32>>, QueryFault>>();
        let inner = Arc::clone(&self.inner);
        let lane_task = Arc::clone(&lane);
        // The tracked task owns the native call; this handler future is only
        // the response waiter, so route loss or a deadline cancels waiting
        // without orphaning inference.
        self.inner.tracker.spawn(async move {
            let mut tx = tx;
            let permit = tokio::select! {
                biased;
                () = inner.closing.cancelled() => {
                    let _ = tx.send(Err(QueryFault::Cancelled));
                    return;
                }
                // A waiter that is already gone (route loss, deadline) can
                // still be honored with zero native work while the call is
                // only queued; once the permit is held the call runs to
                // completion regardless.
                () = tx.closed() => return,
                permit = Arc::clone(&inner.cpu).acquire_owned() => permit,
            };
            let Ok(_permit) = permit else {
                let _ = tx.send(Err(QueryFault::Engine(InferenceError::Invariant(
                    "cpu semaphore closed".to_owned(),
                ))));
                return;
            };
            let lane_blocking = Arc::clone(&lane_task);
            let joined =
                tokio::task::spawn_blocking(move || lane_blocking.backend.embed(&[text.as_str()]))
                    .await;
            let result = settle_inference(&inner, joined).map_err(QueryFault::Engine);
            let _ = tx.send(result);
        });

        let deadline =
            std::time::Duration::from_millis(deadline_ms.unwrap_or(protocol::MAX_DEADLINE_MS));
        let result = match tokio::time::timeout(deadline, rx).await {
            Err(_) => return app_error("timeout", "the query deadline expired host-side"),
            Ok(Err(_)) => return app_error("internal_error", "the inference task was lost"),
            Ok(Ok(result)) => result,
        };
        match result {
            Ok(vectors) => match vectors.first() {
                Some(vector) => {
                    respond(
                        ctx,
                        protocol::query_body(&lane.lane, &content_sha256, vector),
                    )
                    .await
                }
                None => {
                    mark_failing(
                        &self.inner,
                        "inference returned no vector for one query".to_owned(),
                    );
                    app_error("artifact_invalid", "inference returned no vector")
                }
            },
            Err(QueryFault::Cancelled) => app_error("cancelled", "the host is shutting down"),
            Err(QueryFault::Engine(InferenceError::Input(reason))) => {
                app_error("schema_violation", &reason)
            }
            Err(QueryFault::Engine(InferenceError::Artifact(reason)))
            | Err(QueryFault::Engine(InferenceError::Invariant(reason))) => {
                app_error("artifact_invalid", &reason)
            }
        }
    }

    async fn handle_batch(
        &self,
        ctx: &RequestCtx,
        lane: Arc<ReadyLane>,
        request_key: String,
        canonical_key: String,
        items: Vec<jobs::BatchItem>,
    ) -> RequestOutcome {
        if request_key != canonical_key {
            // A retained key resent with a different payload is the
            // permanent idempotency conflict; a key that matches nothing is
            // an ordinary schema fault.
            if self.inner.jobs.key_is_retained(&request_key) {
                return app_error(
                    "idempotency_conflict",
                    "the request_key is retained with a different payload",
                );
            }
            return app_error(
                "schema_violation",
                "request_key does not match the canonical payload",
            );
        }
        let retry_after_ms = self.inner.limits.retry_after_ms;
        match self.inner.jobs.admit(request_key.clone(), items) {
            AdmitOutcome::Existing(descriptor) => {
                respond(
                    ctx,
                    protocol::job_descriptor_body(
                        &descriptor.job_id,
                        &request_key,
                        descriptor.status,
                        retry_after_ms,
                    ),
                )
                .await
            }
            AdmitOutcome::Conflict => app_error(
                "idempotency_conflict",
                "the request_key is retained with a different payload",
            ),
            AdmitOutcome::Full => app_error("queue_full", "job admission capacity is exhausted"),
            AdmitOutcome::Closed => app_error("cancelled", "the host is shutting down"),
            AdmitOutcome::Admitted { job_id, seq } => {
                self.spawn_batch_worker(Arc::clone(&lane), seq);
                respond(
                    ctx,
                    protocol::job_descriptor_body(&job_id, &request_key, "queued", retry_after_ms),
                )
                .await
            }
        }
    }

    fn spawn_batch_worker(&self, lane: Arc<ReadyLane>, seq: u64) {
        let inner = Arc::clone(&self.inner);
        self.inner.tracker.spawn(async move {
            let permit = tokio::select! {
                biased;
                // A queued wrapper is cancellable; a started native call is
                // not. close_admission already dropped the queued job.
                () = inner.closing.cancelled() => return,
                permit = Arc::clone(&inner.cpu).acquire_owned() => permit,
            };
            let Ok(_permit) = permit else { return };
            let Some(items) = inner.jobs.start(seq) else {
                return;
            };
            let lane_blocking = Arc::clone(&lane);
            let joined = tokio::task::spawn_blocking(move || {
                let texts: Vec<&str> = items.iter().map(|item| item.text.as_str()).collect();
                lane_blocking.backend.embed(&texts)
            })
            .await;
            match settle_inference(&inner, joined) {
                Ok(vectors) => inner.jobs.publish_ready(seq, vectors),
                Err(InferenceError::Input(reason)) => {
                    inner
                        .jobs
                        .publish_failed(seq, "schema_violation".to_owned(), reason);
                }
                Err(InferenceError::Artifact(reason)) | Err(InferenceError::Invariant(reason)) => {
                    inner
                        .jobs
                        .publish_failed(seq, "artifact_invalid".to_owned(), reason);
                }
            }
        });
    }

    async fn handle_result(
        &self,
        ctx: &RequestCtx,
        lane: Arc<ReadyLane>,
        job_id: String,
        request_key: String,
        cursor: Option<String>,
    ) -> RequestOutcome {
        match self
            .inner
            .jobs
            .poll(&job_id, &request_key, cursor.as_deref())
        {
            PollOutcome::Restarted => app_error(
                "module_restarted",
                "the job is unknown to this host incarnation",
            ),
            PollOutcome::KeyMismatch => {
                app_error("schema_violation", "request_key does not match the job")
            }
            PollOutcome::BadCursor => {
                app_error("schema_violation", "cursor is not valid for this job")
            }
            PollOutcome::Failed { code, message } => RequestOutcome::Error { code, message },
            PollOutcome::Pending { status } => {
                respond(
                    ctx,
                    protocol::pending_body(&job_id, status, self.inner.limits.retry_after_ms),
                )
                .await
            }
            PollOutcome::Page(page) => {
                respond(ctx, protocol::result_page_body(&lane.lane, &page)).await
            }
        }
    }
}

impl CompositeComponent for SynapseComponent {
    fn manifest(&self) -> ManifestSnapshot {
        ManifestSnapshot {
            module_id: SYNAPSE_MODULE_ID.to_owned(),
            module_version: env!("CARGO_PKG_VERSION").to_owned(),
            provides: vec![serde_json::json!({"role": "management_surface"})],
            control_ops: Vec::new(),
        }
    }

    async fn bind(&self, _route: RouteHandle, _identity: RouteIdentity) -> BindOutcome {
        match self.status() {
            SynapseStatus::Ready(_) => BindOutcome::Accept,
            SynapseStatus::Disabled { .. } | SynapseStatus::Failing { .. } => BindOutcome::Reject {
                code: "artifact_invalid".to_owned(),
                message: "the synapse model bundle is unavailable".to_owned(),
            },
        }
    }

    async fn handle(&self, ctx: RequestCtx) -> RequestOutcome {
        let Some(lane) = self.ready_lane() else {
            return app_error("artifact_invalid", "the synapse lane is unavailable");
        };
        let request =
            match protocol::parse_request(&ctx.body, ctx.binary, &lane.lane, &self.inner.limits) {
                Ok(request) => request,
                Err(error) => return request_error(error),
            };
        match request {
            Request::ModelsList => respond(&ctx, protocol::models_list_body(&lane.lane)).await,
            Request::EmbedQuery { text, deadline_ms } => {
                self.handle_query(&ctx, lane, text, deadline_ms).await
            }
            Request::EmbedBatch {
                request_key,
                canonical_key,
                items,
            } => {
                self.handle_batch(&ctx, lane, request_key, canonical_key, items)
                    .await
            }
            Request::EmbedResult {
                job_id,
                request_key,
                cursor,
            } => {
                self.handle_result(&ctx, lane, job_id, request_key, cursor)
                    .await
            }
        }
    }

    async fn route_gone(&self, _route: RouteHandle) {}

    async fn health(&self) -> HealthReport {
        match self.status() {
            SynapseStatus::Ready(_) => HealthReport::ok(),
            SynapseStatus::Disabled { reason } => HealthReport {
                status: HealthStatus::Degraded,
                detail: Some(reason),
                metrics: None,
            },
            SynapseStatus::Failing { reason } => HealthReport {
                status: HealthStatus::Failing,
                detail: Some(reason),
                metrics: None,
            },
        }
    }

    /// Ordered drain: admission closes and queued wrappers cancel first,
    /// then every started native call is joined through the incarnation
    /// tracker, and only then is retained state released. Never aborts a
    /// native call.
    async fn shutdown(&self) {
        self.inner.closing.cancel();
        self.inner.jobs.close_admission();
        self.inner.tracker.close();
        self.inner.tracker.wait().await;
        self.inner.jobs.clear();
    }
}

impl SecondaryComponent for SynapseComponent {
    async fn initialize(&self) -> Result<(), InitError> {
        let Some(config) = self.inner.config.clone() else {
            let mut state = self.inner.state.lock().expect("synapse state lock");
            // A pre-readied lane (the test seam) has no configuration to
            // load and stays ready.
            if !matches!(&*state, LaneState::Ready(_)) {
                *state = LaneState::Disabled {
                    reason: "no bundle configured".to_owned(),
                };
            }
            return Ok(());
        };
        // Blocking work (file reads, hashing, native model construction,
        // probe inference) leaves the async lifecycle thread.
        let loaded = tokio::task::spawn_blocking(move || {
            let bundle = bundle::load_bundle(&config.bundle_dir)?;
            let ort = OrtIdentity {
                library: config.ort_library.clone(),
                sha256: config.ort_library_sha256.clone(),
            };
            let backend =
                Backend::load(&bundle, &ort).map_err(|e| bundle::BundleError(e.to_string()))?;
            Ok::<_, bundle::BundleError>(ReadyLane {
                lane: LaneInfo::from_manifest(&bundle.manifest),
                backend: Arc::new(backend),
            })
        })
        .await;
        let mut state = self.inner.state.lock().expect("synapse state lock");
        match loaded {
            Ok(Ok(lane)) => {
                *state = LaneState::Ready(Arc::new(lane));
                Ok(())
            }
            // An expected artifact fault is isolated degradation, never a
            // host-fatal initialization error.
            Ok(Err(error)) => {
                *state = LaneState::Disabled {
                    reason: error.to_string(),
                };
                Ok(())
            }
            Err(join_error) => Err(InitError(format!(
                "synapse initialization task failed: {join_error}"
            ))),
        }
    }
}
