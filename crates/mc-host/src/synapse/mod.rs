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
        let max_batch_items = 64;
        Self {
            max_queued_jobs: 64,
            max_queued_request_bytes: 64 * 1024 * 1024,
            max_retained_jobs: 64,
            max_retained_result_bytes: 64 * 1024 * 1024,
            max_batch_items,
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
    /// Token window inference truncates at; published so clients chunk to
    /// the real boundary instead of a hardcoded guess.
    pub max_tokens: u32,
    /// UTF-8 bytes accepted for one query or batch item. Token count has no
    /// fixed byte ratio, so clients must enforce both advertised limits.
    pub max_text_bytes: usize,
    pub provenance: serde_json::Value,
    pub recommended_rows: u32,
    pub recommended_token_budget: u32,
}

impl LaneInfo {
    fn from_bundle(bundle: &bundle::VerifiedBundle) -> Self {
        let manifest = &bundle.manifest;
        Self {
            model: manifest.model.clone(),
            fingerprint: manifest.fingerprint.clone(),
            table_epoch: manifest.table_epoch,
            dims: manifest.dims as usize,
            // Bounded by the manifest schema (at most 1_048_576), so the
            // narrowing cast is lossless.
            max_tokens: manifest.max_tokens as u32,
            max_text_bytes: bundle.max_text_bytes,
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
    /// At most one query may wait for or use the serialized CPU lane. Batch
    /// work is bounded separately by the job table.
    query_admission: Arc<tokio::sync::Semaphore>,
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
                query_admission: Arc::new(tokio::sync::Semaphore::new(1)),
                tracker: TaskTracker::new(),
                closing: CancellationToken::new(),
            }),
        }
    }

    /// Test seam: a component whose lane is immediately ready over the
    /// supplied engine, bypassing bundle loading and ORT.
    pub fn ready_with_engine(
        mut lane: LaneInfo,
        engine: Arc<dyn EmbeddingEngine>,
        limits: SynapseLimits,
    ) -> Self {
        lane.max_text_bytes = limits.max_text_bytes;
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
                query_admission: Arc::new(tokio::sync::Semaphore::new(1)),
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

/// The reason the lane is no longer servable, or `None` while it is ready.
/// Callers hold an `Arc<ReadyLane>` captured at admission, which outlives the
/// state machine's verdict: the CPU permit can be granted after a predecessor
/// marked the lane failing, and running that captured backend anyway would
/// serve a vector from a suspect engine.
fn lane_failure_reason(inner: &SynapseInner) -> Option<String> {
    match &*inner.state.lock().expect("synapse state lock") {
        LaneState::Ready(_) => None,
        LaneState::Disabled { reason } | LaneState::Failing { reason } => Some(reason.clone()),
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
    Timeout,
    Engine(InferenceError),
}

/// Fails a started batch job on drop unless disarmed by publication, so a
/// worker task that unwinds after `start` cannot leave the job pinned in a
/// Running state with its charge held.
struct AbandonGuard {
    inner: Arc<SynapseInner>,
    seq: u64,
    armed: bool,
}

impl Drop for AbandonGuard {
    fn drop(&mut self) {
        if self.armed {
            self.inner.jobs.publish_failed(
                self.seq,
                "artifact_invalid".to_owned(),
                "batch worker exited before publication".to_owned(),
            );
        }
    }
}

const RESPONSE_SCRATCH_BYTES: usize = 256;

/// The parse reservation must dominate every post-decode owned size the
/// handler shrinks to. `ByteCharge::shrink_to` cannot grow a charge, and
/// `split_or_take` falls back to "take what is left" rather than erroring,
/// so an undersized reservation silently under-charges the job — the bug
/// class the resident budget exists to close. After `shrink_to(owned)` the
/// charge holds `min(reservation, owned)`, so holding fewer than `owned`
/// bytes proves the reservation formula no longer dominates real usage.
fn debug_assert_reservation_covered(charge: &crate::wire::ByteCharge, owned: usize) {
    debug_assert!(
        charge.bytes() >= owned,
        "parse reservation ({} bytes) is smaller than the post-decode owned bytes ({owned})",
        charge.bytes(),
    );
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

/// Reserves output before the body exists, then serializes into it. Only
/// vector-bearing bodies take this path: they run to the page cap and up to
/// `max_handler_tasks` of them are in flight at once, so building the body
/// first would hold megabytes outside the resident-byte budget the
/// reservation contract exists to enforce. The reservation is sized from the
/// page's own items rather than the cap, because the charge is held for the
/// buffer's whole lifetime and an oversized reservation would strand egress
/// budget the remaining handlers need. Fixed-size bodies keep using
/// [`respond`], where the body is a small bounded constant.
async fn respond_vectors(
    ctx: &RequestCtx,
    lane: &LaneInfo,
    items: &[protocol::VectorItemView<'_>],
    done: bool,
    next_cursor: Option<&str>,
) -> RequestOutcome {
    let reservation = protocol::vector_body_reservation(lane, items, next_cursor);
    let Ok(mut output) = ctx.reserve_output(reservation).await else {
        return app_error("internal_error", "output reservation failed");
    };
    if protocol::write_vector_body(&mut output, lane, items, done, next_cursor).is_err() {
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
        text_charge: crate::wire::ByteCharge,
    ) -> RequestOutcome {
        if self.inner.closing.is_cancelled() {
            return app_error("cancelled", "the host is shutting down");
        }
        let Ok(query_permit) = Arc::clone(&self.inner.query_admission).try_acquire_owned() else {
            return app_error("queue_full", "query admission capacity is exhausted");
        };
        // The handler copy keeps the query lane charged while the response is
        // produced; the worker copy keeps the charge through a native call
        // that outlives its request deadline.
        let _query_permit = Arc::new(query_permit);
        let worker_query_permit = Arc::clone(&_query_permit);
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_millis(deadline_ms.unwrap_or(protocol::MAX_DEADLINE_MS));
        let content_sha256 = protocol::sha256_hex(text.as_bytes());
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<Vec<f32>>, QueryFault>>();
        let inner = Arc::clone(&self.inner);
        let lane_task = Arc::clone(&lane);
        // The tracked task owns the native call; this handler future is only
        // the response waiter, so route loss or a deadline cancels waiting
        // without orphaning inference.
        self.inner.tracker.spawn(async move {
            let _query_permit = worker_query_permit;
            let _text_charge = text_charge;
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
                () = tokio::time::sleep_until(deadline) => {
                    let _ = tx.send(Err(QueryFault::Timeout));
                    return;
                }
                permit = Arc::clone(&inner.cpu).acquire_owned() => permit,
            };
            let Ok(_permit) = permit else {
                let _ = tx.send(Err(QueryFault::Engine(InferenceError::Invariant(
                    "cpu semaphore closed".to_owned(),
                ))));
                return;
            };
            // Serialized queries queue behind one another, so a predecessor's
            // invariant failure can condemn the lane while this call waits.
            // The lane is already marked, so this reports the existing fault
            // rather than declaring a new one.
            if let Some(reason) = lane_failure_reason(&inner) {
                let _ = tx.send(Err(QueryFault::Engine(InferenceError::Artifact(reason))));
                return;
            }
            let lane_blocking = Arc::clone(&lane_task);
            let joined =
                tokio::task::spawn_blocking(move || lane_blocking.backend.embed(&[text.as_str()]))
                    .await;
            let result = settle_inference(&inner, joined).map_err(QueryFault::Engine);
            let _ = tx.send(result);
        });

        let result = match tokio::time::timeout_at(deadline, rx).await {
            Err(_) => return app_error("timeout", "the query deadline expired host-side"),
            Ok(Err(_)) => return app_error("internal_error", "the inference task was lost"),
            Ok(Ok(result)) => result,
        };
        match result {
            Ok(vectors) => match vectors.first() {
                Some(vector) => {
                    let items = [protocol::VectorItemView {
                        id: "query",
                        content_sha256: &content_sha256,
                        vector,
                    }];
                    respond_vectors(ctx, &lane.lane, &items, true, None).await
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
            Err(QueryFault::Timeout) => {
                app_error("timeout", "the query deadline expired host-side")
            }
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
        mut charge: crate::wire::ByteCharge,
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
        match self
            .inner
            .jobs
            .admit_charged(request_key.clone(), items, lane.lane.dims, &mut charge)
        {
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
            AdmitOutcome::ResultTooLarge => app_error(
                "schema_violation",
                "batch result exceeds the retained-result byte limit",
            ),
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
            // A queued batch inherits the same hazard as a queued query: the
            // lane can be condemned while this worker waits for the permit,
            // and the job fails against the existing reason instead of
            // running the suspect backend.
            if let Some(reason) = lane_failure_reason(&inner) {
                inner
                    .jobs
                    .publish_failed(seq, "artifact_invalid".to_owned(), reason);
                return;
            }
            let Some(items) = inner.jobs.start(seq) else {
                return;
            };
            // `fail_job` is idempotent, so a normal publication wins even if
            // the guard also fires.
            let mut settle_guard = AbandonGuard {
                inner: Arc::clone(&inner),
                seq,
                armed: true,
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
            settle_guard.armed = false;
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
                let items: Vec<protocol::VectorItemView<'_>> = page
                    .vectors
                    .iter()
                    .map(|(id, hash, vector)| protocol::VectorItemView {
                        id,
                        content_sha256: hash,
                        vector,
                    })
                    .collect();
                respond_vectors(
                    ctx,
                    &lane.lane,
                    &items,
                    page.done,
                    page.next_cursor.as_deref(),
                )
                .await
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
        if let Err(error) = protocol::preflight(&ctx.body, ctx.binary) {
            return request_error(error);
        }
        let Some(reservation_bytes) =
            protocol::parse_reservation_bytes(ctx.body.len(), &self.inner.limits)
        else {
            return app_error("queue_full", "the parse reservation bound is unsatisfiable");
        };
        // The handler reserves resident capacity before decoding.
        let Some(mut charge) = ctx.try_reserve_resident(reservation_bytes) else {
            return app_error(
                "queue_full",
                "resident capacity for request parsing is exhausted",
            );
        };
        let request = match protocol::decode_request(&ctx.body, &lane.lane, &self.inner.limits) {
            Ok(request) => request,
            Err(error) => {
                drop(charge);
                return request_error(error);
            }
        };
        match request {
            Request::ModelsList => {
                drop(charge);
                respond(&ctx, protocol::models_list_body(&lane.lane)).await
            }
            Request::EmbedQuery { text, deadline_ms } => {
                let owned = text.capacity() + RESPONSE_SCRATCH_BYTES;
                charge.shrink_to(owned);
                debug_assert_reservation_covered(&charge, owned);
                let text_charge = charge.split_or_take(text.capacity());
                let _handler_charge = charge;
                self.handle_query(&ctx, lane, text, deadline_ms, text_charge)
                    .await
            }
            Request::EmbedBatch {
                request_key,
                canonical_key,
                items,
            } => {
                let owned = jobs::job_input_bytes(&request_key, &items)
                    .saturating_add(request_key.capacity())
                    .saturating_add(canonical_key.capacity())
                    .saturating_add(RESPONSE_SCRATCH_BYTES);
                charge.shrink_to(owned);
                debug_assert_reservation_covered(&charge, owned);
                self.handle_batch(&ctx, lane, request_key, canonical_key, items, charge)
                    .await
            }
            Request::EmbedResult {
                job_id,
                request_key,
                cursor,
            } => {
                let owned = job_id
                    .capacity()
                    .saturating_add(request_key.capacity())
                    .saturating_add(cursor.as_ref().map_or(0, String::capacity))
                    .saturating_add(RESPONSE_SCRATCH_BYTES);
                charge.shrink_to(owned);
                debug_assert_reservation_covered(&charge, owned);
                let _handler_charge = charge;
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
        // probe inference) leaves the async lifecycle thread. Blocking tasks
        // detach on drop and cannot be stopped once running, so completion is
        // routed through the incarnation tracker: if this future is dropped
        // at the await (initialization abort), the tracked wrapper still owns
        // the closure's completion, and `shutdown`'s tracker drain holds
        // until the native load actually stops.
        let blocking = tokio::task::spawn_blocking(move || {
            let bundle = bundle::load_bundle(&config.bundle_dir, &config.limits)?;
            let ort = OrtIdentity {
                library: config.ort_library.clone(),
                sha256: config.ort_library_sha256.clone(),
            };
            // The advertised lane summary is derived from the manifest before
            // the bundle moves into the backend, which consumes it so the
            // weight buffers are never duplicated.
            let lane = LaneInfo::from_bundle(&bundle);
            let backend =
                Backend::load(bundle, &ort).map_err(|e| bundle::BundleError(e.to_string()))?;
            Ok::<_, bundle::BundleError>(ReadyLane {
                lane,
                backend: Arc::new(backend),
            })
        });
        let loaded = match self.inner.tracker.spawn(blocking).await {
            Ok(joined) => joined,
            // The wrapper never panics and is never aborted, so a lost
            // wrapper is the same initialization failure as a lost closure.
            Err(join_error) => Err(join_error),
        };
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
