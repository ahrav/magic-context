//! `kernel.eligibility.batch`: one verdict per candidate, computed from the
//! object registry, the bound project's scope, and artifact egress facts, and
//! cached per candidate for the store incarnation and tip it was computed at.

use std::collections::{HashMap, VecDeque};

use mc_core::claim_operation::is_lower_hex;
use mc_host::RouteHandle;
use mc_kernel::{
    ArtifactDestination, ArtifactEligibility, EgressCandidate, KernelError, KernelStore,
    Sensitivity, SurfaceVisibility,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::project::{stored_terms, ProjectBinding, ScopeFilter};
use super::{blocking, kernel_response, state_only, KernelOpenCoordinator, KernelOutcome};
use crate::dispatch::PreparedOutcome;
use crate::McHandler;

const OPERATION: &str = "kernel.eligibility.batch";
/// Entries held before the oldest is evicted.
const CACHE_CAPACITY: usize = 4096;
/// Longest `object_id` a candidate may carry. Every candidate becomes a
/// cache key whether or not the object exists, so the id length is what
/// bounds the bytes an entry retains.
pub const MAX_OBJECT_ID_BYTES: usize = 512;
/// Bytes one entry may retain: the key's strings, held once in the map and
/// once in the eviction order, plus the fixed-size fields and node overhead.
const ENTRY_BYTES_MAX: u64 = 2 * (MAX_OBJECT_ID_BYTES as u64 + 64 + 128) + 256;
/// Resident bytes the verdict cache may hold at capacity.
pub const CACHE_BUDGET_BYTES: u64 = CACHE_CAPACITY as u64 * ENTRY_BYTES_MAX;
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
    /// The object is live but `kernel.read` hides it on every surface.
    Hidden,
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
/// The sensitivity judged is the one the serving view folds onto the object
/// from its admission history, since that is the class a read handed the
/// caller; an object no admission decision serves has an unknown class and is
/// refused for a remote destination. A secret object is refused for every
/// destination and a non-normal object for a remote one, whether or not the
/// candidate cites an artifact.
fn judge(
    store: &KernelStore,
    filter: &mut ScopeFilter,
    candidate: &Candidate,
    facts: &EgressCandidate,
    destination: ArtifactDestination,
) -> Result<Verdict, KernelError> {
    let Some(state) = &facts.state else {
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
    if !filter.matches(state.scope_id.as_deref(), &mut stored_terms(store))? {
        return Ok(Verdict::WrongScope);
    }
    let sensitive = match facts.served.map(|served| served.sensitivity) {
        Some(Sensitivity::Secret) => true,
        Some(sensitivity) => {
            destination == ArtifactDestination::Remote && sensitivity != Sensitivity::Normal
        }
        None => destination == ArtifactDestination::Remote,
    };
    if sensitive {
        return Ok(Verdict::ProviderSensitive);
    }
    // `kernel.read` no longer serves a hidden object; dispatch must not either.
    if facts
        .served
        .is_some_and(|served| served.visibility == SurfaceVisibility::Hidden)
    {
        return Ok(Verdict::Hidden);
    }
    if let Some(artifact) = &facts.artifact {
        if artifact.eligibility != ArtifactEligibility::Allowed {
            return Ok(Verdict::ProviderSensitive);
        }
    }
    Ok(Verdict::Ok)
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
    let named: Vec<(String, Option<String>)> = candidates
        .iter()
        .map(|candidate| {
            (
                candidate.object_id.clone(),
                candidate.artifact_digest.clone(),
            )
        })
        .collect();
    let (tip, facts) = store.egress_candidates(&named, destination)?;
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
    let mut filter = ScopeFilter::new(project);
    let mut verdicts = Vec::with_capacity(candidates.len());
    let mut fresh: Vec<(CacheKey, Verdict)> = Vec::new();
    for ((candidate, facts), (key, cached)) in candidates
        .iter()
        .zip(&facts)
        .zip(keys.into_iter().zip(cached))
    {
        let verdict = match cached {
            Some(verdict) => verdict,
            None => {
                let verdict = judge(store, &mut filter, candidate, facts, destination)?;
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
        if parsed.candidates.iter().any(|candidate| {
            candidate.object_id.is_empty() || candidate.object_id.len() > MAX_OBJECT_ID_BYTES
        }) {
            return crate::invalid_params_error(format!(
                "{OPERATION} object_id must be 1..={MAX_OBJECT_ID_BYTES} bytes"
            ));
        }
        if parsed.candidates.iter().any(|candidate| {
            candidate
                .artifact_digest
                .as_deref()
                .is_some_and(|digest| !is_lower_hex(digest, 64))
        }) {
            return crate::invalid_params_error(format!(
                "{OPERATION} artifact_digest must be lowercase sha256 hex"
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
