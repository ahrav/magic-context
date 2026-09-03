//! Kernel health projection: a sampler task reads `KernelStore::facts` on a
//! timer and publishes one immutable snapshot; `health()` loads the snapshot
//! and never touches the store.

use std::sync::Arc;
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use mc_kernel::{KernelFacts, MAIN_FILE_WARN_BYTES};
use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::serving::lag_threshold_tripped;
use super::{KernelOpenCoordinator, KernelState, UnavailableReason};

pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(30);
pub const SAMPLE_RETRY_INTERVAL: Duration = Duration::from_secs(5);
/// A `Ready` block published longer ago than this reads as unavailable: ten
/// steady intervals leaves room for slow artifact walks while still exposing a
/// sampler that has stopped publishing. Measured on the monotonic clock, so a
/// wall-clock step neither hides nor fakes a stall.
pub const SAMPLE_STALE_AFTER: Duration = Duration::from_secs(300);

/// The `kernel` block under `metrics.components.magic-context.metrics`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KernelHealthBlock {
    pub kernel_state: KernelState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<UnavailableReason>,
    /// Milliseconds since the epoch when the facts were sampled; `None` until
    /// the first sample lands.
    pub sampled_at_ms: Option<i64>,
    #[serde(flatten)]
    pub facts: Option<KernelFactsBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KernelFactsBlock {
    pub core_file_bytes: u64,
    pub core_file_warn: bool,
    pub artifact_usage_bytes: u64,
    pub artifact_cap_bytes: u64,
    pub artifact_warn: bool,
    pub outbox_position_lag: Option<i64>,
    pub oldest_unconsumed_age_ms: Option<i64>,
    pub retained_outbox_rows: u64,
    pub required_consumer_count: u64,
    pub lag_threshold_tripped: bool,
}

impl KernelFactsBlock {
    /// Every lag field, including the threshold verdict, comes from the one
    /// outbox snapshot inside `facts`, so the displayed lag and the flag agree.
    pub fn from_facts(facts: &KernelFacts) -> Self {
        let lag = &facts.outbox_lag;
        Self {
            core_file_bytes: facts.main_file_bytes,
            core_file_warn: facts.main_file_bytes >= MAIN_FILE_WARN_BYTES,
            artifact_usage_bytes: facts.artifact_budget.usage_bytes,
            artifact_cap_bytes: facts.artifact_budget.cap_bytes,
            artifact_warn: facts.artifact_budget.warn,
            outbox_position_lag: lag.position_lag,
            oldest_unconsumed_age_ms: lag.oldest_unconsumed_age_ms,
            retained_outbox_rows: facts.retained_outbox_rows,
            required_consumer_count: lag.consumer_count,
            lag_threshold_tripped: lag_threshold_tripped(lag),
        }
    }
}

impl KernelHealthBlock {
    /// Whether this block alone downgrades the daemon's health status. An
    /// empty required-consumer set does not: it is reported as a readiness
    /// warning only.
    pub fn degrades_health(&self) -> bool {
        self.kernel_state != KernelState::Ready
            || self
                .facts
                .as_ref()
                .is_some_and(|facts| facts.lag_threshold_tripped)
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).expect("kernel health block serializes")
    }

    fn ready(sampled_at_ms: i64, facts: KernelFactsBlock) -> Self {
        Self {
            kernel_state: KernelState::Ready,
            unavailable_reason: None,
            sampled_at_ms: Some(sampled_at_ms),
            facts: Some(facts),
        }
    }

    /// Health must not read a failed sample as a healthy `Ready` store.
    fn sample_failed(sampled_at_ms: i64) -> Self {
        Self {
            kernel_state: KernelState::Unavailable,
            unavailable_reason: Some(UnavailableReason::StoreUnavailable),
            sampled_at_ms: Some(sampled_at_ms),
            facts: None,
        }
    }

    /// The block a reader reports in place of a stale `Ready` block: unavailable,
    /// with the stale sample time preserved so the age stays visible.
    pub fn stale(sampled_at_ms: Option<i64>) -> Self {
        Self {
            kernel_state: KernelState::Unavailable,
            unavailable_reason: Some(UnavailableReason::StoreUnavailable),
            sampled_at_ms,
            facts: None,
        }
    }
}

/// One published block plus the monotonic instant after which a `Ready` block
/// is stale.
pub(crate) struct PublishedBlock {
    pub(crate) block: KernelHealthBlock,
    stale_at: Instant,
}

impl PublishedBlock {
    fn now(block: KernelHealthBlock) -> Self {
        Self {
            block,
            stale_at: Instant::now() + SAMPLE_STALE_AFTER,
        }
    }

    pub(crate) fn is_stale(&self) -> bool {
        self.block.kernel_state == KernelState::Ready && Instant::now() >= self.stale_at
    }
}

/// Published projection the sampler writes and `health()` reads.
pub(crate) struct KernelHealthProjection {
    snapshot: ArcSwap<PublishedBlock>,
}

impl KernelHealthProjection {
    pub(crate) fn new() -> Self {
        Self {
            snapshot: ArcSwap::from_pointee(PublishedBlock::now(KernelHealthBlock {
                kernel_state: KernelState::Starting,
                unavailable_reason: None,
                sampled_at_ms: None,
                facts: None,
            })),
        }
    }

    pub(crate) fn load(&self) -> Arc<PublishedBlock> {
        self.snapshot.load_full()
    }

    pub(crate) fn publish(&self, block: KernelHealthBlock) {
        self.snapshot.store(Arc::new(PublishedBlock::now(block)));
    }

    /// Moves the current block's stale deadline to now.
    #[cfg(feature = "test-support")]
    pub(crate) fn expire(&self) {
        self.snapshot.rcu(|current| PublishedBlock {
            block: current.block.clone(),
            stale_at: Instant::now(),
        });
    }
}

impl KernelOpenCoordinator {
    /// Current phase without facts; the sampler fills the facts in.
    fn phase_block(&self, sampled_at_ms: Option<i64>) -> KernelHealthBlock {
        let state = self.state();
        KernelHealthBlock {
            kernel_state: state,
            unavailable_reason: (state == KernelState::Unavailable)
                .then(|| self.unavailable_reason()),
            sampled_at_ms,
            facts: None,
        }
    }

    /// Republishes the phase with no facts, for transitions that happen
    /// between samples such as open failure or shutdown.
    pub(crate) fn publish_phase(&self) {
        let sampled_at_ms = self.health.load().block.sampled_at_ms;
        self.health.publish(self.phase_block(sampled_at_ms));
    }

    /// `cancel` is checked by the blocking sampler so shutdown can stop an
    /// in-progress sample.
    pub(crate) async fn sample(&self, now_ms: i64, cancel: &CancellationToken) -> bool {
        let store = match self.kernel_store() {
            Ok(store) => store,
            Err(_) => {
                self.publish_phase();
                return false;
            }
        };
        let cancel = cancel.clone();
        let worker = tokio::task::spawn_blocking(move || {
            store
                .facts_unless(now_ms, &|| cancel.is_cancelled())
                .map(|facts| facts.as_ref().map(KernelFactsBlock::from_facts))
        });
        let block = match worker.await {
            Ok(Ok(Some(facts))) => KernelHealthBlock::ready(now_ms, facts),
            Ok(Ok(None)) => return false,
            Ok(Err(error)) => {
                eprintln!("mc-module: kernel facts sample failed: {error:?}");
                KernelHealthBlock::sample_failed(now_ms)
            }
            // A worker panic must not end the sampler; the next tick retries.
            Err(error) => {
                eprintln!("mc-module: kernel facts sampler worker failed: {error}");
                KernelHealthBlock::sample_failed(now_ms)
            }
        };
        let sampled = block.facts.is_some();
        // The store may have been replaced while the worker ran; the phase wins.
        self.publish_if_ready(block) && sampled
    }

    pub(crate) async fn run_sampler(self: Arc<Self>, cancel: CancellationToken) {
        loop {
            let sampled = tokio::select! {
                _ = cancel.cancelled() => return,
                sampled = self.sample(crate::now_ms(), &cancel) => sampled,
            };
            let interval = if sampled {
                SAMPLE_INTERVAL
            } else {
                SAMPLE_RETRY_INTERVAL
            };
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tokio::time::sleep(interval) => {}
            }
        }
    }

    /// Live facts for the routed `status` method, which is not bound to the
    /// lock-free health path and may read the store. The read runs on a
    /// blocking worker so the artifact walk never occupies a route worker, and
    /// `cancelled` reaches the walk so an abandoned request does not keep the
    /// store alive; a cancelled read answers unavailable.
    pub(crate) async fn live_block(
        &self,
        now_ms: i64,
        cancelled: impl Fn() -> bool + Send + 'static,
    ) -> KernelHealthBlock {
        let store = match self.kernel_store() {
            Ok(store) => store,
            Err(_) => return self.phase_block(Some(now_ms)),
        };
        let worker = tokio::task::spawn_blocking(move || store.facts_unless(now_ms, &cancelled));
        let outcome = worker.await;
        // The store may have been retired while the worker ran; the phase wins,
        // as it does for the sampler.
        if self.state() != KernelState::Ready {
            return self.phase_block(Some(now_ms));
        }
        match outcome {
            Ok(Ok(Some(facts))) => {
                KernelHealthBlock::ready(now_ms, KernelFactsBlock::from_facts(&facts))
            }
            Ok(Ok(None)) | Ok(Err(_)) | Err(_) => KernelHealthBlock::sample_failed(now_ms),
        }
    }
}
