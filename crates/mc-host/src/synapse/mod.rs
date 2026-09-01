//! Synapse is an optional, certified CPU-only local embedding component behind the `synapse/management_surface` target.
//!
//! Missing configuration, invalid bundles, incompatible ONNX Runtime, and failed certification disable only Synapse.
//! Artifact faults keep Synapse's catalog identity published and make binds reject with `artifact_invalid`.
//! Artifact faults make internal health report degraded.
//! panics and invariant violations remain host-fatal through the composite.
//!
//! Jobs are process-local and ephemeral; route loss cancels only response delivery.
//! Every started native inference call remains owned by the component's incarnation tracker until the component stops.
//! Shutdown drains the incarnation tracker before release.

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

/// Only trusted startup configuration sets Synapse's finite lane capacities.
/// Requests cannot select `SynapseLimits`; only trusted startup configuration provides them.
#[derive(Debug, Clone)]
pub struct SynapseLimits {
    /// `max_waiting_queries` limits queries waiting behind the one running query.
    /// When `max_waiting_queries` is zero, one query may run and every concurrent query is rejected immediately.
    /// rejected immediately.
    pub max_waiting_queries: usize,
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
    pub query_retry_after_ms: u64,
}

impl SynapseLimits {
    /// `per_waiter_charge_bound` bounds resident memory retained by one admitted query while it waits for or uses the CPU lane.
    /// JSON decoding can retain twice the decoded text length as `String` capacity.
    /// The handler retains response scratch until it encodes the terminal response.
    pub fn per_waiter_charge_bound(&self) -> Option<u64> {
        u64::try_from(self.max_text_bytes)
            .ok()?
            .checked_mul(2)?
            .checked_add(RESPONSE_SCRATCH_BYTES as u64)
    }

    /// `query_admission_permits` returns permits for one running query plus every allowed waiter.
    /// `query_admission_permits` is the single derivation of the permit rule.
    pub(crate) fn query_admission_permits(&self) -> Option<usize> {
        self.max_waiting_queries
            .checked_add(1)
            .filter(|permits| *permits <= tokio::sync::Semaphore::MAX_PERMITS)
    }

    /// A job holds at most `max_batch_items` items, so no page can hold more.
    /// The pager places at least one item in every page.
    /// `page_item_bound` is shared by runtime page reservation and startup validation.
    /// Sharing `page_item_bound` keeps startup validation aligned with runtime page reservation.
    pub(crate) fn page_item_bound(&self) -> usize {
        self.max_page_vectors
            .max(1)
            .min(self.max_batch_items.max(1))
    }
}

impl Default for SynapseLimits {
    fn default() -> Self {
        let max_batch_items = 64;
        Self {
            max_waiting_queries: 0,
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
            query_retry_after_ms: 50,
        }
    }
}

/// A component-level failure omits Synapse from the deployment.
#[derive(Debug, Clone)]
pub struct SynapseConfig {
    pub bundle_dir: PathBuf,
    /// The configured digest covers `bundle_dir/manifest.json`.
    /// The daemon supplies the selected generation's digest.
    /// The selected generation's digest binds every bundle artifact to the generation where it was staged.
    /// Hermetic fixtures without a generation root supply `None`.
    pub bundle_manifest_sha256: Option<String>,
    pub ort_library: PathBuf,
    pub ort_library_sha256: String,
    pub limits: SynapseLimits,
}

/// The verified manifest pins the catalog-facing lane identity.
#[derive(Debug, Clone)]
pub struct LaneInfo {
    pub model: String,
    pub fingerprint: String,
    pub table_epoch: u64,
    pub dims: usize,
    pub execution_provider: &'static str,
    /// Inference truncates tokens at `max_tokens`.
    /// Clients must chunk at `max_tokens` rather than a hardcoded limit.
    pub max_tokens: u32,
    /// `max_text_bytes` limits the UTF-8 bytes in one query or batch item.
    /// Clients must enforce `max_tokens` and `max_text_bytes` because token count has no fixed UTF-8 byte ratio.
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
            execution_provider: "cpu",
            // The manifest schema limits `max_tokens` to 1_048_576.
            // Casting `manifest.max_tokens` to `u32` is lossless.
            max_tokens: manifest.max_tokens as u32,
            max_text_bytes: bundle.max_text_bytes,
            provenance: manifest.provenance.clone(),
            recommended_rows: manifest.recommended_batch.rows,
            recommended_token_budget: manifest.recommended_batch.token_budget,
        }
    }
}

/// Tests can substitute an `EmbeddingEngine` implementation.
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
    Starting,
    Disabled { reason: String },
    Failing { reason: String },
}

enum LaneState {
    Starting,
    Disabled { reason: String },
    Ready(Arc<ReadyLane>),
    Failing { reason: String },
}

struct SynapseInner {
    config: Option<SynapseConfig>,
    unsupported_reason: Option<&'static str>,
    limits: SynapseLimits,
    state: Mutex<LaneState>,
    jobs: JobTable,
    /// `cpu` has one permit, so at most one native inference call runs at a time.
    /// The semaphore serves waiters in registration order.
    /// Semaphore registration order prevents starvation among queued waiters.
    /// Semaphore registration order does not guarantee host admission order.
    /// `cpu` queue order need not match host admission order because each query registers from a separate task.
    cpu: Arc<tokio::sync::Semaphore>,
    /// One running query plus at most `max_waiting_queries` waiters may use the serialized CPU lane.
    /// Admission is a non-blocking count: it decides whether a query may wait, not where it enters the queue.
    /// whether a query may wait at all, never where in the queue it lands.
    /// Batch work is bounded separately by the job table.
    query_admission: Arc<tokio::sync::Semaphore>,
    /// The component owns every started native call through shutdown.
    tracker: TaskTracker,
    /// Shutdown cancels queued work and closes admission.
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
        // Invalid configured limits make `initialize` return its typed error before bundle work begins.
        // Construction must not panic so `initialize` can return the typed limit-validation error.
        let query_admission_permits = limits.query_admission_permits().unwrap_or(1);
        Self {
            inner: Arc::new(SynapseInner {
                config,
                unsupported_reason: None,
                jobs: JobTable::new(limits.clone()),
                limits,
                state: Mutex::new(LaneState::Disabled {
                    reason: "not initialized".to_owned(),
                }),
                cpu: Arc::new(tokio::sync::Semaphore::new(1)),
                query_admission: Arc::new(tokio::sync::Semaphore::new(query_admission_permits)),
                tracker: TaskTracker::new(),
                closing: CancellationToken::new(),
            }),
        }
    }

    pub fn unsupported(reason: &'static str) -> Self {
        let limits = SynapseLimits::default();
        Self {
            inner: Arc::new(SynapseInner {
                config: None,
                unsupported_reason: Some(reason),
                jobs: JobTable::new(limits.clone()),
                limits,
                state: Mutex::new(LaneState::Disabled {
                    reason: reason.to_owned(),
                }),
                cpu: Arc::new(tokio::sync::Semaphore::new(1)),
                query_admission: Arc::new(tokio::sync::Semaphore::new(1)),
                tracker: TaskTracker::new(),
                closing: CancellationToken::new(),
            }),
        }
    }

    /// The test constructor creates a component with an immediately ready lane.
    /// The test constructor uses the supplied engine without bundle loading or ORT.
    ///
    /// # Errors
    ///
    /// `initialize` returns `bundle::BundleError` when lane or serving-limit validation fails.
    /// `ready_with_engine` enforces the startup bounds used for loaded bundles.
    pub fn ready_with_engine(
        mut lane: LaneInfo,
        engine: Arc<dyn EmbeddingEngine>,
        limits: SynapseLimits,
    ) -> Result<Self, bundle::BundleError> {
        bundle::validate_serving_limits(lane.dims, lane.recommended_rows as usize, &limits)?;
        // `validate_serving_limits` rejects permit-count overflow.
        // Validated limits always have a permit count.
        let query_admission_permits = limits
            .query_admission_permits()
            .expect("validate_serving_limits proves the permit count");
        lane.max_text_bytes = limits.max_text_bytes;
        Ok(Self {
            inner: Arc::new(SynapseInner {
                config: None,
                unsupported_reason: None,
                jobs: JobTable::new(limits.clone()),
                limits,
                state: Mutex::new(LaneState::Ready(Arc::new(ReadyLane {
                    backend: engine,
                    lane,
                }))),
                cpu: Arc::new(tokio::sync::Semaphore::new(1)),
                query_admission: Arc::new(tokio::sync::Semaphore::new(query_admission_permits)),
                tracker: TaskTracker::new(),
                closing: CancellationToken::new(),
            }),
        })
    }

    pub fn status(&self) -> SynapseStatus {
        match &*self.inner.state.lock().expect("synapse state lock") {
            LaneState::Ready(lane) => SynapseStatus::Ready(lane.lane.clone()),
            LaneState::Starting => SynapseStatus::Starting,
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

    /// `Invariant` errors mark the lane failing before returning, so later callers cannot obtain vectors from a suspect backend.
    /// backend.
    pub fn embed_blocking(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, InferenceError> {
        let Some(lane) = self.ready_lane() else {
            let reason = match self.status() {
                SynapseStatus::Disabled { reason } | SynapseStatus::Failing { reason } => reason,
                SynapseStatus::Starting => STARTING_REASON.to_owned(),
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

/// Captured `Arc<ReadyLane>` values can outlive a failing state transition, so callers must not run a captured backend after the transition.
fn lane_failure_reason(inner: &SynapseInner) -> Option<String> {
    match &*inner.state.lock().expect("synapse state lock") {
        LaneState::Ready(_) => None,
        LaneState::Starting => Some(STARTING_REASON.to_owned()),
        LaneState::Disabled { reason } | LaneState::Failing { reason } => Some(reason.clone()),
    }
}

/// `STARTING_REASON` provides a fixed reason until activation settles the lane.
const STARTING_REASON: &str = "the synapse lane is still starting";

fn embed_via(
    inner: &SynapseInner,
    lane: &ReadyLane,
    texts: &[&str],
) -> Result<Vec<Vec<f32>>, InferenceError> {
    settle_inference(inner, Ok(lane.backend.embed(texts)))
}

/// `Invariant` failures and panicked blocking tasks mark the lane failing before any sink receives the error, preventing later callers from receiving vectors from a suspect backend.
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

/// A distinct error wrapper prevents an engine from spoofing cancellation.
enum QueryFault {
    Cancelled,
    Timeout,
    Engine(InferenceError),
}

/// The drop guard fails a started batch job unless publication disarms it, preventing an unwinding worker from leaving the job running with its charge held.
struct AbandonGuard {
    inner: Arc<SynapseInner>,
    seq: u64,
    armed: bool,
}

impl Drop for AbandonGuard {
    fn drop(&mut self) {
        if self.armed {
            // A worker that exits without publication reports a host task failure and leaves the lane serving.
            self.inner.jobs.publish_failed(
                self.seq,
                "internal_error".to_owned(),
                "batch worker exited before publication".to_owned(),
            );
        }
    }
}

const RESPONSE_SCRATCH_BYTES: usize = 256;

/// After `shrink_to(owned)`, the resident charge must contain `owned`; a smaller charge undercharges the request because `split_or_take` can return less than requested.
/// `shrink_covered` asserts in debug builds and returns `queue_full` in release builds when `charge.bytes() < owned`.
fn shrink_covered(
    charge: &mut crate::wire::ByteCharge,
    owned: usize,
) -> Result<(), RequestOutcome> {
    charge.shrink_to(owned);
    if charge.bytes() < owned {
        debug_assert!(
            false,
            "parse reservation ({} bytes) is smaller than the post-decode owned bytes ({owned})",
            charge.bytes(),
        );
        return Err(app_error(
            "queue_full",
            "the parse reservation did not cover the decoded request",
        ));
    }
    Ok(())
}

pub(crate) fn owned_input_bytes(request: &Request) -> usize {
    let owned = match request {
        // `Request::ModelsList` uses lane info and releases its charge before responding.
        Request::ModelsList => 0,
        Request::EmbedQuery { text, .. } => text.capacity(),
        Request::EmbedBatch {
            request_key,
            canonical_key,
            items,
        } => jobs::job_input_bytes(request_key, items)
            .saturating_add(request_key.capacity())
            .saturating_add(canonical_key.capacity()),
        Request::EmbedResult {
            job_id,
            request_key,
            cursor,
        } => job_id
            .capacity()
            .saturating_add(request_key.capacity())
            .saturating_add(cursor.as_ref().map_or(0, String::capacity)),
    };
    owned.saturating_add(RESPONSE_SCRATCH_BYTES)
}

fn request_error(error: RequestError) -> RequestOutcome {
    RequestOutcome::error(error.code, error.message)
}

fn app_error(code: &str, message: &str) -> RequestOutcome {
    RequestOutcome::error(code, message)
}

///
/// `expired_query` treats every non-`Timeout` result as an expired running query.
/// drift apart.
fn expired_query(result: Option<&Result<Vec<Vec<f32>>, QueryFault>>) -> RequestOutcome {
    match result {
        Some(Err(QueryFault::Timeout)) => {
            app_error("timeout", "the query deadline expired while queued")
        }
        _ => app_error("timeout", "the query deadline expired awaiting the result"),
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

/// `respond_vectors` reserves output before serialization so resident-byte accounting covers the body buffer.
/// Only vector-bearing response bodies use the paged-response path.
/// At most `max_handler_tasks` vector-bearing response bodies are in flight.
/// The reservation uses the page's item count rather than the page cap.
/// An oversized reservation holds egress budget for the buffer's lifetime.
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
            return RequestOutcome::error_retry_after(
                "queue_full",
                "query admission capacity is exhausted",
                self.inner.limits.query_retry_after_ms,
            );
        };
        // The handler's `ByteCharge` copy remains held until response serialization completes.
        // The worker's `ByteCharge` copy remains held through native calls that can outlive request deadlines.
        let _query_permit = Arc::new(query_permit);
        let worker_query_permit = Arc::clone(&_query_permit);
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_millis(deadline_ms.unwrap_or(protocol::MAX_DEADLINE_MS));
        let content_sha256 = protocol::sha256_hex(text.as_bytes());
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<Vec<f32>>, QueryFault>>();
        let inner = Arc::clone(&self.inner);
        let lane_task = Arc::clone(&lane);
        // The tracked task owns the native call; the handler future only waits for its response.
        // Route loss or a deadline cancels waiting without orphaning inference.
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
                // A closed receiver cancels queued calls before native work starts.
                // Once the permit is held, the native call runs even if the receiver closes.
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
            // A predecessor's invariant failure can mark the serialized lane while a query waits for the permit.
            // The failing-lane branch reports the lane's existing fault rather than creating a new one.
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

        let mut rx = rx;
        let result = tokio::select! {
            biased;
            result = &mut rx => match result {
                Err(_) => return app_error("internal_error", "the inference task was lost"),
                Ok(result) => result,
            },
            () = tokio::time::sleep_until(deadline) => {
                // The worker's queued-deadline arm and the handler timer use the same deadline.
                // The worker's verdict distinguishes queued queries from running queries.
                // The handler yields so `rx.try_recv()` can observe a ready worker verdict before reporting expiry.
                // The channel check observes a ready worker verdict before reporting expiry.
                tokio::task::yield_now().await;
                return expired_query(rx.try_recv().ok().as_ref());
            }
        };
        // The post-receive deadline check rejects results received after the deadline.
        // If both arms are ready after descheduling, `biased` selects the receiver.
        // Without the post-receive deadline check, a vector sent after the deadline would be returned successfully.
        //
        // Cancellation takes precedence over expiry.
        if tokio::time::Instant::now() >= deadline && !matches!(result, Err(QueryFault::Cancelled))
        {
            return expired_query(Some(&result));
        }
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
                app_error("timeout", "the query deadline expired while queued")
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
                () = inner.closing.cancelled() => return,
                permit = Arc::clone(&inner.cpu).acquire_owned() => permit,
            };
            let Ok(_permit) = permit else { return };
            if let Some(reason) = lane_failure_reason(&inner) {
                inner
                    .jobs
                    .publish_failed(seq, "artifact_invalid".to_owned(), reason);
                return;
            }
            let Some(items) = inner.jobs.start(seq) else {
                return;
            };
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
        // The handler reserves the maximum page-metadata charge before polling because the measured metadata is unavailable until afterward.
        let page_meta_bound = self
            .inner
            .limits
            .page_item_bound()
            .saturating_mul(jobs::MAX_ITEM_ID_BYTES + jobs::CONTENT_SHA256_BYTES);
        let reserved = match ctx.try_reserve_resident(page_meta_bound) {
            Some(charge) => Some(charge),
            None => {
                self.inner.jobs.sweep();
                ctx.try_reserve_resident(page_meta_bound)
            }
        };
        let Some(mut meta_charge) = reserved else {
            return app_error(
                "queue_full",
                "resident capacity for the result page is exhausted",
            );
        };
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
            PollOutcome::Failed { code, message } => RequestOutcome::error(code, message),
            PollOutcome::Pending { status } => {
                respond(
                    ctx,
                    protocol::pending_body(&job_id, status, self.inner.limits.retry_after_ms),
                )
                .await
            }
            PollOutcome::Page(page) => {
                let meta_bytes: usize = page
                    .vectors
                    .iter()
                    .map(|(id, hash, _)| id.len() + hash.len())
                    .sum();
                if let Err(outcome) = shrink_covered(&mut meta_charge, meta_bytes) {
                    return outcome;
                }
                let items: Vec<protocol::VectorItemView<'_>> = page
                    .vectors
                    .iter()
                    .map(|(id, hash, vector)| protocol::VectorItemView {
                        id,
                        content_sha256: hash,
                        vector,
                    })
                    .collect();
                let outcome = respond_vectors(
                    ctx,
                    &lane.lane,
                    &items,
                    page.done,
                    page.next_cursor.as_deref(),
                )
                .await;
                drop(meta_charge);
                outcome
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

    fn resources(&self) -> crate::handler::ResourceDeclaration {
        //
        if self.inner.config.is_none() && self.ready_lane().is_none() {
            return crate::handler::ResourceDeclaration::default();
        }
        crate::handler::ResourceDeclaration {
            general_task_hold_bound: self.inner.limits.max_waiting_queries.saturating_add(1),
            ..Default::default()
        }
    }

    async fn bind(&self, _route: RouteHandle, _identity: RouteIdentity) -> BindOutcome {
        match self.status() {
            SynapseStatus::Ready(_) => BindOutcome::Accept,
            SynapseStatus::Starting => BindOutcome::Reject {
                code: "module_reloading".to_owned(),
                message: STARTING_REASON.to_owned(),
            },
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
        // A reservation above `capacity` remains unadmittable after draining.
        // Bodies exceeding `capacity` require a size rejection instead of `queue_full`.
        // Reservations exceeding `capacity` require a size rejection instead of `queue_full`.
        let capacity = ctx.resident_capacity();
        if reservation_bytes > capacity {
            return request_error(protocol::unservable_body_error(
                ctx.body.len(),
                reservation_bytes,
                capacity,
            ));
        }
        // The handler sweeps expired jobs after reservation failure because expired charges may be blocking admission.
        // Sweeping only after reservation failure avoids the job-table lock and expiry scan on successful requests.
        let reserved = match ctx.try_reserve_resident(reservation_bytes) {
            Some(charge) => Some(charge),
            None => {
                self.inner.jobs.sweep();
                ctx.try_reserve_resident(reservation_bytes)
            }
        };
        let Some(mut charge) = reserved else {
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
        // `owned_input_bytes` must fit within `charge`.
        if let Err(outcome) = shrink_covered(&mut charge, owned_input_bytes(&request)) {
            return outcome;
        }
        match request {
            Request::ModelsList => {
                drop(charge);
                respond(&ctx, protocol::models_list_body(&lane.lane)).await
            }
            Request::EmbedQuery { text, deadline_ms } => {
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
                self.handle_batch(&ctx, lane, request_key, canonical_key, items, charge)
                    .await
            }
            Request::EmbedResult {
                job_id,
                request_key,
                cursor,
            } => {
                let _handler_charge = charge;
                self.handle_result(&ctx, lane, job_id, request_key, cursor)
                    .await
            }
        }
    }

    async fn route_gone(&self, _route: RouteHandle) {}

    async fn health(&self) -> HealthReport {
        match self.status() {
            SynapseStatus::Ready(_) => HealthReport {
                status: HealthStatus::Ok,
                detail: None,
                metrics: Some(serde_json::json!({"synapse_state": "ready"})),
            },
            SynapseStatus::Starting => HealthReport {
                status: HealthStatus::Degraded,
                detail: Some(STARTING_REASON.to_owned()),
                metrics: Some(serde_json::json!({"synapse_state": "starting"})),
            },
            SynapseStatus::Disabled { reason } => HealthReport {
                status: HealthStatus::Degraded,
                metrics: Some(serde_json::json!({
                    "synapse_state": if reason == "synapse_unsupported" {
                        "unsupported"
                    } else {
                        "degraded"
                    }
                })),
                detail: Some(reason),
            },
            SynapseStatus::Failing { reason } => HealthReport {
                status: HealthStatus::Failing,
                detail: Some(reason),
                metrics: Some(serde_json::json!({"synapse_state": "degraded"})),
            },
        }
    }

    /// Shutdown closes admission and cancels queued wrappers before joining every started native call through its incarnation.
    /// Shutdown never aborts a started native call.
    /// native call.
    async fn shutdown(&self) -> Result<(), crate::composite::ShutdownError> {
        self.inner.closing.cancel();
        self.inner.jobs.close_admission();
        self.inner.tracker.close();
        self.inner.tracker.wait().await;
        self.inner.jobs.clear();
        Ok(())
    }
}

impl SecondaryComponent for SynapseComponent {
    async fn initialize(&self) -> Result<(), InitError> {
        let mut state = self.inner.state.lock().expect("synapse state lock");
        // A pre-readied lane has no configuration to load and remains ready.
        if matches!(&*state, LaneState::Ready(_)) {
            return Ok(());
        }
        *state = if self.inner.config.is_some() {
            // Transport does not wait for bundle verification, ORT loading, or model construction.
            // Pre-publication bootstrap records only that the lane is starting.
            LaneState::Starting
        } else if let Some(reason) = self.inner.unsupported_reason {
            LaneState::Disabled {
                reason: reason.to_owned(),
            }
        } else {
            LaneState::Disabled {
                reason: "no bundle configured".to_owned(),
            }
        };
        Ok(())
    }

    async fn activate(&self) -> Result<(), InitError> {
        let Some(config) = self.inner.config.clone() else {
            return Ok(());
        };
        // Invalid limits fail activation rather than disabling the lane.
        if let Err(error) = bundle::validate_limits(&config.limits) {
            return Err(InitError(format!("synapse limits are invalid: {error}")));
        }
        // Dropping the activation future does not stop the blocking task.
        let blocking = tokio::task::spawn_blocking(move || {
            let bundle = bundle::load_bundle(
                &config.bundle_dir,
                &config.limits,
                config.bundle_manifest_sha256.as_deref(),
            )?;
            let ort = OrtIdentity {
                library: config.ort_library.clone(),
                sha256: config.ort_library_sha256.clone(),
            };
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
            Err(join_error) => Err(join_error),
        };
        let mut state = self.inner.state.lock().expect("synapse state lock");
        match loaded {
            Ok(Ok(lane)) => {
                *state = LaneState::Ready(Arc::new(lane));
                Ok(())
            }
            // A `BundleError` disables the lane without failing activation.
            Ok(Err(error)) => {
                *state = LaneState::Disabled {
                    reason: error.to_string(),
                };
                Ok(())
            }
            Err(join_error) => Err(InitError(format!(
                "synapse activation task failed: {join_error}"
            ))),
        }
    }
}
