//! The Synapse embedding component: an optional, certified, CPU-only local
//! model behind the `synapse/management_surface` target.
//!
//! Expected artifact faults (missing configuration, invalid bundle,
//! incompatible ONNX Runtime, failed certification) disable only this
//! component: its catalog identity stays published, its bind rejects with
//! `artifact_invalid`, and internal health reports degraded. Lifecycle
//! panics and invariant violations remain host-fatal through the composite.

pub mod bundle;
pub mod inference;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::composite::{CompositeComponent, SecondaryComponent};
use crate::handler::{
    BindOutcome, HealthReport, HealthStatus, InitError, ManifestSnapshot, RequestCtx,
    RequestOutcome, RouteHandle, RouteIdentity,
};
use bundle::BundleManifest;
use inference::{Backend, OrtIdentity};

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
    pub max_tokens: u64,
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
            max_tokens: manifest.max_tokens,
            provenance: manifest.provenance.clone(),
            recommended_rows: manifest.recommended_batch.rows,
            recommended_token_budget: manifest.recommended_batch.token_budget,
        }
    }
}

pub(crate) struct ReadyLane {
    pub backend: Backend,
    pub lane: LaneInfo,
}

#[derive(Debug, Clone)]
pub enum SynapseStatus {
    Ready(LaneInfo),
    Disabled { reason: String },
    Failing { reason: String },
}

pub(crate) enum LaneState {
    Disabled { reason: String },
    Ready(Arc<ReadyLane>),
    Failing { reason: String },
}

pub struct SynapseComponent {
    config: Option<SynapseConfig>,
    state: Mutex<LaneState>,
}

impl SynapseComponent {
    pub fn new(config: Option<SynapseConfig>) -> Self {
        Self {
            config,
            state: Mutex::new(LaneState::Disabled {
                reason: "not initialized".to_owned(),
            }),
        }
    }

    pub fn status(&self) -> SynapseStatus {
        match &*self.state.lock().expect("synapse state lock") {
            LaneState::Ready(lane) => SynapseStatus::Ready(lane.lane.clone()),
            LaneState::Disabled { reason } => SynapseStatus::Disabled {
                reason: reason.clone(),
            },
            LaneState::Failing { reason } => SynapseStatus::Failing {
                reason: reason.clone(),
            },
        }
    }

    /// `Invariant` errors mark the lane failing before `embed_blocking`
    /// returns, so no later caller can obtain a vector from a suspect
    /// backend.
    pub fn embed_blocking(
        &self,
        texts: &[&str],
    ) -> Result<Vec<Vec<f32>>, inference::InferenceError> {
        let lane = match self.lane_state() {
            LaneState::Ready(lane) => lane,
            LaneState::Disabled { reason } | LaneState::Failing { reason } => {
                return Err(inference::InferenceError::Artifact(reason));
            }
        };
        match lane.backend.embed(texts) {
            Ok(vectors) => Ok(vectors),
            Err(inference::InferenceError::Invariant(reason)) => {
                self.mark_failing(reason.clone());
                Err(inference::InferenceError::Invariant(reason))
            }
            Err(other) => Err(other),
        }
    }

    pub(crate) fn lane_state(&self) -> LaneState {
        match &*self.state.lock().expect("synapse state lock") {
            LaneState::Disabled { reason } => LaneState::Disabled {
                reason: reason.clone(),
            },
            LaneState::Ready(lane) => LaneState::Ready(Arc::clone(lane)),
            LaneState::Failing { reason } => LaneState::Failing {
                reason: reason.clone(),
            },
        }
    }

    /// A backend invariant failure poisons the lane: new work is refused
    /// and the suspect vector is never served.
    pub(crate) fn mark_failing(&self, reason: String) {
        let mut state = self.state.lock().expect("synapse state lock");
        if matches!(&*state, LaneState::Ready(_)) {
            *state = LaneState::Failing { reason };
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
        match self.lane_state() {
            LaneState::Ready(_) => BindOutcome::Accept,
            LaneState::Disabled { .. } | LaneState::Failing { .. } => BindOutcome::Reject {
                code: "artifact_invalid".to_owned(),
                message: "the synapse model bundle is unavailable".to_owned(),
            },
        }
    }

    async fn handle(&self, ctx: RequestCtx) -> RequestOutcome {
        drop(ctx);
        RequestOutcome::Error {
            code: "schema_violation".to_owned(),
            message: "the synapse application protocol is not wired yet".to_owned(),
        }
    }

    async fn route_gone(&self, _route: RouteHandle) {}

    async fn health(&self) -> HealthReport {
        match &*self.state.lock().expect("synapse state lock") {
            LaneState::Ready(_) => HealthReport::ok(),
            LaneState::Disabled { reason } => HealthReport {
                status: HealthStatus::Degraded,
                detail: Some(reason.clone()),
                metrics: None,
            },
            LaneState::Failing { reason } => HealthReport {
                status: HealthStatus::Failing,
                detail: Some(reason.clone()),
                metrics: None,
            },
        }
    }

    async fn shutdown(&self) {}
}

impl SecondaryComponent for SynapseComponent {
    async fn initialize(&self) -> Result<(), InitError> {
        let Some(config) = self.config.clone() else {
            *self.state.lock().expect("synapse state lock") = LaneState::Disabled {
                reason: "no bundle configured".to_owned(),
            };
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
                backend,
            })
        })
        .await;
        let mut state = self.state.lock().expect("synapse state lock");
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
