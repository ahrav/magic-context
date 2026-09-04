//! `kernel.eligibility.batch`: one verdict per candidate, computed from the
//! object registry, the bound project's scope, and artifact egress facts, and
//! cached per candidate for the store incarnation and tip it was computed at.

use std::collections::{HashMap, VecDeque};

use mc_core::claim_operation::is_lower_hex;
use mc_host::RouteHandle;
use mc_kernel::{
    ArtifactDestination, ArtifactEligibility, EgressCandidate, EgressSnapshot, KernelError,
    KernelStore, Sensitivity, SurfaceVisibility,
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
#[serde(deny_unknown_fields)]
struct BatchRequest {
    destination: String,
    candidates: Vec<Candidate>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
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
    classification_generation: u64,
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
/// caller; the registry class stands in when no admission decision serves the
/// object. A secret object is refused for every destination and a non-normal
/// object for a remote one, whether or not the candidate cites an artifact.
/// An object no read serves, hidden by admission or never admitted, is
/// refused as `Hidden`.
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
    let sensitivity = facts
        .served
        .map_or(state.object.sensitivity, |served| served.sensitivity);
    if sensitivity == Sensitivity::Secret
        || (destination == ArtifactDestination::Remote && sensitivity != Sensitivity::Normal)
    {
        return Ok(Verdict::ProviderSensitive);
    }
    if facts
        .served
        .is_none_or(|served| served.visibility == SurfaceVisibility::Hidden)
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

fn cache_keys(
    store: &KernelStore,
    project: &ProjectBinding,
    destination: ArtifactDestination,
    candidates: &[Candidate],
    snapshot: EgressSnapshot,
) -> Option<Vec<CacheKey>> {
    // Without a classification generation the snapshot has no cache identity:
    // nothing is looked up and nothing is stored.
    let generation = snapshot.classification_generation?;
    let lease_epoch = store.lease_epoch();
    let project_scope_id = project.scope_id();
    Some(
        candidates
            .iter()
            .map(|candidate| CacheKey {
                lease_epoch,
                tip: snapshot.tip,
                classification_generation: generation,
                object_id: candidate.object_id.clone(),
                source_revision: candidate.source_revision,
                artifact_digest: candidate.artifact_digest.clone(),
                destination,
                project_scope_id: project_scope_id.clone(),
            })
            .collect(),
    )
}

fn lookup(
    coordinator: &KernelOpenCoordinator,
    keys: Option<&[CacheKey]>,
    len: usize,
) -> Vec<Option<Verdict>> {
    // `judge` reads SQLite, so the cache guard is held only for the lookups
    // and then again for the inserts, never across a judgement.
    match keys {
        Some(keys) => {
            let cache = coordinator.eligibility_cache();
            keys.iter().map(|key| cache.get(key)).collect()
        }
        None => vec![None; len],
    }
}

fn named(
    candidates: &[Candidate],
    indices: impl Iterator<Item = usize>,
) -> Vec<(String, Option<String>)> {
    indices
        .map(|index| {
            (
                candidates[index].object_id.clone(),
                candidates[index].artifact_digest.clone(),
            )
        })
        .collect()
}

// The vector lives for one batch and misses dominate it, so boxing `Miss`
// would add one allocation per miss to save padding on the hits.
#[allow(clippy::large_enum_variant)]
enum Resolution {
    Hit(Verdict),
    /// The key is `None` when the snapshot has no cache identity, so the
    /// verdict judged from `facts` is not stored.
    Miss {
        facts: EgressCandidate,
        key: Option<CacheKey>,
    },
}

/// `miss_facts` holds one entry per `None` in `cached`, in candidate order.
fn resolve(
    cached: Vec<Option<Verdict>>,
    keys: Option<Vec<CacheKey>>,
    miss_facts: Vec<EgressCandidate>,
) -> Vec<Resolution> {
    let mut keys = keys.map(Vec::into_iter);
    let mut miss_facts = miss_facts.into_iter();
    cached
        .into_iter()
        .map(|hit| {
            let key = keys.as_mut().and_then(Iterator::next);
            match hit {
                Some(verdict) => Resolution::Hit(verdict),
                None => Resolution::Miss {
                    facts: miss_facts
                        .next()
                        .expect("egress_candidates returns one entry per named candidate"),
                    key,
                },
            }
        })
        .collect()
}

fn evaluate(
    store: &KernelStore,
    coordinator: &KernelOpenCoordinator,
    project: &ProjectBinding,
    destination: ArtifactDestination,
    candidates: &[Candidate],
) -> Result<BatchResponse, KernelError> {
    evaluate_with(
        store,
        coordinator,
        project,
        destination,
        candidates,
        |named| store.egress_candidates(named, destination),
    )
}

/// Looks the cache up before touching the registry, so a batch whose verdicts
/// are all cached costs one snapshot read. The facts for the misses are read
/// at whatever state the store has by then; when a commit or a classification
/// merge moved it in between, the hits were judged against an older state
/// than the misses, so the batch is redone at the facts' snapshot with every
/// candidate's facts in hand.
///
/// `read_facts` lets tests move the store between the snapshot and facts reads.
fn evaluate_with(
    store: &KernelStore,
    coordinator: &KernelOpenCoordinator,
    project: &ProjectBinding,
    destination: ArtifactDestination,
    candidates: &[Candidate],
    mut read_facts: impl FnMut(
        &[(String, Option<String>)],
    ) -> Result<(EgressSnapshot, Vec<EgressCandidate>), KernelError>,
) -> Result<BatchResponse, KernelError> {
    let snapshot = store.egress_snapshot()?;
    let keys = cache_keys(store, project, destination, candidates, snapshot);
    let cached = lookup(coordinator, keys.as_deref(), candidates.len());
    let misses: Vec<usize> = (0..candidates.len())
        .filter(|&index| cached[index].is_none())
        .collect();
    let (facts_snapshot, miss_facts) = if misses.is_empty() {
        (snapshot, Vec::new())
    } else {
        read_facts(&named(candidates, misses.iter().copied()))?
    };
    let (snapshot, resolutions) = if facts_snapshot == snapshot {
        (snapshot, resolve(cached, keys, miss_facts))
    } else {
        let (snapshot, facts) = if misses.len() == candidates.len() {
            (facts_snapshot, miss_facts)
        } else {
            read_facts(&named(candidates, 0..candidates.len()))?
        };
        let keys = cache_keys(store, project, destination, candidates, snapshot);
        let cached = lookup(coordinator, keys.as_deref(), candidates.len());
        let miss_facts = facts
            .into_iter()
            .zip(&cached)
            .filter(|(_, hit)| hit.is_none())
            .map(|(facts, _)| facts)
            .collect();
        (snapshot, resolve(cached, keys, miss_facts))
    };
    let cache_hits = resolutions
        .iter()
        .filter(|resolution| matches!(resolution, Resolution::Hit(_)))
        .count();
    let mut filter = ScopeFilter::new(project);
    let mut verdicts = Vec::with_capacity(candidates.len());
    let mut fresh: Vec<(CacheKey, Verdict)> = Vec::new();
    for (candidate, resolution) in candidates.iter().zip(resolutions) {
        let verdict = match resolution {
            Resolution::Hit(verdict) => verdict,
            Resolution::Miss { facts, key } => {
                let verdict = judge(store, &mut filter, candidate, &facts, destination)?;
                if let Some(key) = key {
                    fresh.push((key, verdict));
                }
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
        known_as_of: snapshot.tip,
        verdicts,
        cache_hits,
    })
}

impl McHandler {
    pub(crate) async fn handle_kernel_eligibility_batch(
        &self,
        channel: RouteHandle,
        request: Value,
    ) -> PreparedOutcome {
        let (scope, parsed) = match self.kernel_request::<BatchRequest>(channel, request, OPERATION)
        {
            Ok(bound) => bound,
            Err(outcome) => return outcome,
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
    use std::cell::RefCell;

    use mc_kernel::CommitIntent;

    use super::*;

    fn key(index: usize) -> CacheKey {
        CacheKey {
            lease_epoch: 1,
            tip: 1,
            classification_generation: 0,
            object_id: format!("object-{index}"),
            source_revision: 1,
            artifact_digest: None,
            destination: ArtifactDestination::Local,
            project_scope_id: "project:x".to_string(),
        }
    }

    struct Fixture {
        _directory: tempfile::TempDir,
        store: KernelStore,
        coordinator: KernelOpenCoordinator,
        project: ProjectBinding,
    }

    fn fixture() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let store = KernelStore::open(directory.path()).unwrap();
        let project = ProjectBinding::new(directory.path());
        Fixture {
            _directory: directory,
            store,
            coordinator: KernelOpenCoordinator::new(),
            project,
        }
    }

    fn candidates(count: usize) -> Vec<Candidate> {
        (0..count)
            .map(|index| Candidate {
                object_id: format!("object-{index}"),
                source_revision: 1,
                artifact_digest: None,
            })
            .collect()
    }

    /// An empty commit still appends to the commit log, so the tip moves.
    fn move_tip(store: &KernelStore) {
        store
            .commit(
                CommitIntent {
                    producer: "eligibility-test".to_string(),
                    operation_key: "move".to_string(),
                    request_digest: "0".repeat(64),
                    actor: "test".to_string(),
                    cause: "race".to_string(),
                },
                |_| Ok(String::new()),
            )
            .unwrap();
    }

    fn evaluate_recording(
        fixture: &Fixture,
        candidates: &[Candidate],
        move_on_first_read: bool,
    ) -> (BatchResponse, Vec<Vec<String>>) {
        let reads: RefCell<Vec<Vec<String>>> = RefCell::new(Vec::new());
        let response = evaluate_with(
            &fixture.store,
            &fixture.coordinator,
            &fixture.project,
            ArtifactDestination::Local,
            candidates,
            |named| {
                let mut reads = reads.borrow_mut();
                reads.push(named.iter().map(|(id, _)| id.clone()).collect());
                if move_on_first_read && reads.len() == 1 {
                    move_tip(&fixture.store);
                }
                fixture
                    .store
                    .egress_candidates(named, ArtifactDestination::Local)
            },
        )
        .unwrap();
        (response, reads.into_inner())
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

    #[test]
    fn only_the_misses_are_read_when_the_snapshot_holds() {
        let fixture = fixture();
        let candidates = candidates(2);
        let warm = evaluate(
            &fixture.store,
            &fixture.coordinator,
            &fixture.project,
            ArtifactDestination::Local,
            &candidates[..1],
        )
        .unwrap();
        assert_eq!(warm.cache_hits, 0);

        let (response, reads) = evaluate_recording(&fixture, &candidates, false);
        assert_eq!(reads, vec![vec!["object-1".to_string()]]);
        assert_eq!(response.cache_hits, 1);
        assert_eq!(response.known_as_of, warm.known_as_of);
        assert_eq!(fixture.coordinator.eligibility_cache().len(), 2);
    }

    #[test]
    fn a_hit_from_an_older_snapshot_is_discarded_when_the_misses_read_a_newer_one() {
        let fixture = fixture();
        let candidates = candidates(2);
        let warm = evaluate(
            &fixture.store,
            &fixture.coordinator,
            &fixture.project,
            ArtifactDestination::Local,
            &candidates[..1],
        )
        .unwrap();

        let (response, reads) = evaluate_recording(&fixture, &candidates, true);
        // The miss read the moved store, so the batch is re-read in full.
        assert_eq!(
            reads,
            vec![
                vec!["object-1".to_string()],
                vec!["object-0".to_string(), "object-1".to_string()],
            ]
        );
        assert_eq!(response.cache_hits, 0);
        assert_eq!(response.known_as_of, warm.known_as_of + 1);
        assert!(response
            .verdicts
            .iter()
            .all(|(_, verdict)| *verdict == Verdict::Retracted));
        // The stale entry stays; both candidates are stored at the new tip.
        assert_eq!(fixture.coordinator.eligibility_cache().len(), 3);
        let (again, reads) = evaluate_recording(&fixture, &candidates, false);
        assert!(reads.is_empty());
        assert_eq!(again.cache_hits, 2);
        assert_eq!(again.known_as_of, response.known_as_of);
    }

    #[test]
    fn a_batch_with_no_hits_is_not_re_read_when_the_snapshot_moves() {
        let fixture = fixture();
        let candidates = candidates(2);
        let before = fixture.store.egress_snapshot().unwrap();

        let (response, reads) = evaluate_recording(&fixture, &candidates, true);
        assert_eq!(
            reads,
            vec![vec!["object-0".to_string(), "object-1".to_string()]]
        );
        assert_eq!(response.cache_hits, 0);
        assert_eq!(response.known_as_of, before.tip + 1);
        assert_eq!(fixture.coordinator.eligibility_cache().len(), 2);
        let (again, reads) = evaluate_recording(&fixture, &candidates, false);
        assert!(reads.is_empty());
        assert_eq!(again.cache_hits, 2);
        assert_eq!(again.known_as_of, response.known_as_of);
    }
}
