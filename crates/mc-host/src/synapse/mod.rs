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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

pub const HISTOGRAM_EDGES_MS: [u64; 12] = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000];
pub const HISTOGRAM_BUCKETS: usize = HISTOGRAM_EDGES_MS.len() + 1;
/// Terminal outcomes for a query waiting on the CPU permit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryWaitOutcome {
    Granted,
    Timeout,
    WaiterGone,
    CancelledOrClosed,
}

impl QueryWaitOutcome {
    pub const fn slot(self) -> usize {
        match self {
            Self::Granted => 0,
            Self::Timeout => 1,
            Self::WaiterGone => 2,
            Self::CancelledOrClosed => 3,
        }
    }
}

/// Terminal outcomes for a batch waiting on the CPU permit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchWaitOutcome {
    Granted,
    Cancelled,
    Closed,
}

impl BatchWaitOutcome {
    pub const fn slot(self) -> usize {
        match self {
            Self::Granted => 0,
            Self::Cancelled => 1,
            Self::Closed => 2,
        }
    }
}

/// Fixed reasons why Synapse rejects work as `queue_full`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueFullReason {
    ParseReservationUnsatisfiable,
    ParseResidentExhausted,
    CoverageShort,
    QueryAdmission,
    JobAdmission,
    ResultPageResident,
}

impl QueueFullReason {
    pub const fn slot(self) -> usize {
        match self {
            Self::ParseReservationUnsatisfiable => 0,
            Self::ParseResidentExhausted => 1,
            Self::CoverageShort => 2,
            Self::QueryAdmission => 3,
            Self::JobAdmission => 4,
            Self::ResultPageResident => 5,
        }
    }
}

/// Outcome of one handler poll attempt before its response is produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PollMetricOutcome {
    Restarted,
    KeyMismatch,
    BadCursor,
    Failed,
    PendingQueued,
    PendingRunning,
    Page,
}

impl PollMetricOutcome {
    pub const fn slot(self) -> usize {
        match self {
            Self::Restarted => 0,
            Self::KeyMismatch => 1,
            Self::BadCursor => 2,
            Self::Failed => 3,
            Self::PendingQueued => 4,
            Self::PendingRunning => 5,
            Self::Page => 6,
        }
    }
}

pub const QUERY_WAIT_OUTCOMES: usize = 4;
pub const BATCH_WAIT_OUTCOMES: usize = 3;
pub const QUEUE_FULL_REASONS: usize = 6;
pub const POLL_OUTCOMES: usize = 7;

/// Plain snapshot of one fixed-edge duration histogram.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct HistogramSnapshot {
    pub buckets: [u64; HISTOGRAM_BUCKETS],
    pub count: u64,
    pub sum_us: u64,
}

/// Query and batch snapshots for one duration category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct LaneHistogramsSnapshot {
    pub query: HistogramSnapshot,
    pub batch: HistogramSnapshot,
}

/// Query and batch terminal permit-wait counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct WaitOutcomeSnapshot {
    pub query: [u64; QUERY_WAIT_OUTCOMES],
    pub batch: [u64; BATCH_WAIT_OUTCOMES],
}

/// Allocation-free, fixed-cardinality Synapse metrics snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct SynapseMetricsSnapshot {
    pub cpu_wait: LaneHistogramsSnapshot,
    pub cpu_hold: LaneHistogramsSnapshot,
    pub inference: LaneHistogramsSnapshot,
    pub cpu_wait_outcome: WaitOutcomeSnapshot,
    pub queue_full: [u64; QUEUE_FULL_REASONS],
    pub poll_outcome: [u64; POLL_OUTCOMES],
    pub batch_items_embedded: u64,
    pub free_cpu_permits: usize,
    pub free_query_permits: usize,
    pub jobs_active: usize,
    pub jobs_retained: usize,
    pub queued_text_bytes: u64,
    pub retained_result_bytes: u64,
}

/// Fixed-edge duration histogram with monotonic relaxed atomic counters.
#[derive(Default)]
struct Histogram {
    buckets: [AtomicU64; HISTOGRAM_BUCKETS],
    count: AtomicU64,
    sum_us: AtomicU64,
}

impl Histogram {
    fn record(&self, duration: Duration) {
        let elapsed_ms = duration.as_millis();
        let bucket = HISTOGRAM_EDGES_MS
            .iter()
            .position(|edge_ms| elapsed_ms < u128::from(*edge_ms))
            .unwrap_or(HISTOGRAM_EDGES_MS.len());
        self.buckets[bucket].fetch_add(1, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
        saturating_add(
            &self.sum_us,
            u64::try_from(duration.as_micros()).unwrap_or(u64::MAX),
        );
    }

    fn snapshot(&self) -> HistogramSnapshot {
        HistogramSnapshot {
            buckets: load_counters(&self.buckets),
            count: self.count.load(Ordering::Relaxed),
            sum_us: self.sum_us.load(Ordering::Relaxed),
        }
    }
}

/// Shared fixed-cardinality metrics core for one Synapse component.
pub struct SynapseMetrics {
    cpu_wait_query: Histogram,
    cpu_wait_batch: Histogram,
    cpu_hold_query: Histogram,
    cpu_hold_batch: Histogram,
    inference_query: Histogram,
    inference_batch: Histogram,
    query_wait_outcome: [AtomicU64; QUERY_WAIT_OUTCOMES],
    batch_wait_outcome: [AtomicU64; BATCH_WAIT_OUTCOMES],
    queue_full: [AtomicU64; QUEUE_FULL_REASONS],
    poll_outcome: [AtomicU64; POLL_OUTCOMES],
    batch_items_embedded: AtomicU64,
    cpu: Arc<tokio::sync::Semaphore>,
    query_admission: Arc<tokio::sync::Semaphore>,
    jobs: Arc<JobTable>,
}

impl SynapseMetrics {
    fn new(
        cpu: Arc<tokio::sync::Semaphore>,
        query_admission: Arc<tokio::sync::Semaphore>,
        jobs: Arc<JobTable>,
    ) -> Self {
        Self {
            cpu_wait_query: Histogram::default(),
            cpu_wait_batch: Histogram::default(),
            cpu_hold_query: Histogram::default(),
            cpu_hold_batch: Histogram::default(),
            inference_query: Histogram::default(),
            inference_batch: Histogram::default(),
            query_wait_outcome: std::array::from_fn(|_| AtomicU64::new(0)),
            batch_wait_outcome: std::array::from_fn(|_| AtomicU64::new(0)),
            queue_full: std::array::from_fn(|_| AtomicU64::new(0)),
            poll_outcome: std::array::from_fn(|_| AtomicU64::new(0)),
            batch_items_embedded: AtomicU64::new(0),
            cpu,
            query_admission,
            jobs,
        }
    }

    pub(crate) fn record_cpu_wait_query(&self, duration: Duration) {
        self.cpu_wait_query.record(duration);
    }

    pub(crate) fn record_cpu_wait_batch(&self, duration: Duration) {
        self.cpu_wait_batch.record(duration);
    }

    pub(crate) fn record_cpu_hold_query(&self, duration: Duration) {
        self.cpu_hold_query.record(duration);
    }

    pub(crate) fn record_cpu_hold_batch(&self, duration: Duration) {
        self.cpu_hold_batch.record(duration);
    }

    pub(crate) fn record_inference_query(&self, duration: Duration) {
        self.inference_query.record(duration);
    }

    pub(crate) fn record_inference_batch(&self, duration: Duration) {
        self.inference_batch.record(duration);
    }

    pub(crate) fn increment_query_wait_outcome(&self, outcome: QueryWaitOutcome) {
        self.query_wait_outcome[outcome.slot()].fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn increment_batch_wait_outcome(&self, outcome: BatchWaitOutcome) {
        self.batch_wait_outcome[outcome.slot()].fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn increment_queue_full(&self, reason: QueueFullReason) {
        self.queue_full[reason.slot()].fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn increment_poll_outcome(&self, outcome: PollMetricOutcome) {
        self.poll_outcome[outcome.slot()].fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn add_batch_items_embedded(&self, count: usize) {
        saturating_add(
            &self.batch_items_embedded,
            u64::try_from(count).unwrap_or(u64::MAX),
        );
    }

    pub fn snapshot(&self) -> SynapseMetricsSnapshot {
        let depth = self.jobs.depth();
        SynapseMetricsSnapshot {
            cpu_wait: LaneHistogramsSnapshot {
                query: self.cpu_wait_query.snapshot(),
                batch: self.cpu_wait_batch.snapshot(),
            },
            cpu_hold: LaneHistogramsSnapshot {
                query: self.cpu_hold_query.snapshot(),
                batch: self.cpu_hold_batch.snapshot(),
            },
            inference: LaneHistogramsSnapshot {
                query: self.inference_query.snapshot(),
                batch: self.inference_batch.snapshot(),
            },
            cpu_wait_outcome: WaitOutcomeSnapshot {
                query: load_counters(&self.query_wait_outcome),
                batch: load_counters(&self.batch_wait_outcome),
            },
            queue_full: load_counters(&self.queue_full),
            poll_outcome: load_counters(&self.poll_outcome),
            batch_items_embedded: self.batch_items_embedded.load(Ordering::Relaxed),
            free_cpu_permits: self.cpu.available_permits(),
            free_query_permits: self.query_admission.available_permits(),
            jobs_active: depth.jobs_active,
            jobs_retained: depth.jobs_retained,
            queued_text_bytes: depth.queued_text_bytes,
            retained_result_bytes: depth.retained_result_bytes,
        }
    }
}

fn load_counters<const N: usize>(counters: &[AtomicU64; N]) -> [u64; N] {
    std::array::from_fn(|index| counters[index].load(Ordering::Relaxed))
}

fn saturating_add(counter: &AtomicU64, increment: u64) {
    let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        Some(value.saturating_add(increment))
    });
}

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

impl SynapseLimits {
    /// The most items one result page can attainably hold: a job never
    /// holds more than `max_batch_items` items so no page can either, and
    /// the pager always places at least one item per page. Shared by the
    /// runtime page reservation and its startup validation so the two
    /// cannot drift apart.
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
    jobs: Arc<JobTable>,
    /// One permit: at most one native inference call runs at a time, and
    /// waiters are served FIFO.
    cpu: Arc<tokio::sync::Semaphore>,
    /// At most one query may wait for or use the serialized CPU lane. Batch
    /// work is bounded separately by the job table.
    query_admission: Arc<tokio::sync::Semaphore>,
    metrics: Arc<SynapseMetrics>,
    /// Owns every started native call through shutdown.
    tracker: TaskTracker,
    /// Cancels queued (not yet started) work and closes admission.
    closing: CancellationToken,
}

impl SynapseInner {
    fn new(config: Option<SynapseConfig>, limits: SynapseLimits, state: LaneState) -> Self {
        let cpu = Arc::new(tokio::sync::Semaphore::new(1));
        let query_admission = Arc::new(tokio::sync::Semaphore::new(1));
        let jobs = Arc::new(JobTable::new(limits.clone()));
        let metrics = Arc::new(SynapseMetrics::new(
            Arc::clone(&cpu),
            Arc::clone(&query_admission),
            Arc::clone(&jobs),
        ));
        Self {
            config,
            limits,
            state: Mutex::new(state),
            jobs,
            cpu,
            query_admission,
            metrics,
            tracker: TaskTracker::new(),
            closing: CancellationToken::new(),
        }
    }
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
            inner: Arc::new(SynapseInner::new(
                config,
                limits,
                LaneState::Disabled {
                    reason: "not initialized".to_owned(),
                },
            )),
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
            inner: Arc::new(SynapseInner::new(
                None,
                limits,
                LaneState::Ready(Arc::new(ReadyLane {
                    backend: engine,
                    lane,
                })),
            )),
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

    pub fn metrics(&self) -> SynapseMetricsSnapshot {
        self.inner.metrics.snapshot()
    }

    pub fn metrics_handle(&self) -> Arc<SynapseMetrics> {
        Arc::clone(&self.inner.metrics)
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
            // A worker that exits without publishing is a host task
            // failure, not a lane fault: the bundle is fine and every other
            // job on this lane still works. `artifact_invalid` would be read
            // as a permanent lane fault and take the whole component down
            // with it, so this stays the host-generic task-failure code
            // (protocol §7.4) that leaves the lane serving.
            self.inner.jobs.publish_failed(
                self.seq,
                "internal_error".to_owned(),
                "batch worker exited before publication".to_owned(),
            );
        }
    }
}

const RESPONSE_SCRATCH_BYTES: usize = 256;

/// Shrinks a resident charge to the size actually owned and verifies the
/// reservation dominated it. `ByteCharge::shrink_to` cannot grow a charge
/// and `split_or_take` falls back to "take what is left" rather than
/// erroring, so proceeding with a short charge would silently under-charge
/// the request — the bug class the resident budget exists to close. After
/// `shrink_to(owned)` the charge holds `min(reserved, owned)`, so holding
/// fewer than `owned` bytes proves the reservation formula no longer
/// dominates real usage: loud in debug builds, a `queue_full` rejection
/// (no state created) in release builds.
fn shrink_covered(charge: &mut crate::wire::ByteCharge, owned: usize) -> bool {
    charge.shrink_to(owned);
    if charge.bytes() < owned {
        debug_assert!(
            false,
            "resident reservation ({} bytes) is smaller than the owned bytes ({owned})",
            charge.bytes(),
        );
        return false;
    }
    true
}

/// Post-decode resident bytes the handler still owns for one decoded
/// request: the strings moved out of the borrowed parse, plus the scratch a
/// response body needs while the charge is held. This is the single source
/// for both the runtime coverage gate in `handle` and the
/// reservation-dominance test, so a term added here is covered by both at
/// once and the two can never drift apart.
pub(crate) fn owned_input_bytes(request: &Request) -> usize {
    let owned = match request {
        // Answered from lane info; the charge is released before responding.
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

fn queue_full(metrics: &SynapseMetrics, reason: QueueFullReason, message: &str) -> RequestOutcome {
    metrics.increment_queue_full(reason);
    RequestOutcome::Error {
        code: "queue_full".to_owned(),
        message: message.to_owned(),
    }
}

fn poll_metric_outcome(outcome: &PollOutcome) -> PollMetricOutcome {
    match outcome {
        PollOutcome::Restarted => PollMetricOutcome::Restarted,
        PollOutcome::KeyMismatch => PollMetricOutcome::KeyMismatch,
        PollOutcome::BadCursor => PollMetricOutcome::BadCursor,
        PollOutcome::Failed { .. } => PollMetricOutcome::Failed,
        PollOutcome::Pending { status: "queued" } => PollMetricOutcome::PendingQueued,
        PollOutcome::Pending { status: "running" } => PollMetricOutcome::PendingRunning,
        PollOutcome::Pending { status } => unreachable!("unknown pending job status: {status}"),
        PollOutcome::Page(_) => PollMetricOutcome::Page,
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
            return queue_full(
                &self.inner.metrics,
                QueueFullReason::QueryAdmission,
                "query admission capacity is exhausted",
            );
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
        let wait_started = Instant::now();
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
                    inner.metrics.increment_query_wait_outcome(
                        QueryWaitOutcome::CancelledOrClosed,
                    );
                    let _ = tx.send(Err(QueryFault::Cancelled));
                    return;
                }
                // A waiter that is already gone (route loss, deadline) can
                // still be honored with zero native work while the call is
                // only queued; once the permit is held the call runs to
                // completion regardless.
                () = tx.closed() => {
                    inner
                        .metrics
                        .increment_query_wait_outcome(QueryWaitOutcome::WaiterGone);
                    return;
                }
                () = tokio::time::sleep_until(deadline) => {
                    inner
                        .metrics
                        .increment_query_wait_outcome(QueryWaitOutcome::Timeout);
                    let _ = tx.send(Err(QueryFault::Timeout));
                    return;
                }
                permit = Arc::clone(&inner.cpu).acquire_owned() => permit,
            };
            let Ok(_permit) = permit else {
                inner
                    .metrics
                    .increment_query_wait_outcome(QueryWaitOutcome::CancelledOrClosed);
                let _ = tx.send(Err(QueryFault::Engine(InferenceError::Invariant(
                    "cpu semaphore closed".to_owned(),
                ))));
                return;
            };
            let hold_started = Instant::now();
            inner
                .metrics
                .increment_query_wait_outcome(QueryWaitOutcome::Granted);
            inner.metrics.record_cpu_wait_query(wait_started.elapsed());
            // Serialized queries queue behind one another, so a predecessor's
            // invariant failure can condemn the lane while this call waits.
            // The lane is already marked, so this reports the existing fault
            // rather than declaring a new one.
            if let Some(reason) = lane_failure_reason(&inner) {
                let _ = tx.send(Err(QueryFault::Engine(InferenceError::Artifact(reason))));
                inner.metrics.record_cpu_hold_query(hold_started.elapsed());
                return;
            }
            let lane_blocking = Arc::clone(&lane_task);
            let metrics = Arc::clone(&inner.metrics);
            let joined = tokio::task::spawn_blocking(move || {
                let inference_started = Instant::now();
                let result = lane_blocking.backend.embed(&[text.as_str()]);
                metrics.record_inference_query(inference_started.elapsed());
                result
            })
            .await;
            let result = settle_inference(&inner, joined).map_err(QueryFault::Engine);
            let _ = tx.send(result);
            inner.metrics.record_cpu_hold_query(hold_started.elapsed());
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
            AdmitOutcome::Full => queue_full(
                &self.inner.metrics,
                QueueFullReason::JobAdmission,
                "job admission capacity is exhausted",
            ),
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
        let wait_started = Instant::now();
        self.inner.tracker.spawn(async move {
            let permit = tokio::select! {
                biased;
                // A queued wrapper is cancellable; a started native call is
                // not. close_admission already dropped the queued job.
                () = inner.closing.cancelled() => {
                    inner
                        .metrics
                        .increment_batch_wait_outcome(BatchWaitOutcome::Cancelled);
                    return;
                }
                permit = Arc::clone(&inner.cpu).acquire_owned() => permit,
            };
            let Ok(_permit) = permit else {
                inner
                    .metrics
                    .increment_batch_wait_outcome(BatchWaitOutcome::Closed);
                return;
            };
            let hold_started = Instant::now();
            inner
                .metrics
                .increment_batch_wait_outcome(BatchWaitOutcome::Granted);
            inner.metrics.record_cpu_wait_batch(wait_started.elapsed());
            // A queued batch inherits the same hazard as a queued query: the
            // lane can be condemned while this worker waits for the permit,
            // and the job fails against the existing reason instead of
            // running the suspect backend.
            if let Some(reason) = lane_failure_reason(&inner) {
                inner
                    .jobs
                    .publish_failed(seq, "artifact_invalid".to_owned(), reason);
                inner.metrics.record_cpu_hold_batch(hold_started.elapsed());
                return;
            }
            let Some(items) = inner.jobs.start(seq) else {
                inner.metrics.record_cpu_hold_batch(hold_started.elapsed());
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
            let metrics = Arc::clone(&inner.metrics);
            let joined = tokio::task::spawn_blocking(move || {
                let texts: Vec<&str> = items.iter().map(|item| item.text.as_str()).collect();
                metrics.add_batch_items_embedded(texts.len());
                let inference_started = Instant::now();
                let result = lane_blocking.backend.embed(&texts);
                metrics.record_inference_batch(inference_started.elapsed());
                result
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
            inner.metrics.record_cpu_hold_batch(hold_started.elapsed());
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
        // The ready-page branch clones every page item's id and hash out of
        // the job table, and those copies live until the response encoder
        // finishes. Their worst case is reserved before polling and shrunk
        // to the real page after, mirroring the parse-reservation pattern;
        // `page_item_bound` keeps this reservation and its startup
        // validation on one formula.
        let page_meta_bound = self
            .inner
            .limits
            .page_item_bound()
            .saturating_mul(jobs::MAX_ITEM_ID_BYTES + jobs::CONTENT_SHA256_BYTES);
        // Reserve first, sweep only if that fails — the same fallback the
        // parse reservation uses. Retained job charges live in this pool,
        // so expired jobs can starve this second reservation while the
        // smaller parse reservation keeps succeeding, and the sweep sites
        // behind `poll` are never reached from here.
        let reserved = match ctx.try_reserve_resident(page_meta_bound) {
            Some(charge) => Some(charge),
            None => {
                self.inner.jobs.sweep();
                ctx.try_reserve_resident(page_meta_bound)
            }
        };
        let Some(mut meta_charge) = reserved else {
            return queue_full(
                &self.inner.metrics,
                QueueFullReason::ResultPageResident,
                "resident capacity for the result page is exhausted",
            );
        };
        let poll = self
            .inner
            .jobs
            .poll(&job_id, &request_key, cursor.as_deref());
        self.inner
            .metrics
            .increment_poll_outcome(poll_metric_outcome(&poll));
        match poll {
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
                // Ids are validated to MAX_ITEM_ID_BYTES, hashes are fixed
                // 64-hex, and a page holds at most max_page_vectors items,
                // so the bound covers the clones by construction. Checked at
                // runtime through the same gate as the parse reservation: a
                // bound that stops dominating must reject, not silently
                // under-charge, in release builds too.
                let meta_bytes: usize = page
                    .vectors
                    .iter()
                    .map(|(id, hash, _)| id.len() + hash.len())
                    .sum();
                if !shrink_covered(&mut meta_charge, meta_bytes) {
                    return queue_full(
                        &self.inner.metrics,
                        QueueFullReason::CoverageShort,
                        "the result page reservation did not cover its metadata",
                    );
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
            return queue_full(
                &self.inner.metrics,
                QueueFullReason::ParseReservationUnsatisfiable,
                "the parse reservation bound is unsatisfiable",
            );
        };
        // The scratch pool funds only the parse reservation — the body's own
        // charge lives in the ingress pool, held since frame admission — so
        // the reservation alone is measured against this ceiling. When it
        // exceeds the ceiling no amount of draining can ever admit this
        // body, and reporting the permanent condition as `queue_full` would
        // have clients retry it forever — so it is a size rejection instead.
        let capacity = ctx.resident_capacity();
        if reservation_bytes > capacity {
            return request_error(protocol::unservable_body_error(
                ctx.body.len(),
                reservation_bytes,
                capacity,
            ));
        }
        // Reserve first, sweep only if that fails. Expired retained charges
        // must never be able to wedge the pool, and every other sweep site
        // runs after the reservation, so a failed reservation is the one
        // place obliged to force a pass — which keeps the job-table lock and
        // its expiry scan off every successful request.
        let reserved = match ctx.try_reserve_resident(reservation_bytes) {
            Some(charge) => Some(charge),
            None => {
                self.inner.jobs.sweep();
                ctx.try_reserve_resident(reservation_bytes)
            }
        };
        let Some(mut charge) = reserved else {
            return queue_full(
                &self.inner.metrics,
                QueueFullReason::ParseResidentExhausted,
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
        // One coverage gate for every arm, sized by the single owned-bytes
        // source so no arm can grow a term the reservation does not cover.
        if !shrink_covered(&mut charge, owned_input_bytes(&request)) {
            return queue_full(
                &self.inner.metrics,
                QueueFullReason::CoverageShort,
                "the parse reservation did not cover the decoded request",
            );
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
        // Probe serialization allocates by design; request paths read the
        // fixed-cardinality snapshot directly and remain allocation-free.
        let metrics = Some(serde_json::to_value(self.metrics()).expect("metrics serialize"));
        let (status, detail) = match self.status() {
            SynapseStatus::Ready(_) => (HealthStatus::Ok, None),
            SynapseStatus::Disabled { reason } => (HealthStatus::Degraded, Some(reason)),
            SynapseStatus::Failing { reason } => (HealthStatus::Failing, Some(reason)),
        };
        HealthReport {
            status,
            detail,
            metrics,
        }
    }

    /// Ordered drain: admission closes and queued wrappers cancel first,
    /// then every started native call is joined through the incarnation
    /// tracker, and only then is retained state released. Never aborts a
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    struct TestEngine;

    impl EmbeddingEngine for TestEngine {
        fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, InferenceError> {
            Ok(vec![vec![0.0]; texts.len()])
        }
    }

    fn test_lane() -> LaneInfo {
        LaneInfo {
            model: "test".to_owned(),
            fingerprint: "test".to_owned(),
            table_epoch: 1,
            dims: 1,
            max_tokens: 1,
            max_text_bytes: 1,
            provenance: serde_json::json!({}),
            recommended_rows: 1,
            recommended_token_budget: 1,
        }
    }

    fn assert_zero_metrics(snapshot: &SynapseMetricsSnapshot) {
        for histogram in [
            snapshot.cpu_wait.query,
            snapshot.cpu_wait.batch,
            snapshot.cpu_hold.query,
            snapshot.cpu_hold.batch,
            snapshot.inference.query,
            snapshot.inference.batch,
        ] {
            assert_eq!(histogram.count, 0);
            assert_eq!(histogram.sum_us, 0);
            assert_eq!(histogram.buckets, [0; HISTOGRAM_BUCKETS]);
        }
        assert_eq!(snapshot.cpu_wait_outcome.query, [0; QUERY_WAIT_OUTCOMES]);
        assert_eq!(snapshot.cpu_wait_outcome.batch, [0; BATCH_WAIT_OUTCOMES]);
        assert_eq!(snapshot.queue_full, [0; QUEUE_FULL_REASONS]);
        assert_eq!(snapshot.poll_outcome, [0; POLL_OUTCOMES]);
        assert_eq!(snapshot.batch_items_embedded, 0);
        assert_eq!(snapshot.free_cpu_permits, 1);
        assert_eq!(snapshot.free_query_permits, 1);
        assert_eq!(snapshot.jobs_active, 0);
        assert_eq!(snapshot.jobs_retained, 0);
        assert_eq!(snapshot.queued_text_bytes, 0);
        assert_eq!(snapshot.retained_result_bytes, 0);
    }

    fn metric_key_paths(value: &serde_json::Value) -> BTreeSet<String> {
        fn visit(value: &serde_json::Value, prefix: &str, paths: &mut BTreeSet<String>) {
            match value {
                serde_json::Value::Object(map) => {
                    for (key, value) in map {
                        let path = if prefix.is_empty() {
                            key.clone()
                        } else {
                            format!("{prefix}.{key}")
                        };
                        visit(value, &path, paths);
                    }
                }
                serde_json::Value::Array(values) => {
                    assert!(values.iter().all(serde_json::Value::is_u64));
                    paths.insert(prefix.to_owned());
                }
                serde_json::Value::Number(_) => {
                    paths.insert(prefix.to_owned());
                }
                other => panic!("metrics contain a non-numeric value: {other}"),
            }
        }

        let mut paths = BTreeSet::new();
        visit(value, "", &mut paths);
        paths
    }

    fn assert_health_metrics(report: &HealthReport) {
        let metrics = report.metrics.as_ref().expect("health metrics");
        let expected: BTreeSet<String> = [
            "batch_items_embedded",
            "cpu_hold.batch.buckets",
            "cpu_hold.batch.count",
            "cpu_hold.batch.sum_us",
            "cpu_hold.query.buckets",
            "cpu_hold.query.count",
            "cpu_hold.query.sum_us",
            "cpu_wait.batch.buckets",
            "cpu_wait.batch.count",
            "cpu_wait.batch.sum_us",
            "cpu_wait.query.buckets",
            "cpu_wait.query.count",
            "cpu_wait.query.sum_us",
            "cpu_wait_outcome.batch",
            "cpu_wait_outcome.query",
            "free_cpu_permits",
            "free_query_permits",
            "inference.batch.buckets",
            "inference.batch.count",
            "inference.batch.sum_us",
            "inference.query.buckets",
            "inference.query.count",
            "inference.query.sum_us",
            "jobs_active",
            "jobs_retained",
            "poll_outcome",
            "queue_full",
            "queued_text_bytes",
            "retained_result_bytes",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        assert_eq!(metric_key_paths(metrics), expected);
    }

    #[test]
    fn metrics_histogram_places_every_boundary_and_overflow() {
        let histogram = Histogram::default();
        let mut observations = vec![Duration::ZERO];
        observations.extend(HISTOGRAM_EDGES_MS.map(Duration::from_millis));
        observations.push(Duration::from_millis(5_001));

        for duration in &observations {
            histogram.record(*duration);
        }

        let snapshot = histogram.snapshot();
        assert_eq!(snapshot.count, observations.len() as u64);
        assert_eq!(snapshot.count, snapshot.buckets.iter().sum::<u64>());
        assert_eq!(snapshot.buckets[0], 1);
        assert!(snapshot.buckets[1..12].iter().all(|count| *count == 1));
        assert_eq!(snapshot.buckets[12], 2);
        assert_eq!(
            snapshot.sum_us,
            observations
                .iter()
                .map(|duration| duration.as_micros() as u64)
                .sum::<u64>()
        );
    }

    #[test]
    fn poll_metric_outcome_maps_every_job_table_outcome() {
        let cases = [
            (PollOutcome::Restarted, PollMetricOutcome::Restarted),
            (PollOutcome::KeyMismatch, PollMetricOutcome::KeyMismatch),
            (PollOutcome::BadCursor, PollMetricOutcome::BadCursor),
            (
                PollOutcome::Failed {
                    code: "artifact_invalid".to_owned(),
                    message: "model lane failed".to_owned(),
                },
                PollMetricOutcome::Failed,
            ),
            (
                PollOutcome::Pending { status: "queued" },
                PollMetricOutcome::PendingQueued,
            ),
            (
                PollOutcome::Pending { status: "running" },
                PollMetricOutcome::PendingRunning,
            ),
            (
                PollOutcome::Page(jobs::ResultPage {
                    vectors: vec![(
                        "item-0".to_owned(),
                        "0".repeat(jobs::CONTENT_SHA256_BYTES),
                        Arc::<[f32]>::from(vec![1.0]),
                    )],
                    done: true,
                    next_cursor: None,
                }),
                PollMetricOutcome::Page,
            ),
        ];

        for (outcome, expected) in cases {
            assert_eq!(poll_metric_outcome(&outcome), expected);
        }
    }

    #[test]
    fn metrics_histogram_sum_saturates() {
        let histogram = Histogram::default();
        histogram.sum_us.store(u64::MAX - 1, Ordering::Relaxed);
        histogram.record(Duration::from_micros(2));
        assert_eq!(histogram.snapshot().sum_us, u64::MAX);
    }

    #[test]
    fn metrics_snapshot_deltas_match_recordings() {
        let component = SynapseComponent::new(None);
        let before = component.metrics();
        let metrics = component.metrics_handle();

        metrics.record_cpu_wait_query(Duration::from_millis(50));
        metrics.increment_query_wait_outcome(QueryWaitOutcome::Granted);
        metrics.increment_batch_wait_outcome(BatchWaitOutcome::Cancelled);
        metrics.increment_queue_full(QueueFullReason::CoverageShort);
        metrics.increment_poll_outcome(PollMetricOutcome::PendingRunning);
        metrics.add_batch_items_embedded(3);

        let after = metrics.snapshot();
        assert_eq!(after.cpu_wait.query.count - before.cpu_wait.query.count, 1);
        assert_eq!(
            after.cpu_wait.query.sum_us - before.cpu_wait.query.sum_us,
            50_000
        );
        assert_eq!(
            after.cpu_wait.query.buckets[6] - before.cpu_wait.query.buckets[6],
            1
        );
        assert_eq!(
            after.cpu_wait_outcome.query[QueryWaitOutcome::Granted.slot()],
            1
        );
        assert_eq!(
            after.cpu_wait_outcome.batch[BatchWaitOutcome::Cancelled.slot()],
            1
        );
        assert_eq!(after.queue_full[QueueFullReason::CoverageShort.slot()], 1);
        assert_eq!(
            after.poll_outcome[PollMetricOutcome::PendingRunning.slot()],
            1
        );
        assert_eq!(after.batch_items_embedded - before.batch_items_embedded, 3);
    }

    #[test]
    fn metrics_start_zero_from_both_constructors() {
        assert_zero_metrics(&SynapseComponent::new(None).metrics());
        assert_zero_metrics(
            &SynapseComponent::ready_with_engine(
                test_lane(),
                Arc::new(TestEngine),
                SynapseLimits::default(),
            )
            .metrics(),
        );
    }

    #[tokio::test]
    async fn health_attaches_stable_numeric_metrics_on_every_lane_state() {
        let disabled = SynapseComponent::new(None);
        let report = disabled.health().await;
        assert_eq!(report.status, HealthStatus::Degraded);
        assert_health_metrics(&report);

        let ready = SynapseComponent::ready_with_engine(
            test_lane(),
            Arc::new(TestEngine),
            SynapseLimits::default(),
        );
        let report = ready.health().await;
        assert_eq!(report.status, HealthStatus::Ok);
        assert_health_metrics(&report);

        mark_failing(&ready.inner, "test failure".to_owned());
        let report = ready.health().await;
        assert_eq!(report.status, HealthStatus::Failing);
        assert_health_metrics(&report);
    }
}
