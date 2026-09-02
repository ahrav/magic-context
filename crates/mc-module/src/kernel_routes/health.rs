//! Kernel health projection: a sampler task reads `KernelStore::facts` on a
//! timer and publishes one immutable snapshot; `health()` loads the snapshot
//! and never touches the store.

use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwap;
use mc_kernel::{KernelFacts, KernelStore, OutboxLag, MAIN_FILE_WARN_BYTES};
use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::serving::lag_threshold_tripped;
use super::{KernelOpenCoordinator, KernelState, UnavailableReason};

pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);

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
    pub fn from_facts(facts: &KernelFacts, lag: &OutboxLag) -> Self {
        Self {
            core_file_bytes: facts.main_file_bytes,
            core_file_warn: facts.main_file_bytes >= MAIN_FILE_WARN_BYTES,
            artifact_usage_bytes: facts.artifact_budget.usage_bytes,
            artifact_cap_bytes: facts.artifact_budget.cap_bytes,
            artifact_warn: facts.artifact_budget.warn,
            outbox_position_lag: facts.outbox_position_lag,
            oldest_unconsumed_age_ms: facts.oldest_unconsumed_age_ms,
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

    /// One sample: read facts and lag from the store on a blocking worker and
    /// publish. A store that has gone away between ticks publishes the phase.
    pub(crate) async fn sample(&self, now_ms: i64) {
        let store = match self.kernel_store() {
            Ok(store) => store,
            Err(_) => {
                self.publish_phase();
                return;
            }
        };
        let block = match sample_facts(store, now_ms).await {
            Ok(facts) => KernelHealthBlock {
                kernel_state: KernelState::Ready,
                unavailable_reason: None,
                sampled_at_ms: Some(now_ms),
                facts: Some(facts),
            },
            Err(error) => {
                eprintln!("mc-module: kernel facts sample failed: {error:?}");
                self.phase_block(Some(now_ms))
            }
        };
        // The store may have been replaced while the worker ran; the phase wins.
        if self.state() == KernelState::Ready {
            self.health.publish(block);
        } else {
            self.publish_phase();
        }
    }

    /// Samples every `SAMPLE_INTERVAL` until cancelled. Holds the store only for
    /// the duration of one sample, so a shutdown that clears the slot is not
    /// delayed by this task.
    pub(crate) async fn run_sampler(self: Arc<Self>, cancel: CancellationToken) {
        loop {
            self.sample(crate::now_ms()).await;
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tokio::time::sleep(SAMPLE_INTERVAL) => {}
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
        let lag = store.outbox_lag(now_ms)?;
        Ok(KernelFactsBlock::from_facts(&facts, &lag))
    })
    .await
    .unwrap_or_else(|error| panic!("kernel facts sampler worker failed: {error}"))
}

/// Live facts for the routed `status` method, which is not bound to the
/// lock-free health path and may read the store.
pub(crate) fn live_block(coordinator: &KernelOpenCoordinator, now_ms: i64) -> KernelHealthBlock {
    match coordinator.kernel_store() {
        Ok(store) => match (store.facts(now_ms), store.outbox_lag(now_ms)) {
            (Ok(facts), Ok(lag)) => KernelHealthBlock {
                kernel_state: KernelState::Ready,
                unavailable_reason: None,
                sampled_at_ms: Some(now_ms),
                facts: Some(KernelFactsBlock::from_facts(&facts, &lag)),
            },
            _ => coordinator.phase_block(Some(now_ms)),
        },
        Err(_) => coordinator.phase_block(Some(now_ms)),
    }
}
