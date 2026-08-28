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
mod topology;

use std::path::PathBuf;
#[cfg(feature = "bench-topology")]
use std::sync::atomic::{AtomicU64, Ordering};
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
use topology::{Topology, WorkClass};

pub const SYNAPSE_MODULE_ID: &str = "synapse";

/// Finite host-owned capacities for the Synapse lane. Requests can never
/// select these; they live in trusted startup configuration only.
#[derive(Debug, Clone)]
pub struct SynapseLimits {
    /// Queries allowed to wait behind the one running query. Zero preserves
    /// loss-system admission: one query may run and every concurrent query is
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
    /// Maximum resident charge retained by one admitted query while it waits
    /// for or uses the CPU lane. JSON decoding may retain twice the decoded
    /// text length as `String` capacity, and the handler keeps response
    /// scratch until its terminal is encoded.
    pub fn per_waiter_charge_bound(&self) -> Option<u64> {
        u64::try_from(self.max_text_bytes)
            .ok()?
            .checked_mul(2)?
            .checked_add(RESPONSE_SCRATCH_BYTES as u64)
    }

    /// Semaphore permits for query admission: the one running query plus
    /// every allowed waiter. `None` when the count overflows or exceeds the
    /// semaphore's supported maximum. The single derivation of the permit
    /// rule; startup validation and both construction paths consume it.
    pub(crate) fn query_admission_permits(&self) -> Option<usize> {
        self.max_waiting_queries
            .checked_add(1)
            .filter(|permits| *permits <= tokio::sync::Semaphore::MAX_PERMITS)
    }

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
    #[cfg(feature = "bench-topology")]
    pub fn from_bundle(bundle: &bundle::VerifiedBundle) -> Self {
        Self::from_verified_bundle(bundle)
    }

    #[cfg(not(feature = "bench-topology"))]
    fn from_bundle(bundle: &bundle::VerifiedBundle) -> Self {
        Self::from_verified_bundle(bundle)
    }

    fn from_verified_bundle(bundle: &bundle::VerifiedBundle) -> Self {
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
    /// Post-publication activation has not settled the lane yet: bundle
    /// verification, ORT load, or model construction is still running.
    Starting,
    Disabled {
        reason: String,
    },
    Failing {
        reason: String,
    },
}

enum LaneState {
    Starting,
    Disabled { reason: String },
    Ready(Arc<ReadyLane>),
    Failing { reason: String },
}

struct SynapseInner {
    config: Option<SynapseConfig>,
    limits: SynapseLimits,
    state: Mutex<LaneState>,
    jobs: JobTable,
    topology: Topology,
    /// One running query plus at most `max_waiting_queries` waiters may use the
    /// serialized CPU lane. Admission is a non-blocking count: it decides
    /// whether a query may wait at all, never where in the queue it lands.
    /// Batch work is bounded separately by the job table.
    query_admission: Arc<tokio::sync::Semaphore>,
    /// Owns every started native call through shutdown.
    tracker: TaskTracker,
    /// Cancels queued (not yet started) work and closes admission.
    closing: CancellationToken,
    #[cfg(feature = "bench-topology")]
    observer: Option<Arc<SynapseObserver>>,
}

#[cfg(feature = "bench-topology")]
#[derive(Clone, Copy, Debug)]
pub enum BenchTopology {
    B0,
    T1 { intra_threads: usize },
    T2,
    T3 { chunk_rows: usize },
    T4 { permits: usize },
    T5 { permits: usize },
}

#[cfg(feature = "bench-topology")]
impl BenchTopology {
    fn validate(self) -> Result<Self, bundle::BundleError> {
        let valid = match self {
            Self::B0 | Self::T2 => true,
            Self::T1 { intra_threads } => intra_threads > 0,
            Self::T3 { chunk_rows } => chunk_rows > 0,
            Self::T4 { permits } | Self::T5 { permits } => permits > 0,
        };
        valid
            .then_some(self)
            .ok_or_else(|| bundle::BundleError("topology values must be nonzero".to_owned()))
    }
}

#[cfg(feature = "bench-topology")]
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct SynapseObserverSnapshot {
    pub query_queued: u64,
    pub query_queued_peak: u64,
    pub query_holding: u64,
    pub query_holding_peak: u64,
    pub batch_queued: u64,
    pub batch_queued_peak: u64,
    pub batch_holding: u64,
    pub batch_holding_peak: u64,
    pub drain_started_ns: Option<u64>,
    pub drain_completed_ns: Option<u64>,
}

#[cfg(feature = "bench-topology")]
pub struct SynapseObserver {
    origin: std::time::Instant,
    query_queued: AtomicU64,
    query_queued_peak: AtomicU64,
    query_holding: AtomicU64,
    query_holding_peak: AtomicU64,
    batch_queued: AtomicU64,
    batch_queued_peak: AtomicU64,
    batch_holding: AtomicU64,
    batch_holding_peak: AtomicU64,
    drain_started_ns: AtomicU64,
    drain_completed_ns: AtomicU64,
}

#[cfg(feature = "bench-topology")]
impl SynapseObserver {
    pub fn new() -> Self {
        Self {
            origin: std::time::Instant::now(),
            query_queued: AtomicU64::new(0),
            query_queued_peak: AtomicU64::new(0),
            query_holding: AtomicU64::new(0),
            query_holding_peak: AtomicU64::new(0),
            batch_queued: AtomicU64::new(0),
            batch_queued_peak: AtomicU64::new(0),
            batch_holding: AtomicU64::new(0),
            batch_holding_peak: AtomicU64::new(0),
            drain_started_ns: AtomicU64::new(0),
            drain_completed_ns: AtomicU64::new(0),
        }
    }

    pub fn snapshot(&self) -> SynapseObserverSnapshot {
        let optional = |value: &AtomicU64| match value.load(Ordering::Relaxed) {
            0 => None,
            value => Some(value - 1),
        };
        SynapseObserverSnapshot {
            query_queued: self.query_queued.load(Ordering::Relaxed),
            query_queued_peak: self.query_queued_peak.load(Ordering::Relaxed),
            query_holding: self.query_holding.load(Ordering::Relaxed),
            query_holding_peak: self.query_holding_peak.load(Ordering::Relaxed),
            batch_queued: self.batch_queued.load(Ordering::Relaxed),
            batch_queued_peak: self.batch_queued_peak.load(Ordering::Relaxed),
            batch_holding: self.batch_holding.load(Ordering::Relaxed),
            batch_holding_peak: self.batch_holding_peak.load(Ordering::Relaxed),
            drain_started_ns: optional(&self.drain_started_ns),
            drain_completed_ns: optional(&self.drain_completed_ns),
        }
    }

    fn timestamp(&self, target: &AtomicU64) {
        let elapsed = u64::try_from(self.origin.elapsed().as_nanos()).unwrap_or(u64::MAX);
        target.store(elapsed.saturating_add(1), Ordering::Relaxed);
    }
}

#[cfg(feature = "bench-topology")]
impl Default for SynapseObserver {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "bench-topology")]
#[derive(Clone, Copy)]
enum ObservedClass {
    Query,
    Batch,
}

#[cfg(feature = "bench-topology")]
struct ObservationGuard {
    observer: Option<Arc<SynapseObserver>>,
    class: ObservedClass,
    holding: bool,
}

#[cfg(feature = "bench-topology")]
impl ObservationGuard {
    fn queued(inner: &SynapseInner, class: ObservedClass) -> Self {
        let observer = inner.observer.clone();
        if let Some(observer) = &observer {
            let (current, peak) = match class {
                ObservedClass::Query => (&observer.query_queued, &observer.query_queued_peak),
                ObservedClass::Batch => (&observer.batch_queued, &observer.batch_queued_peak),
            };
            update_peak(peak, current.fetch_add(1, Ordering::Relaxed) + 1);
        }
        Self {
            observer,
            class,
            holding: false,
        }
    }

    fn hold(&mut self) {
        let Some(observer) = &self.observer else {
            return;
        };
        let (queued, holding, peak) = match self.class {
            ObservedClass::Query => (
                &observer.query_queued,
                &observer.query_holding,
                &observer.query_holding_peak,
            ),
            ObservedClass::Batch => (
                &observer.batch_queued,
                &observer.batch_holding,
                &observer.batch_holding_peak,
            ),
        };
        queued.fetch_sub(1, Ordering::Relaxed);
        update_peak(peak, holding.fetch_add(1, Ordering::Relaxed) + 1);
        self.holding = true;
    }

    fn requeue(&mut self) {
        let Some(observer) = &self.observer else {
            return;
        };
        let (queued, queued_peak, holding) = match self.class {
            ObservedClass::Query => (
                &observer.query_queued,
                &observer.query_queued_peak,
                &observer.query_holding,
            ),
            ObservedClass::Batch => (
                &observer.batch_queued,
                &observer.batch_queued_peak,
                &observer.batch_holding,
            ),
        };
        holding.fetch_sub(1, Ordering::Relaxed);
        update_peak(queued_peak, queued.fetch_add(1, Ordering::Relaxed) + 1);
        self.holding = false;
    }
}

#[cfg(feature = "bench-topology")]
impl Drop for ObservationGuard {
    fn drop(&mut self) {
        let Some(observer) = &self.observer else {
            return;
        };
        let counter = match (self.class, self.holding) {
            (ObservedClass::Query, false) => &observer.query_queued,
            (ObservedClass::Query, true) => &observer.query_holding,
            (ObservedClass::Batch, false) => &observer.batch_queued,
            (ObservedClass::Batch, true) => &observer.batch_holding,
        };
        counter.fetch_sub(1, Ordering::Relaxed);
    }
}

#[cfg(feature = "bench-topology")]
fn update_peak(peak: &AtomicU64, value: u64) {
    peak.fetch_max(value, Ordering::Relaxed);
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
        // Invalid configured limits fail `initialize` before any bundle
        // work. Keep construction non-panicking until that typed validation
        // can report the owner error.
        let query_admission_permits = limits.query_admission_permits().unwrap_or(1);
        Self {
            inner: Arc::new(SynapseInner {
                config,
                jobs: JobTable::new(limits.clone()),
                limits,
                state: Mutex::new(LaneState::Disabled {
                    reason: "not initialized".to_owned(),
                }),
                topology: Topology::production(),
                query_admission: Arc::new(tokio::sync::Semaphore::new(query_admission_permits)),
                tracker: TaskTracker::new(),
                closing: CancellationToken::new(),
                #[cfg(feature = "bench-topology")]
                observer: None,
            }),
        }
    }

    /// Test and example seam: a component whose lane is immediately ready
    /// over the supplied engine, bypassing bundle loading and ORT.
    ///
    /// # Errors
    ///
    /// Returns [`bundle::BundleError`] when the lane and serving limits cannot
    /// satisfy the same startup bounds enforced for a loaded bundle.
    pub fn ready_with_engine(
        mut lane: LaneInfo,
        engine: Arc<dyn EmbeddingEngine>,
        limits: SynapseLimits,
    ) -> Result<Self, bundle::BundleError> {
        bundle::validate_serving_limits(lane.dims, lane.recommended_rows as usize, &limits)?;
        // The validator's first check rejects limits whose permit count
        // overflows, so a validated configuration always has a count.
        let query_admission_permits = limits
            .query_admission_permits()
            .expect("validate_serving_limits proves the permit count");
        lane.max_text_bytes = limits.max_text_bytes;
        Ok(Self {
            inner: Arc::new(SynapseInner {
                config: None,
                jobs: JobTable::new(limits.clone()),
                limits,
                state: Mutex::new(LaneState::Ready(Arc::new(ReadyLane {
                    backend: engine,
                    lane,
                }))),
                topology: Topology::production(),
                query_admission: Arc::new(tokio::sync::Semaphore::new(query_admission_permits)),
                tracker: TaskTracker::new(),
                closing: CancellationToken::new(),
                #[cfg(feature = "bench-topology")]
                observer: None,
            }),
        })
    }

    #[cfg(feature = "bench-topology")]
    pub fn ready_with_engine_observed(
        lane: LaneInfo,
        engine: Arc<dyn EmbeddingEngine>,
        limits: SynapseLimits,
        observer: Arc<SynapseObserver>,
    ) -> Result<Self, bundle::BundleError> {
        Self::ready_with_engine_bench(lane, engine, limits, BenchTopology::B0, Some(observer))
    }

    #[cfg(feature = "bench-topology")]
    pub fn ready_with_engine_bench(
        mut lane: LaneInfo,
        engine: Arc<dyn EmbeddingEngine>,
        limits: SynapseLimits,
        topology: BenchTopology,
        observer: Option<Arc<SynapseObserver>>,
    ) -> Result<Self, bundle::BundleError> {
        bundle::validate_serving_limits(lane.dims, lane.recommended_rows as usize, &limits)?;
        let query_admission_permits = limits
            .query_admission_permits()
            .expect("validate_serving_limits proves the permit count");
        lane.max_text_bytes = limits.max_text_bytes;
        Ok(Self {
            inner: Arc::new(SynapseInner {
                config: None,
                jobs: JobTable::new(limits.clone()),
                limits,
                state: Mutex::new(LaneState::Ready(Arc::new(ReadyLane {
                    backend: engine,
                    lane,
                }))),
                topology: Topology::benchmark(topology.validate()?),
                query_admission: Arc::new(tokio::sync::Semaphore::new(query_admission_permits)),
                tracker: TaskTracker::new(),
                closing: CancellationToken::new(),
                observer,
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

    /// `Invariant` errors mark the lane failing before the error is
    /// returned, so no later caller can obtain a vector from a suspect
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

/// The reason the lane is no longer servable, or `None` while it is ready.
/// Callers hold an `Arc<ReadyLane>` captured at admission, which outlives the
/// state machine's verdict: the CPU permit can be granted after a predecessor
/// marked the lane failing, and running that captured backend anyway would
/// serve a vector from a suspect engine.
fn lane_failure_reason(inner: &SynapseInner) -> Option<String> {
    match &*inner.state.lock().expect("synapse state lock") {
        LaneState::Ready(_) => None,
        LaneState::Starting => Some(STARTING_REASON.to_owned()),
        LaneState::Disabled { reason } | LaneState::Failing { reason } => Some(reason.clone()),
    }
}

/// Bounded static reason reported while activation has not settled the lane.
const STARTING_REASON: &str = "the synapse lane is still starting";

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
    disposition: Option<AbandonDisposition>,
}

enum AbandonDisposition {
    InternalError,
    Cancelled,
}

impl AbandonGuard {
    fn cancelled(&mut self) {
        self.disposition = Some(AbandonDisposition::Cancelled);
    }

    fn disarm(&mut self) {
        self.disposition = None;
    }
}

impl Drop for AbandonGuard {
    fn drop(&mut self) {
        if let Some(disposition) = self.disposition.take() {
            // A worker that exits without publishing is a host task
            // failure, not a lane fault: the bundle is fine and every other
            // job on this lane still works. `artifact_invalid` would be read
            // as a permanent lane fault and take the whole component down
            // with it, so this stays the host-generic task-failure code
            // (protocol §7.4) that leaves the lane serving.
            let (code, message) = match disposition {
                AbandonDisposition::InternalError => {
                    ("internal_error", "batch worker exited before publication")
                }
                AbandonDisposition::Cancelled => ("cancelled", "the host is shutting down"),
            };
            self.inner
                .jobs
                .publish_failed(self.seq, code.to_owned(), message.to_owned());
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
    RequestOutcome::error(error.code, error.message)
}

fn app_error(code: &str, message: &str) -> RequestOutcome {
    RequestOutcome::error(code, message)
}

/// The expiry response for a query whose deadline has passed, attributed from
/// whatever verdict the worker managed to deliver.
///
/// A `Timeout` fault is the worker's own queued-deadline arm reporting that the
/// query never obtained the CPU permit; anything else — including a vector from
/// an engine call that completed after the deadline — means the query was
/// already running, and the result is discarded rather than returned. Both
/// escape paths from the deadline share this function so the two messages cannot
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
            return RequestOutcome::error_retry_after(
                "queue_full",
                "query admission capacity is exhausted",
                self.inner.limits.query_retry_after_ms,
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
        // The tracked task owns the native call; this handler future is only
        // the response waiter, so route loss or a deadline cancels waiting
        // without orphaning inference.
        self.inner.tracker.spawn(async move {
            #[cfg(feature = "bench-topology")]
            let mut observation = ObservationGuard::queued(&inner, ObservedClass::Query);
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
                permit = inner.topology.acquire(WorkClass::Query) => permit,
            };
            let Ok(_permit) = permit else {
                let fault = if inner.closing.is_cancelled() {
                    QueryFault::Cancelled
                } else {
                    QueryFault::Engine(InferenceError::Invariant(
                        "inference topology closed".to_owned(),
                    ))
                };
                let _ = tx.send(Err(fault));
                return;
            };
            #[cfg(feature = "bench-topology")]
            observation.hold();
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

        let mut rx = rx;
        let result = tokio::select! {
            biased;
            result = &mut rx => match result {
                Err(_) => return app_error("internal_error", "the inference task was lost"),
                Ok(result) => result,
            },
            () = tokio::time::sleep_until(deadline) => {
                // The worker's queued-deadline arm shares this exact instant,
                // and its verdict distinguishes a query that never started
                // from one still running. One yield lets that same-instant
                // verdict land before the expiry is attributed.
                tokio::task::yield_now().await;
                return expired_query(rx.try_recv().ok().as_ref());
            }
        };
        // The expired timer outranks a result that raced it, whichever arm
        // produced the value. `biased` polls the receiver first, so a handler
        // descheduled past its deadline resumes with both arms ready and never
        // polls the timer at all: without this check a vector sent after the
        // deadline is returned as a success, which is the same defect the
        // deadline arm above exists to prevent, reached by a different path.
        //
        // Cancellation is exempt because it is not a deadline event: the host
        // is shutting down, and that is the more actionable verdict for a
        // caller whose deadline happened to lapse at the same time.
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
            #[cfg(feature = "bench-topology")]
            let mut observation = ObservationGuard::queued(&inner, ObservedClass::Batch);
            let permit = tokio::select! {
                biased;
                // A queued wrapper is cancellable; a started native call is
                // not. close_admission already dropped the queued job.
                () = inner.closing.cancelled() => return,
                permit = inner.topology.acquire(WorkClass::Batch) => permit,
            };
            let Ok(mut permit) = permit else { return };
            #[cfg(feature = "bench-topology")]
            observation.hold();
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
            let Some(items) = inner
                .jobs
                .start_reserving(seq, inner.topology.reserve_result_at_start())
            else {
                return;
            };
            // `fail_job` is idempotent, so a normal publication wins even if
            // the guard also fires.
            let mut settle_guard = AbandonGuard {
                inner: Arc::clone(&inner),
                seq,
                disposition: Some(AbandonDisposition::InternalError),
            };
            let chunk_rows = inner.topology.chunk_rows().unwrap_or(items.len()).max(1);
            let mut vectors = Vec::with_capacity(items.len());
            for (index, chunk) in items.chunks(chunk_rows).enumerate() {
                if index != 0 {
                    #[cfg(feature = "bench-topology")]
                    observation.requeue();
                    drop(permit);
                    permit = tokio::select! {
                        biased;
                        () = inner.closing.cancelled() => {
                            settle_guard.cancelled();
                            return;
                        }
                        permit = inner.topology.acquire(WorkClass::Batch) => match permit {
                            Ok(permit) => permit,
                            Err(_) if inner.closing.is_cancelled() => {
                                settle_guard.cancelled();
                                return;
                            }
                            Err(_) => return,
                        },
                    };
                    #[cfg(feature = "bench-topology")]
                    observation.hold();
                    if let Some(reason) = lane_failure_reason(&inner) {
                        inner
                            .jobs
                            .publish_failed(seq, "artifact_invalid".to_owned(), reason);
                        settle_guard.disarm();
                        return;
                    }
                }
                let texts: Vec<String> = chunk.iter().map(|item| item.text.clone()).collect();
                let lane_blocking = Arc::clone(&lane);
                let joined = tokio::task::spawn_blocking(move || {
                    let texts: Vec<&str> = texts.iter().map(String::as_str).collect();
                    lane_blocking.backend.embed(&texts)
                })
                .await;
                match settle_inference(&inner, joined) {
                    Ok(chunk_vectors) => vectors.extend(chunk_vectors),
                    Err(InferenceError::Input(reason)) => {
                        inner
                            .jobs
                            .publish_failed(seq, "schema_violation".to_owned(), reason);
                        settle_guard.disarm();
                        return;
                    }
                    Err(InferenceError::Artifact(reason))
                    | Err(InferenceError::Invariant(reason)) => {
                        inner
                            .jobs
                            .publish_failed(seq, "artifact_invalid".to_owned(), reason);
                        settle_guard.disarm();
                        return;
                    }
                }
            }
            inner.jobs.publish_ready(seq, vectors);
            settle_guard.disarm();
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
        // A query holds its general handler task while it waits on the
        // admission semaphore, up to the request deadline, so the running
        // query plus every allowed waiter can sit parked concurrently.
        // Declaring the bound lets startup refuse a `max_waiting_queries`
        // that could park away every general handler-task slot.
        //
        // A component with no bundle configuration and no ready lane can
        // never reach the parking path: `bind` rejects every route and
        // `handle` answers `artifact_invalid` without touching admission,
        // and only `initialize` over a `SynapseConfig` can publish a lane.
        // Declaring a hold it cannot take would let a disabled lane fail
        // startup for a host that reserves exactly one general slot.
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
            // Retryable: the client's route-open backoff retries
            // `module_reloading`, so a demand that races activation settles
            // once the lane loads instead of failing terminally.
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
        // One coverage gate for every arm, sized by the single owned-bytes
        // source so no arm can grow a term the reservation does not cover.
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
            SynapseStatus::Ready(_) => HealthReport::ok(),
            SynapseStatus::Starting => HealthReport {
                status: HealthStatus::Degraded,
                detail: Some(STARTING_REASON.to_owned()),
                metrics: None,
            },
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
    async fn shutdown(&self) -> Result<(), crate::composite::ShutdownError> {
        #[cfg(feature = "bench-topology")]
        if let Some(observer) = &self.inner.observer {
            observer.timestamp(&observer.drain_started_ns);
        }
        self.inner.closing.cancel();
        self.inner.jobs.close_admission();
        self.inner.topology.close();
        self.inner.tracker.close();
        self.inner.tracker.wait().await;
        self.inner.jobs.clear();
        #[cfg(feature = "bench-topology")]
        if let Some(observer) = &self.inner.observer {
            observer.timestamp(&observer.drain_completed_ns);
        }
        Ok(())
    }
}

impl SecondaryComponent for SynapseComponent {
    async fn initialize(&self) -> Result<(), InitError> {
        let mut state = self.inner.state.lock().expect("synapse state lock");
        // A pre-readied lane (the test seam) has no configuration to load
        // and stays ready.
        if matches!(&*state, LaneState::Ready(_)) {
            return Ok(());
        }
        *state = if self.inner.config.is_some() {
            // Bundle verification, ORT load, and model construction are
            // post-publication activation work: transport must not wait
            // behind them, so pre-publication bootstrap only records that
            // the lane is still starting.
            LaneState::Starting
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
        // Limits are trusted operator startup configuration: an infeasible
        // combination is a config error the operator must see, not an
        // artifact fault, so it fails initialization instead of silently
        // disabling the lane while the host reports healthy.
        if let Err(error) = bundle::validate_limits(&config.limits) {
            return Err(InitError(format!("synapse limits are invalid: {error}")));
        }
        // Blocking work (file reads, hashing, native model construction,
        // probe inference) leaves the async lifecycle thread. Blocking tasks
        // detach on drop and cannot be stopped once running, so completion is
        // routed through the incarnation tracker: if this future is dropped
        // at the await (activation abandoned at shutdown), the tracked
        // wrapper still owns the closure's completion, and `shutdown`'s
        // tracker drain holds until the native load actually stops.
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
            // wrapper is the same activation failure as a lost closure.
            Err(join_error) => Err(join_error),
        };
        let mut state = self.inner.state.lock().expect("synapse state lock");
        match loaded {
            Ok(Ok(lane)) => {
                *state = LaneState::Ready(Arc::new(lane));
                Ok(())
            }
            // An expected artifact fault is isolated degradation, never a
            // host-fatal activation error.
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
