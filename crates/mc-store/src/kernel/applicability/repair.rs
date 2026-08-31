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

use rusqlite::{OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

use super::super::slice::{ObservationDependencySpec, ObservationPayload, ObservationSpec};
use super::super::{CommitIntent, KernelError, KernelStore, Sensitivity};
use super::checkout::{CheckoutSnapshot, EvalBudget};
use super::engine::{ApplicabilityEngine, ApplicabilityState, ObjectApplicability};
use super::payloads::{
    ApplicabilityObservationPayload, DEPENDENCY_KIND_TARGET, OBSERVATION_APPLICABILITY_SCHEMA,
    OBSERVATION_KIND_CURRENT, OBSERVATION_KIND_STALE,
};
use super::resolve::PATCH_ID_ALGORITHM;

/// Producer recorded on applicability repair commits.
const REPAIR_PRODUCER: &str = "applicability-engine";

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
    domain_id: String,
    actor: String,
    head: String,
}

/// The commit sequence of the latest clearing (`applicability.current`)
/// observation for the (object, checkout) pair, folded into the dedup
/// identity. It advances only when a clear lands, so repeated evaluations
/// of a persistently stale object replay one receipt, while a re-failure
/// after a clear derives a fresh key instead of replaying the pre-clear
/// receipt (which would leave the durable block silently lifted).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PriorBlockState(pub Option<i64>);

impl RepairIntent {
    /// Builds the durable-append intent for a classified object. Returns
    /// `None` for states that do not append: only stale classifications and
    /// current re-evaluations (which clear an earlier block) write
    /// observations; historical/uncertain/dirty verdicts are recomputable
    /// from the checkout and stay in-request vetoes.
    pub fn for_classification(
        snapshot: &CheckoutSnapshot,
        object: &ObjectApplicability,
        domain_id: &str,
        actor: &str,
        observed_at: i64,
        prior_block: PriorBlockState,
    ) -> Option<Self> {
        let kind = match object.state {
            ApplicabilityState::Stale => OBSERVATION_KIND_STALE,
            ApplicabilityState::Current => OBSERVATION_KIND_CURRENT,
            _ => return None,
        };
        // The declared serde encoding, not Debug output: this string enters
        // a durable identity, and Debug formatting is not a stability
        // contract.
        let check_digest = object
            .failed_check
            .as_ref()
            .and_then(|failed| serde_json::to_string(&failed.check).ok())
            .unwrap_or_default();
        let payload = ApplicabilityObservationPayload {
            schema: OBSERVATION_APPLICABILITY_SCHEMA.to_string(),
            checkout_identity: snapshot.identity().to_string(),
            head: snapshot.head().to_string(),
            dirty_fingerprint: snapshot.dirty_fingerprint().to_string(),
            patch_id_algorithm: PATCH_ID_ALGORITHM.to_string(),
            state: object.state.label().to_string(),
            evidence: object.evidence.clone(),
        };
        let detail = serde_json::to_string(&payload).expect("observation payload is serializable");
        // Deep-verification dedup identity (KTD9): object revision, checkout
        // identity, failed check, and algorithm version, plus HEAD, dirty
        // fingerprint, and the latest clearing observation's commit
        // sequence as the epoch discriminator.
        let prior_block_marker = prior_block
            .0
            .map(|seq| seq.to_string())
            .unwrap_or_else(|| "none".to_string());
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
            &prior_block_marker,
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
            summary: object.evidence.clone(),
            detail,
            operation_key,
            request_digest: format!("{:x}", digest.finalize()),
            observed_at,
            domain_id: domain_id.to_string(),
            actor: actor.to_string(),
            head: snapshot.head().to_string(),
        })
    }

    fn observation_spec(&self, sensitivity: Sensitivity) -> ObservationSpec {
        ObservationSpec {
            observation_id: format!("applicability-{}", self.operation_key),
            object_id: format!("applicability-object-{}", self.operation_key),
            domain_id: self.domain_id.clone(),
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
            sensitivity,
        }
    }
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
    let result = store.commit(commit_intent, |envelope| {
        // Revalidate after acquiring the writer: the deadline may have
        // expired while waiting, and the checkout may have moved. A receipt
        // replay skips this closure, which is sound because the operation
        // key already binds object revision, HEAD, and dirty fingerprint —
        // a replayed key is a commit for this exact state.
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
        let target: Option<(i64, String)> = envelope
            .tx
            .query_row(
                "SELECT source_revision, sensitivity_class FROM object_registry
                 WHERE object_id=?1 AND invalidated_commit_seq IS NULL",
                [intent.object_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| KernelError::Io)?;
        let Some((revision, sensitivity)) = target else {
            return Err(KernelError::Conflict);
        };
        if revision != intent.object_revision {
            return Err(KernelError::Conflict);
        }
        // The observation inherits the target's sensitivity: repair must
        // not launder sensitive object metadata into normal-class rows.
        let sensitivity = Sensitivity::from_stored(&sensitivity).restrictive(Sensitivity::Normal);
        let spec = intent.observation_spec(sensitivity);
        Ok(envelope.insert_observation(spec)?.result_json())
    });
    match result {
        Ok(receipt) => {
            engine.confirm_durable_append(&object.token);
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
    /// Commit sequence of the latest clearing observation for the pair,
    /// which may be older than `commit_seq` when the latest record blocks.
    pub latest_clear_commit_seq: Option<i64>,
}

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
        let mut reader = self.lock_reader()?;
        let tx = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| KernelError::Io)?;
        let tip: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
                [],
                |row| row.get(0),
            )
            .map_err(|_| KernelError::Io)?;
        if known_as_of > tip {
            return Err(KernelError::FutureSnapshot);
        }
        let mut statement = tx
            .prepare(
                "SELECT o.observation_kind, o.observation_payload, o.created_commit_seq
                 FROM observation_dependencies d
                 JOIN observations o ON o.observation_id = d.observation_id
                 WHERE d.dependency_object_id = ?1
                   AND d.dependency_kind = ?2
                   AND o.observation_kind LIKE 'applicability.%'
                   AND o.created_commit_seq <= ?3
                   AND (o.invalidated_commit_seq IS NULL OR ?3 < o.invalidated_commit_seq)
                 ORDER BY o.created_commit_seq DESC, o.observation_id DESC",
            )
            .map_err(|_| KernelError::Io)?;
        let rows = statement
            .query_map(
                rusqlite::params![object_id, DEPENDENCY_KIND_TARGET, known_as_of],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .map_err(|_| KernelError::Io)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| KernelError::Io)?;
        drop(statement);
        tx.commit().map_err(|_| KernelError::Io)?;
        let mut latest: Option<(String, i64)> = None;
        let mut latest_clear_commit_seq = None;
        for (kind, payload, commit_seq) in rows {
            let Ok(payload) = serde_json::from_slice::<ObservationPayload>(&payload) else {
                continue;
            };
            let Some(detail) = payload.detail.as_deref() else {
                continue;
            };
            let Ok(detail) = serde_json::from_str::<ApplicabilityObservationPayload>(detail) else {
                continue;
            };
            if detail.schema != OBSERVATION_APPLICABILITY_SCHEMA
                || detail.checkout_identity != checkout_identity
            {
                continue;
            }
            if latest.is_none() {
                latest = Some((kind.clone(), commit_seq));
            }
            if kind == OBSERVATION_KIND_CURRENT {
                latest_clear_commit_seq = Some(commit_seq);
                break;
            }
        }
        Ok(latest.map(|(kind, commit_seq)| InjectionBlock {
            blocked: kind != OBSERVATION_KIND_CURRENT,
            observation_kind: kind,
            commit_seq,
            latest_clear_commit_seq,
        }))
    }
}
