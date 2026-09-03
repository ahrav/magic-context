//! `kernel.eligibility.batch`: one verdict per candidate, computed from the
//! object registry, the bound project's scope, and artifact egress facts, and
//! cached per candidate for the store incarnation and tip it was computed at.

use std::collections::{HashMap, VecDeque};

use mc_host::RouteHandle;
use mc_kernel::{
    ArtifactDestination, ArtifactEligibility, ArtifactHandle, KernelError, KernelStore,
    ObjectState, Sensitivity,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::project::{ProjectBinding, ScopeFilter};
use super::{blocking, kernel_response, state_only, KernelOpenCoordinator, KernelOutcome};
use crate::dispatch::PreparedOutcome;
use crate::McHandler;

const OPERATION: &str = "kernel.eligibility.batch";
/// Entries held before the oldest is evicted.
const CACHE_CAPACITY: usize = 4096;
/// One batch is one registry read plus one `judge` per miss on the blocking
/// pool, so the candidate count bounds the work a single request can queue.
const MAX_CANDIDATES: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Ok,
    Retracted,
    Superseded,
    Stale,
    WrongScope,
    ProviderSensitive,
}

#[derive(Debug, Deserialize)]
struct BatchRequest {
    destination: String,
    candidates: Vec<Candidate>,
}

#[derive(Debug, Clone, Deserialize)]
struct Candidate {
    object_id: String,
    source_revision: i64,
    #[serde(default)]
    artifact_digest: Option<String>,
}

/// A verdict is a function of these inputs and nothing else, so an entry is
/// valid exactly as long as every part of its key still names the same state.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    lease_epoch: u64,
    tip: i64,
    object_id: String,
    source_revision: i64,
    artifact_digest: Option<String>,
    destination: ArtifactDestination,
    project_scope_id: String,
}

#[derive(Debug, Default)]
pub(crate) struct VerdictCache {
    entries: HashMap<CacheKey, Verdict>,
    order: VecDeque<CacheKey>,
}

impl VerdictCache {
    fn get(&self, key: &CacheKey) -> Option<Verdict> {
        self.entries.get(key).copied()
    }

    fn insert(&mut self, key: CacheKey, verdict: Verdict) {
        if self.entries.insert(key.clone(), verdict).is_some() {
            return;
        }
        self.order.push_back(key);
        while self.order.len() > CACHE_CAPACITY {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

fn parse_destination(value: &str) -> Option<ArtifactDestination> {
    match value {
        "local" => Some(ArtifactDestination::Local),
        "remote" => Some(ArtifactDestination::Remote),
        _ => None,
    }
}

/// Verdict order is fixed: an object that is gone or replaced is reported as
/// such before its revision, scope, or sensitivity is considered.
///
/// A secret object is refused for every destination and a non-normal object
/// for a remote one, whether or not the candidate cites an artifact.
fn judge(
    store: &KernelStore,
    filter: &mut ScopeFilter<'_>,
    candidate: &Candidate,
    state: Option<&ObjectState>,
    destination: ArtifactDestination,
) -> Result<Verdict, KernelError> {
    let Some(state) = state else {
        return Ok(Verdict::Retracted);
    };
    if state.object.superseded_by.is_some() {
        return Ok(Verdict::Superseded);
    }
    if state.object.invalidated_commit_seq.is_some() {
        return Ok(Verdict::Retracted);
    }
    if state.object.source_revision != candidate.source_revision {
        return Ok(Verdict::Stale);
    }
    if !filter.matches(state.scope_id.as_deref())? {
        return Ok(Verdict::WrongScope);
    }
    if state.object.sensitivity == Sensitivity::Secret
        || (destination == ArtifactDestination::Remote
            && state.object.sensitivity != Sensitivity::Normal)
    {
        return Ok(Verdict::ProviderSensitive);
    }
    if let Some(digest) = &candidate.artifact_digest {
        let handle = ArtifactHandle {
            digest: digest.clone(),
            evidence_id: String::new(),
        };
        match store.artifact_eligibility(&handle, destination) {
            Ok(ArtifactEligibility::Allowed) => {}
            Ok(ArtifactEligibility::Denied(_)) => return Ok(Verdict::ProviderSensitive),
            Err(error) => return Err(artifact_error(error)),
        }
    }
    Ok(Verdict::Ok)
}

/// Artifact errors reach the route through their kind; the outcome mapping
/// classifies the kind, so the kernel error chosen here only has to preserve
/// the busy-versus-invalid distinction that mapping needs.
fn artifact_error(error: mc_kernel::ArtifactError) -> KernelError {
    match KernelOutcome::from(error.kind()) {
        KernelOutcome::Unavailable {
            reason: super::UnavailableReason::StoreBusy,
        } => KernelError::Busy,
        KernelOutcome::Invalid { .. } => KernelError::InvalidInput,
        KernelOutcome::Available
        | KernelOutcome::Stale { .. }
        | KernelOutcome::Abstained { .. }
        | KernelOutcome::Unavailable { .. }
        | KernelOutcome::Conflict { .. } => KernelError::Io,
    }
}

struct BatchResponse {
    known_as_of: i64,
    verdicts: Vec<(String, Verdict)>,
    cache_hits: usize,
}

fn evaluate(
    store: &KernelStore,
    coordinator: &KernelOpenCoordinator,
    project: &ProjectBinding,
    destination: ArtifactDestination,
    candidates: &[Candidate],
) -> Result<BatchResponse, KernelError> {
    let object_ids: Vec<String> = candidates
        .iter()
        .map(|candidate| candidate.object_id.clone())
        .collect();
    let (tip, states) = store.object_states(&object_ids)?;
    let lease_epoch = store.lease_epoch();
    let project_scope_id = project.scope_id();
    let keys: Vec<CacheKey> = candidates
        .iter()
        .map(|candidate| CacheKey {
            lease_epoch,
            tip,
            object_id: candidate.object_id.clone(),
            source_revision: candidate.source_revision,
            artifact_digest: candidate.artifact_digest.clone(),
            destination,
            project_scope_id: project_scope_id.clone(),
        })
        .collect();
    // `judge` reads SQLite, so the cache guard is held only for the lookups
    // and then again for the inserts, never across a judgement.
    let cached: Vec<Option<Verdict>> = {
        let cache = coordinator.eligibility_cache();
        keys.iter().map(|key| cache.get(key)).collect()
    };
    let cache_hits = cached.iter().filter(|hit| hit.is_some()).count();
    let mut filter = ScopeFilter::new(project, store);
    let mut verdicts = Vec::with_capacity(candidates.len());
    let mut fresh: Vec<(CacheKey, Verdict)> = Vec::new();
    for ((candidate, state), (key, cached)) in candidates
        .iter()
        .zip(&states)
        .zip(keys.into_iter().zip(cached))
    {
        let verdict = match cached {
            Some(verdict) => verdict,
            None => {
                let verdict = judge(store, &mut filter, candidate, state.as_ref(), destination)?;
                fresh.push((key, verdict));
                verdict
            }
        };
        verdicts.push((candidate.object_id.clone(), verdict));
    }
    if !fresh.is_empty() {
        let mut cache = coordinator.eligibility_cache();
        for (key, verdict) in fresh {
            cache.insert(key, verdict);
        }
    }
    Ok(BatchResponse {
        known_as_of: tip,
        verdicts,
        cache_hits,
    })
}

impl McHandler {
    pub(crate) async fn handle_kernel_eligibility_batch(
        &self,
        channel: RouteHandle,
        request: &Value,
    ) -> PreparedOutcome {
        let scope = match self.kernel_route_scope(channel, request, OPERATION) {
            Ok(scope) => scope,
            Err(outcome) => return outcome,
        };
        let parsed = match serde_json::from_value::<BatchRequest>(request.clone()) {
            Ok(parsed) => parsed,
            Err(error) => {
                return crate::invalid_params_error(format!("invalid {OPERATION}: {error}"))
            }
        };
        let Some(destination) = parse_destination(&parsed.destination) else {
            return crate::invalid_params_error(format!(
                "{OPERATION} destination must be local or remote"
            ));
        };
        if parsed.candidates.len() > MAX_CANDIDATES {
            return crate::invalid_params_error(format!(
                "{OPERATION} carries at most {MAX_CANDIDATES} candidates"
            ));
        }
        let store = scope.store;
        let project = scope.project;
        let coordinator = self.kernel.clone();
        let candidates = parsed.candidates;
        let result =
            blocking(move || evaluate(&store, &coordinator, &project, destination, &candidates))
                .await;
        let response = match result {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return state_only(KernelOutcome::from(error)),
            Err(outcome) => return state_only(outcome),
        };
        let verdicts: Vec<Value> = response
            .verdicts
            .iter()
            .map(|(object_id, verdict)| json!({"object_id": object_id, "verdict": verdict}))
            .collect();
        kernel_response(
            &KernelOutcome::Available,
            json!({
                "known_as_of": response.known_as_of,
                "verdicts": verdicts,
                "cache_hits": response.cache_hits,
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(index: usize) -> CacheKey {
        CacheKey {
            lease_epoch: 1,
            tip: 1,
            object_id: format!("object-{index}"),
            source_revision: 1,
            artifact_digest: None,
            destination: ArtifactDestination::Local,
            project_scope_id: "project:x".to_string(),
        }
    }

    #[test]
    fn the_cache_is_bounded_and_evicts_its_oldest_entry_first() {
        let mut cache = VerdictCache::default();
        for index in 0..=CACHE_CAPACITY {
            cache.insert(key(index), Verdict::Ok);
        }
        assert_eq!(cache.len(), CACHE_CAPACITY);
        assert_eq!(cache.get(&key(0)), None);
        assert_eq!(cache.get(&key(CACHE_CAPACITY)), Some(Verdict::Ok));
        // Re-inserting an existing key replaces its verdict without growing the order.
        cache.insert(key(1), Verdict::Stale);
        assert_eq!(cache.get(&key(1)), Some(Verdict::Stale));
        assert_eq!(cache.order.len(), CACHE_CAPACITY);
        cache.clear();
        assert_eq!(cache.len(), 0);
    }
}
