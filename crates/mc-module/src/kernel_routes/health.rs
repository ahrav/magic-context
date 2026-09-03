//! Kernel health projection: a sampler task reads `KernelStore::facts` on a
//! timer and publishes one immutable snapshot; `health()` loads the snapshot
//! and never touches the store.

use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwap;
use mc_kernel::{KernelFacts, KernelStore, MAIN_FILE_WARN_BYTES};
use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::serving::lag_threshold_tripped;
use super::{KernelOpenCoordinator, KernelState, UnavailableReason};

pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(30);
pub const SAMPLE_RETRY_INTERVAL: Duration = Duration::from_secs(5);

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
}

/// Published projection the sampler writes and `health()` reads.
pub(crate) struct KernelHealthProjection {
    snapshot: ArcSwap<KernelHealthBlock>,
}

impl KernelHealthProjection {
    pub(crate) fn new() -> Self {
        Self {
            snapshot: ArcSwap::from_pointee(KernelHealthBlock {
                kernel_state: KernelState::Starting,
                unavailable_reason: None,
                sampled_at_ms: None,
                facts: None,
            }),
        }
    }

    pub(crate) fn load(&self) -> Arc<KernelHealthBlock> {
        self.snapshot.load_full()
    }

    pub(crate) fn publish(&self, block: KernelHealthBlock) {
        self.snapshot.store(Arc::new(block));
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
        let sampled_at_ms = self.health.load().sampled_at_ms;
        self.health.publish(self.phase_block(sampled_at_ms));
    }

    pub(crate) async fn sample(&self, now_ms: i64) -> bool {
        let store = match self.kernel_store() {
            Ok(store) => store,
            Err(_) => {
                self.publish_phase();
                return false;
            }
        };
        let block = match sample_facts(store, now_ms).await {
            Ok(facts) => KernelHealthBlock::ready(now_ms, facts),
            Err(error) => {
                eprintln!("mc-module: kernel facts sample failed: {error:?}");
                KernelHealthBlock::sample_failed(now_ms)
            }
        };
        // The store may have been replaced while the worker ran; the phase wins.
        if self.state() != KernelState::Ready {
            self.publish_phase();
            return false;
        }
        let sampled = block.facts.is_some();
        self.health.publish(block);
        sampled
    }

    /// Cancellation drops the in-flight sample future so shutdown does not wait
    /// for the sample; the cancelled future publishes nothing.
    pub(crate) async fn run_sampler(self: Arc<Self>, cancel: CancellationToken) {
        loop {
            let sampled = tokio::select! {
                _ = cancel.cancelled() => return,
                sampled = self.sample(crate::now_ms()) => sampled,
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
}

async fn sample_facts(
    store: Arc<KernelStore>,
    now_ms: i64,
) -> Result<KernelFactsBlock, mc_kernel::KernelError> {
    tokio::task::spawn_blocking(move || {
        let facts = store.facts(now_ms)?;
        Ok(KernelFactsBlock::from_facts(&facts))
    })
    .await
    .unwrap_or_else(|error| panic!("kernel facts sampler worker failed: {error}"))
}

/// Live facts for the routed `status` method, which is not bound to the
/// lock-free health path and may read the store.
pub(crate) fn live_block(coordinator: &KernelOpenCoordinator, now_ms: i64) -> KernelHealthBlock {
    match coordinator.kernel_store() {
        Ok(store) => match store.facts(now_ms) {
            Ok(facts) => KernelHealthBlock::ready(now_ms, KernelFactsBlock::from_facts(&facts)),
            Err(_) => KernelHealthBlock::sample_failed(now_ms),
        },
        Err(_) => coordinator.phase_block(Some(now_ms)),
    }
}
