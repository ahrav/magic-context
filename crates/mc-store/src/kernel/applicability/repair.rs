//! Retrieval-time read repair: durable applicability observations, the
//! injection-block reducer, and deep-verification scheduling.
//!
//! The in-request veto is unconditional and independent of durability:
//! a failed check removes the object from the response before any append
//! lands. The durable record follows in one envelope commit — observation,
//! change event, and outbox job together — unless the deadline expired or
//! the checkout moved, in which case the cached append-confirmed flag makes
//! the next evaluation retry the append before the object could ever
//! auto-inject again.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::Instant;

use rusqlite::{OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

use super::super::redaction::redact_lossy;
use super::super::slice::{ObservationDependencySpec, ObservationPayload, ObservationSpec};
use super::super::{CommitIntent, Envelope, KernelError, KernelStore, Sensitivity};
use super::checkout::{CheckoutSnapshot, EvalBudget};
use super::engine::{ApplicabilityEngine, ApplicabilityState, ObjectApplicability};
use super::payloads::{
    checkout_identity_digest, ApplicabilityObservationPayload, DEPENDENCY_KIND_TARGET,
    OBSERVATION_APPLICABILITY_SCHEMA, OBSERVATION_KIND_CURRENT, OBSERVATION_KIND_STALE,
};
use super::resolve::PATCH_ID_ALGORITHM;

/// Producer recorded on applicability repair commits.
const REPAIR_PRODUCER: &str = "applicability-engine";

/// Evidence bytes carried inside an observation payload. Bounding the document
/// keeps it far below the secret scanner's work and candidate limits, whose
/// exhaustion replaces a whole field with a redaction token.
const MAX_PAYLOAD_EVIDENCE_BYTES: usize = 2048;

/// Redacts and bounds evidence before it becomes part of the payload document.
///
/// A truncation lands on a character boundary, and the marker keeps a truncated
/// value distinguishable from one that happened to end there.
fn evidence_for_payload(evidence: &str) -> String {
    let redacted = redact_lossy(evidence).text;
    if redacted.len() <= MAX_PAYLOAD_EVIDENCE_BYTES {
        return redacted;
    }
    let mut end = MAX_PAYLOAD_EVIDENCE_BYTES;
    while end > 0 && !redacted.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &redacted[..end])
}

/// How one durable append attempt ended. `Discarded` and `DeadlineMissed`
/// leave the in-request veto in force; the append-confirmed flag stays
/// unset so the next evaluation retries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppendOutcome {
    /// Observation, change event, and outbox job landed (or replayed) in
    /// one envelope commit.
    Landed { commit_seq: i64, replayed: bool },
    /// HEAD or the object revision moved between snapshot and commit; the
    /// result no longer describes the checkout and nothing durable landed.
    Discarded,
    /// The evaluation deadline expired before the writer could commit.
    DeadlineMissed,
}

/// Repair intent built outside any transaction from snapshot evidence.
#[derive(Debug, Clone)]
pub struct RepairIntent {
    object_id: String,
    object_revision: i64,
    kind: &'static str,
    summary: String,
    detail: String,
    operation_key: String,
    request_digest: String,
    observed_at: i64,
    actor: String,
    head: String,
}

impl RepairIntent {
    /// Builds the durable-append intent for a classified object. Returns
    /// `None` for states that do not append: only stale classifications and
    /// current re-evaluations (which clear an earlier block) write
    /// observations; historical/uncertain/dirty verdicts are recomputable
    /// from the checkout and stay in-request vetoes.
    pub fn for_classification(
        snapshot: &CheckoutSnapshot,
        object: &ObjectApplicability,
        block: Option<&InjectionBlock>,
        actor: &str,
        observed_at: i64,
    ) -> Option<Self> {
        let kind = match object.state {
            ApplicabilityState::Stale => OBSERVATION_KIND_STALE,
            ApplicabilityState::Current => OBSERVATION_KIND_CURRENT,
            _ => return None,
        };
        // Canonical JSON, not `Debug`: the digest is hashed into a durably
        // stored dedup key, and `Debug` output carries no stability guarantee
        // across compiler releases or field renames.
        let check_digest = object
            .failed_check
            .as_ref()
            .map(|failed| serde_json::to_string(&failed.check).expect("check spec is serializable"))
            .unwrap_or_default();
        // `detail` is serialized before the slice redacts it as one text field,
        // so a detection inside the free-form evidence would rewrite bytes of
        // the JSON document itself. The reducer decodes that document and now
        // fails closed on a document it cannot read, so the evidence is
        // redacted and bounded first and the envelope is built around the
        // result.
        let payload = ApplicabilityObservationPayload {
            schema: OBSERVATION_APPLICABILITY_SCHEMA.to_string(),
            checkout_identity_digest: checkout_identity_digest(snapshot.identity()),
            head: snapshot.head().to_string(),
            dirty_fingerprint: snapshot.dirty_fingerprint().to_string(),
            patch_id_algorithm: PATCH_ID_ALGORITHM.to_string(),
            state: object.state.label().to_string(),
            evidence: evidence_for_payload(&object.evidence),
        };
        let detail = serde_json::to_string(&payload).expect("observation payload is serializable");
        // Deep-verification dedup identity (KTD9): object revision, checkout
        // identity, HEAD, dirty fingerprint, failed check, and algorithm
        // version, plus the repair generation. HEAD and the fingerprint alone
        // repeat when a checkout returns to a state it already failed at, and
        // the generation is what distinguishes that re-failure from the
        // pre-clear one.
        let mut key = Sha256::new();
        key.update(b"mc-applicability-repair-v1\0");
        for part in [
            object.object_id.as_str(),
            &object.object_revision.to_string(),
            snapshot.identity(),
            snapshot.head(),
            snapshot.dirty_fingerprint(),
            kind,
            &check_digest,
            PATCH_ID_ALGORITHM,
            &generation_for(block, kind).to_string(),
        ] {
            key.update(part.as_bytes());
            key.update(b"\0");
        }
        let operation_key = format!("{:x}", key.finalize());
        let mut digest = Sha256::new();
        digest.update(detail.as_bytes());
        Some(Self {
            object_id: object.object_id.clone(),
            object_revision: object.object_revision,
            kind,
            // The slice rejects an oversized field, which would turn the stale
            // veto this repair records into a failed evaluation. The payload
            // already carries the bounded form.
            summary: payload.evidence.clone(),
            detail,
            operation_key,
            request_digest: format!("{:x}", digest.finalize()),
            observed_at,
            actor: actor.to_string(),
            head: snapshot.head().to_string(),
        })
    }

    /// `target` carries the classified object's own domain and sensitivity,
    /// read inside the repair transaction.
    /// The observation kind this repair would append.
    pub fn observation_kind(&self) -> &'static str {
        self.kind
    }

    /// Dedup identity of this repair, for reconciling against the durable
    /// record before committing.
    pub fn operation_key(&self) -> &str {
        &self.operation_key
    }

    fn observation_spec(&self, target: &RepairTarget) -> ObservationSpec {
        ObservationSpec {
            observation_id: format!("applicability-{}", self.operation_key),
            object_id: format!("applicability-object-{}", self.operation_key),
            domain_id: target.domain_id.clone(),
            proposition_id: None,
            scope_id: None,
            anchor_id: None,
            evidence_id: None,
            observation_kind: self.kind.to_string(),
            payload: ObservationPayload {
                summary: self.summary.clone(),
                classification: self.kind.to_string(),
                detail: Some(self.detail.clone()),
            },
            observed_at: self.observed_at,
            dependencies: vec![ObservationDependencySpec {
                dependency_object_id: self.object_id.clone(),
                dependency_kind: DEPENDENCY_KIND_TARGET.to_string(),
                dependency_payload: None,
            }],
            source_kind: REPAIR_PRODUCER.to_string(),
            source_id: self.operation_key.clone(),
            source_revision: 1,
            sensitivity: target.sensitivity,
        }
    }
}

/// The classified object's domain and sensitivity, read from the registry
/// inside the repair transaction.
///
/// A repair payload carries checkout identity, evidence, and the failed check,
/// all derived from the target. Storing the observation as `Normal` would put
/// that content on the normal-sensitivity lane for a target the store
/// classifies `Sensitive` or `Secret`.
struct RepairTarget {
    domain_id: String,
    sensitivity: Sensitivity,
    source_revision: i64,
}

/// Reads the live registry row for `object_id`, taking the more restrictive of
/// the object's own class and its owning domain's.
fn load_repair_target(
    tx: &rusqlite::Transaction<'_>,
    object_id: &str,
) -> Result<Option<RepairTarget>, KernelError> {
    tx.query_row(
        // The domain has to be live as well. `insert_observation` rejects an
        // inactive parent with `NotFound`, which would surface as a failed
        // evaluation rather than a discarded repair.
        "SELECT r.domain_id, r.source_revision, r.sensitivity_class, d.sensitivity_class
         FROM object_registry r
         JOIN domains d ON d.domain_id = r.domain_id
         WHERE r.object_id=?1
           AND r.invalidated_commit_seq IS NULL
           AND d.invalidated_commit_seq IS NULL",
        [object_id],
        |row| {
            Ok(RepairTarget {
                domain_id: row.get::<_, String>(0)?,
                source_revision: row.get::<_, i64>(1)?,
                sensitivity: Sensitivity::from_stored(&row.get::<_, String>(2)?)
                    .restrictive(Sensitivity::from_stored(&row.get::<_, String>(3)?)),
            })
        },
    )
    .optional()
    .map_err(|_| KernelError::Io)
}

/// Commits one repair intent through the kernel envelope: observation with
/// its target link, change event, and outbox row land atomically; the
/// receipt makes duplicate repairs replay instead of duplicating jobs.
///
/// The commit revalidates the checkout and the object revision after
/// acquiring the writer: a moved HEAD or a corrected/invalidated object
/// discards the repair (the checkout no longer matches the evidence) and
/// the object stays uncertain for this request.
pub fn commit_read_repair(
    store: &KernelStore,
    engine: &ApplicabilityEngine,
    snapshot: &CheckoutSnapshot,
    object: &ObjectApplicability,
    intent: &RepairIntent,
    budget: &EvalBudget,
) -> Result<AppendOutcome, KernelError> {
    if budget.is_exhausted() {
        return Ok(AppendOutcome::DeadlineMissed);
    }
    let commit_intent = CommitIntent {
        producer: REPAIR_PRODUCER.to_string(),
        operation_key: intent.operation_key.clone(),
        request_digest: intent.request_digest.clone(),
        actor: intent.actor.clone(),
        cause: format!("applicability read repair: {}", intent.kind),
    };
    let operation = |envelope: &mut Envelope<'_>| {
        // Revalidate after acquiring the writer: the deadline may have
        // expired while waiting, and the checkout may have moved.
        if budget.is_exhausted() {
            return Err(KernelError::Deadline);
        }
        let live_head = snapshot
            .repo()
            .head_id()
            .map_err(|_| KernelError::Conflict)?
            .detach()
            .to_string();
        if live_head != intent.head {
            return Err(KernelError::Conflict);
        }
        let Some(target) = load_repair_target(envelope.tx, &intent.object_id)? else {
            return Err(KernelError::Conflict);
        };
        if target.source_revision != intent.object_revision {
            return Err(KernelError::Conflict);
        }
        Ok(envelope
            .insert_observation(intent.observation_spec(&target))?
            .result_json())
    };
    // `commit` blocks for the writer without a timeout, which would let a
    // near-deadline retrieval wait out its own bound and only then report
    // `DeadlineMissed`.
    let result = match budget.deadline() {
        Some(deadline) => store.commit_before(deadline, commit_intent, operation),
        None => store.commit(commit_intent, operation),
    };
    match result {
        Ok(receipt) => {
            // A dropped confirmation is safe: an evicted entry misses on the
            // next evaluation, which re-derives the verdict and re-appends.
            let _ = engine.confirm_durable_append(&object.token);
            Ok(AppendOutcome::Landed {
                commit_seq: receipt.commit_seq,
                replayed: receipt.replayed,
            })
        }
        Err(KernelError::Conflict) => Ok(AppendOutcome::Discarded),
        Err(KernelError::Deadline) => Ok(AppendOutcome::DeadlineMissed),
        Err(error) => Err(error),
    }
}

/// Reducer verdict: the latest applicability observation for one
/// (object, checkout) at `known_as_of`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectionBlock {
    pub observation_kind: String,
    pub commit_seq: i64,
    /// Blocked unless the latest observation records `applicability.current`.
    pub blocked: bool,
    /// Commit sequence of the newest observation whose kind differs from
    /// `observation_kind`, or 0 when this kind is the only one recorded.
    pub prior_kind_commit_seq: i64,
    /// Dedup identity of the repair that wrote the latest observation, which is
    /// its `source_id`. A repair whose identity equals this one is already
    /// recorded; one that differs describes a checkout state this record does
    /// not, even at the same kind.
    pub repair_identity: String,
}

impl InjectionBlock {
    /// Repair generation for an append of `kind`: the commit sequence of the
    /// newest recorded observation whose kind differs from `kind`.
    ///
    /// Repeating one repair keeps its generation, so the dedup key repeats and commentlint: allow(JUDGE)
    /// the receipt replays. Failing again after a clearing observation crosses commentlint: allow(JUDGE)
    /// a kind change, which advances the generation, so the dedup key differs commentlint: allow(JUDGE)
    /// from the pre-clear repair rather than replaying it. commentlint: allow(JUDGE)
    pub fn generation_for(&self, kind: &str) -> i64 {
        if self.observation_kind == kind {
            self.prior_kind_commit_seq
        } else {
            self.commit_seq
        }
    }
}

fn generation_for(block: Option<&InjectionBlock>, kind: &str) -> i64 {
    block.map_or(0, |block| block.generation_for(kind))
}

/// One object's reduction while the DESC scan walks its rows.
enum Reduction {
    /// Waiting for the newest row matching this checkout.
    Latest,
    /// Latest found; waiting for the newest row of a differing kind.
    PriorKind(InjectionBlock),
    Done(InjectionBlock),
}

impl Reduction {
    fn finish(self) -> Option<InjectionBlock> {
        match self {
            Self::Latest => None,
            Self::PriorKind(block) | Self::Done(block) => Some(block),
        }
    }
}

/// Rows scanned between budget polls. The scan is index-driven and stops at
/// the newest kind change, so polling every row would cost more than it saves.
const BLOCK_SCAN_POLL_INTERVAL: usize = 64;

/// Virtual-machine steps between deadline checks inside SQLite.
///
/// The reducer's `ORDER BY` spans two tables, so no index serves it and SQLite
/// sorts each target's rows into a temporary B-tree before yielding the first
/// one. The row-loop poll cannot run during that sort, which is the only part
/// of the scan whose cost grows with a target's history.
const BLOCK_SCAN_PROGRESS_STEPS: i32 = 1_000;

/// Maps a rusqlite failure raised by the deadline interrupt onto `Deadline`.
fn scan_error(error: rusqlite::Error) -> KernelError {
    match error {
        rusqlite::Error::SqliteFailure(failure, _)
            if failure.code == rusqlite::ErrorCode::OperationInterrupted =>
        {
            KernelError::Deadline
        }
        _ => KernelError::Io,
    }
}

/// Object identifiers bound per reducer query. SQLite's default parameter
/// ceiling is 32766; this leaves headroom for the other bound values.
const BLOCK_SCAN_ID_CHUNK: usize = 512;

impl KernelStore {
    /// Derives the injection block for `object_id` at `checkout_identity`
    /// from durable observations: latest applicability observation wins;
    /// no observation means no recorded block. `known_as_of` beyond the
    /// committed tip is a typed error, mirroring every other snapshot read.
    pub fn applicability_block_state(
        &self,
        object_id: &str,
        checkout_identity: &str,
        known_as_of: i64,
    ) -> Result<Option<InjectionBlock>, KernelError> {
        if known_as_of < 0 {
            return Err(KernelError::InvalidInput);
        }
        let mut states = self.reduce_block_states(
            &[object_id],
            checkout_identity,
            Some(known_as_of),
            &EvalBudget::unbounded(),
        )?;
        Ok(states.remove(object_id))
    }

    /// Batched reducer over `object_ids` at the committed tip, for the repair
    /// pass that decides whether each classified object still carries a block.
    /// One reader transaction serves the whole batch. A per-object call would
    /// re-derive the tip and take the reader lock once per object.
    ///
    /// Absent identifiers carry no recorded block.
    pub fn applicability_block_states_at_tip(
        &self,
        object_ids: &[&str],
        checkout_identity: &str,
        budget: &EvalBudget,
    ) -> Result<HashMap<String, InjectionBlock>, KernelError> {
        self.reduce_block_states(object_ids, checkout_identity, None, budget)
    }

    /// `known_as_of` of `None` reads the committed tip inside the same
    /// transaction as the scan.
    fn reduce_block_states(
        &self,
        object_ids: &[&str],
        checkout_identity: &str,
        known_as_of: Option<i64>,
        budget: &EvalBudget,
    ) -> Result<HashMap<String, InjectionBlock>, KernelError> {
        if object_ids.is_empty() {
            return Ok(HashMap::new());
        }
        // `lock_reader` blocks on `Mutex::lock`, which would let a concurrent
        // reader hold this evaluation past its deadline before the scan reaches
        // its first poll.
        let mut reader = match budget.deadline() {
            Some(deadline) => self.lock_reader_before(deadline)?,
            None => self.lock_reader()?,
        };
        let deadline = budget.deadline();
        if deadline.is_some() || budget.is_exhausted() {
            let interrupt = budget.interrupt_flag();
            reader
                .progress_handler(
                    BLOCK_SCAN_PROGRESS_STEPS,
                    Some(move || {
                        if interrupt.load(Ordering::Relaxed) {
                            return true;
                        }
                        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                            interrupt.store(true, Ordering::Relaxed);
                            return true;
                        }
                        false
                    }),
                )
                .map_err(|_| KernelError::Io)?;
        }
        let scanned = reduce_with_reader(
            &mut reader,
            object_ids,
            checkout_identity,
            known_as_of,
            budget,
        );
        // The connection returns to the pool, so the handler cannot outlive
        // this scan's deadline.
        let _ = reader.progress_handler(0, None::<fn() -> bool>);
        scanned
    }
}

/// The scan itself, so `reduce_block_states` can clear the progress handler on
/// every path out.
fn reduce_with_reader(
    reader: &mut rusqlite::Connection,
    object_ids: &[&str],
    checkout_identity: &str,
    known_as_of: Option<i64>,
    budget: &EvalBudget,
) -> Result<HashMap<String, InjectionBlock>, KernelError> {
    let mut states = HashMap::new();
    let tx = reader
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(scan_error)?;
    let tip: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
            [],
            |row| row.get(0),
        )
        .map_err(scan_error)?;
    let known_as_of = match known_as_of {
        Some(requested) if requested > tip => return Err(KernelError::FutureSnapshot),
        Some(requested) => requested,
        None => tip,
    };
    // Hashed once for the whole scan: the payload stores the digest, not the
    // identity, so the redactor cannot rewrite one side of the comparison.
    let digest = checkout_identity_digest(checkout_identity);
    for chunk in object_ids.chunks(BLOCK_SCAN_ID_CHUNK) {
        reduce_chunk(&tx, chunk, &digest, known_as_of, budget, &mut states)?;
    }
    tx.commit().map_err(scan_error)?;
    Ok(states)
}

/// Scans one chunk newest-first, stopping each object at its newest kind
/// change. Rows decode as the scan streams them. Collecting the chunk first
/// would materialize every historical payload for every identifier before a
/// single one is inspected.
fn reduce_chunk(
    tx: &rusqlite::Transaction<'_>,
    object_ids: &[&str],
    checkout_digest: &str,
    known_as_of: i64,
    budget: &EvalBudget,
    states: &mut HashMap<String, InjectionBlock>,
) -> Result<(), KernelError> {
    let placeholders = std::iter::repeat_n("?", object_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut statement = tx
        .prepare(&format!(
            "SELECT d.dependency_object_id, o.observation_kind, o.observation_payload,
                    o.created_commit_seq, r.source_id
             FROM observation_dependencies d
             JOIN observations o ON o.observation_id = d.observation_id
             JOIN object_registry r ON r.object_id = o.object_id
             WHERE d.dependency_object_id IN ({placeholders})
               AND d.dependency_kind = ?{kind}
               AND o.observation_kind LIKE 'applicability.%'
               AND o.created_commit_seq <= ?{as_of}
               AND (o.invalidated_commit_seq IS NULL OR ?{as_of} < o.invalidated_commit_seq)
             ORDER BY d.dependency_object_id, o.created_commit_seq DESC, o.observation_id DESC",
            kind = object_ids.len() + 1,
            as_of = object_ids.len() + 2,
        ))
        .map_err(scan_error)?;
    let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(object_ids.len() + 2);
    for object_id in object_ids {
        bound.push(object_id);
    }
    bound.push(&DEPENDENCY_KIND_TARGET);
    bound.push(&known_as_of);
    let mut rows = statement
        .query(rusqlite::params_from_iter(bound))
        .map_err(scan_error)?;
    let mut pending: HashMap<String, Reduction> = HashMap::new();
    let mut scanned = 0usize;
    while let Some(row) = rows.next().map_err(scan_error)? {
        scanned += 1;
        if scanned.is_multiple_of(BLOCK_SCAN_POLL_INTERVAL) && budget.is_exhausted() {
            return Err(KernelError::Deadline);
        }
        let object_id: String = row.get(0).map_err(scan_error)?;
        if matches!(pending.get(&object_id), Some(Reduction::Done(_))) {
            continue;
        }
        let kind: String = row.get(1).map_err(|_| KernelError::Io)?;
        let payload: Vec<u8> = row.get(2).map_err(|_| KernelError::Io)?;
        let commit_seq: i64 = row.get(3).map_err(|_| KernelError::Io)?;
        let repair_identity: String = row.get(4).map_err(|_| KernelError::Io)?;
        if !matches_checkout(&payload, &kind, checkout_digest)? {
            continue;
        }
        let entry = pending.entry(object_id).or_insert(Reduction::Latest);
        *entry = match std::mem::replace(entry, Reduction::Latest) {
            Reduction::Latest => Reduction::PriorKind(InjectionBlock {
                blocked: kind != OBSERVATION_KIND_CURRENT,
                observation_kind: kind,
                commit_seq,
                prior_kind_commit_seq: 0,
                repair_identity,
            }),
            Reduction::PriorKind(block) if block.observation_kind == kind => {
                Reduction::PriorKind(block)
            }
            Reduction::PriorKind(block) => Reduction::Done(InjectionBlock {
                prior_kind_commit_seq: commit_seq,
                ..block
            }),
            done @ Reduction::Done(_) => done,
        };
    }
    for (object_id, reduction) in pending {
        if let Some(block) = reduction.finish() {
            states.insert(object_id, block);
        }
    }
    Ok(())
}

/// A payload that does not decode fails the read. Skipping to an older row
/// would reduce a corrupt latest record to an older `applicability.current`,
/// or to no block at all, and let a failing object auto-inject.
///
/// `blocked` comes from the outer observation kind, so a row whose payload
/// records a different state than that kind is rejected rather than trusted.
/// The generic `insert_observation` API accepts any kind with any payload, and
/// such a row would otherwise clear a real block.
fn matches_checkout(
    payload: &[u8],
    observation_kind: &str,
    checkout_identity_digest: &str,
) -> Result<bool, KernelError> {
    let payload = serde_json::from_slice::<ObservationPayload>(payload)
        .map_err(|_| KernelError::CorruptCanonicalRow)?;
    let Some(detail) = payload.detail.as_deref() else {
        return Err(KernelError::CorruptCanonicalRow);
    };
    let detail = serde_json::from_str::<ApplicabilityObservationPayload>(detail)
        .map_err(|_| KernelError::CorruptCanonicalRow)?;
    if detail.schema != OBSERVATION_APPLICABILITY_SCHEMA
        || observation_kind != observation_kind_for_state(&detail.state)
    {
        return Err(KernelError::CorruptCanonicalRow);
    }
    Ok(detail.checkout_identity_digest == checkout_identity_digest)
}

/// The observation kind that carries `state`, which is the vocabulary
/// `payloads.rs` defines: one kind per state label.
fn observation_kind_for_state(state: &str) -> String {
    format!("applicability.{state}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The slice redacts the serialized payload as one text field, and the
    /// reducer decodes that field. Pre-redacting evidence keeps a detected
    /// secret out of the document, so the pass over the document has nothing
    /// left to rewrite and the JSON stays parseable.
    #[test]
    fn a_detected_secret_never_reaches_the_payload_document() {
        let payload = ApplicabilityObservationPayload {
            schema: OBSERVATION_APPLICABILITY_SCHEMA.to_string(),
            checkout_identity_digest: checkout_identity_digest("checkout"),
            head: "head".to_string(),
            dirty_fingerprint: "fingerprint".to_string(),
            patch_id_algorithm: PATCH_ID_ALGORITHM.to_string(),
            state: "stale".to_string(),
            evidence: evidence_for_payload("cheap check failed: password=hunter-two"),
        };
        let detail = serde_json::to_string(&payload).expect("payload is serializable");
        assert!(
            !detail.contains("hunter-two"),
            "the secret is gone before serialization"
        );

        let stored = redact_lossy(&detail).text;
        let decoded = serde_json::from_str::<ApplicabilityObservationPayload>(&stored)
            .expect("the stored document still decodes");
        assert_eq!(
            decoded.checkout_identity_digest,
            checkout_identity_digest("checkout")
        );
        assert_eq!(decoded.schema, OBSERVATION_APPLICABILITY_SCHEMA);
    }

    /// The scanner replaces a whole field when its candidate or work limit is
    /// exhausted, which a bounded field cannot reach.
    #[test]
    fn evidence_is_bounded_on_a_character_boundary() {
        let dense = "π password=hunter-two ".repeat(4096);
        let bounded = evidence_for_payload(&dense);
        assert!(bounded.len() <= MAX_PAYLOAD_EVIDENCE_BYTES + "…[truncated]".len());
        assert!(bounded.ends_with("…[truncated]"));
        assert!(!bounded.contains("hunter-two"));
        // A serialized document built from it round-trips through redaction.
        let detail = serde_json::to_string(&ApplicabilityObservationPayload {
            schema: OBSERVATION_APPLICABILITY_SCHEMA.to_string(),
            checkout_identity_digest: checkout_identity_digest("checkout"),
            head: "head".to_string(),
            dirty_fingerprint: "fingerprint".to_string(),
            patch_id_algorithm: PATCH_ID_ALGORITHM.to_string(),
            state: "stale".to_string(),
            evidence: bounded,
        })
        .expect("payload is serializable");
        serde_json::from_str::<ApplicabilityObservationPayload>(&redact_lossy(&detail).text)
            .expect("the stored document still decodes");
    }
}
