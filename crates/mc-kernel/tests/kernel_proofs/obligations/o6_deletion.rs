//! O6, evidence-deletion propagation, kernel half: deleting an artifact
//! invalidates every reference in one commit, emits the complete propagation
//! work (four targets, each carrying the barrier id), replays without new
//! rows, and a fault before the reference commit leaves nothing behind, all
//! across a restart.
//!
//! `visible_as_of` re-evaluates stored admission decisions and never consults
//! evidence liveness, so an admitted subject whose trigger evidence was
//! deleted is served until a consumer of the `admission_state` target records
//! a new decision. This module proves that work row is emitted; the registry
//! tracks the withdrawal itself as a separate row.

use mc_kernel::{
    ArtifactDeletionKind, ArtifactErrorKind, ArtifactHandle, Sensitivity, Surface,
    SurfaceVisibility,
};

use crate::canonical_state::CanonicalDigest;
use crate::fixtures::{
    admit_request, admitted_domain, code_observation, deletion, ingest, intent, root_domain,
    staging,
};
use crate::harness::Proof;

const CANDIDATE: &str = "candidate-1";
const PROPAGATION_TARGETS: [&str; 4] = [
    "derived_support",
    "retrieval_documents",
    "embeddings",
    "admission_state",
];

struct Subject {
    proof: Proof,
    handle: ArtifactHandle,
    object_id: String,
    evidence_object_ids: Vec<String>,
}

/// Ingests an artifact and admits a candidate whose trigger observation
/// cites that artifact as evidence, so the admitted subject depends on it.
fn admitted_subject() -> Subject {
    let mut proof = Proof::open();
    proof.commit(intent("seed"), |envelope| {
        envelope.insert_domain(root_domain())?;
        Ok(String::new())
    });
    proof.commit(intent("consumer"), |envelope| {
        envelope.register_outbox_consumer("search", 10)?;
        Ok(String::new())
    });
    let request = ingest("evidence", b"evidence bytes", Sensitivity::Normal);
    let evidence_object_id = request.object_id.clone();
    let handle = proof.store().ingest_artifact(request).unwrap();
    // A second reference to the same bytes, so a deletion that stopped after
    // the first row matching the digest fails the propagation assertions.
    let shared = ingest("evidence-second", b"evidence bytes", Sensitivity::Normal);
    let shared_object_id = shared.object_id.clone();
    let shared_handle = proof.store().ingest_artifact(shared).unwrap();
    assert_eq!(shared_handle.digest, handle.digest);
    let mut evidence_object_ids = vec![evidence_object_id, shared_object_id];
    // `delete_artifact` reports the affected ids ordered by object id.
    evidence_object_ids.sort();
    proof
        .store()
        .stage_candidate(staging("run-1", CANDIDATE, "name"))
        .unwrap();
    let admitted = admitted_domain(CANDIDATE, "name");
    let object_id = admitted.object_id.clone();
    let evidence_id = handle.evidence_id.clone();
    proof.commit(intent("admit"), |envelope| {
        let mut trigger = code_observation(CANDIDATE);
        trigger.evidence_id = Some(evidence_id);
        let request = admit_request(CANDIDATE, &trigger.observation_id);
        envelope.insert_observation(trigger)?;
        envelope.admit_domain_candidate(request, admitted)?;
        Ok(String::new())
    });
    // The test reads `evidence_id` back because `validate_trigger` accepts NULL
    // evidence IDs.
    let stored_evidence: Option<String> = proof
        .db()
        .query_row(
            "SELECT evidence_id FROM observations WHERE observation_id=?1",
            [format!("observation-{CANDIDATE}")],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        stored_evidence.as_deref(),
        Some(handle.evidence_id.as_str())
    );
    Subject {
        proof,
        handle,
        object_id,
        evidence_object_ids,
    }
}

fn auto_inject_ids(proof: &Proof) -> Vec<String> {
    proof
        .store()
        .visible_as_of(Surface::AutoInject, proof.tip())
        .unwrap()
        .rows
        .into_iter()
        .filter(|row| row.visibility == SurfaceVisibility::Visible)
        .map(|row| row.object.object_id)
        .collect()
}

fn count_sql(proof: &Proof, sql: &str) -> i64 {
    proof.db().query_row(sql, [], |row| row.get(0)).unwrap()
}

fn ids_sql(proof: &Proof, sql: &str) -> Vec<String> {
    proof
        .db()
        .prepare(sql)
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// A logical delete invalidates references; only a purge unlinks the bytes.
fn assert_object_retained(proof: &Proof, digest: &str) {
    let path = proof
        .path()
        .join("artifacts/objects")
        .join(&digest[..2])
        .join(&digest[2..]);
    assert!(path.exists(), "the CAS object was unlinked: {path:?}");
}

fn assert_written_tables_unchanged(before: &CanonicalDigest, after: &CanonicalDigest, what: &str) {
    for (table, hash) in &before.tables {
        // The alignment projection is derived, not written by the deletion.
        if table.starts_with("alignment_projection") {
            continue;
        }
        assert_eq!(
            after.tables.get(table),
            Some(hash),
            "{what} wrote to {table}"
        );
    }
    assert_eq!(after.tables.len(), before.tables.len());
}

fn propagation_rows(proof: &Proof, commit_seq: i64) -> Vec<(String, serde_json::Value)> {
    proof
        .db()
        .prepare("SELECT object_kind,payload FROM outbox WHERE commit_seq=?1 ORDER BY ordinal")
        .unwrap()
        .query_map([commit_seq], |row| {
            Ok((
                row.get::<_, String>(0)?,
                serde_json::from_slice(&row.get::<_, Vec<u8>>(1)?).unwrap(),
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn deletion_invalidates_references_and_emits_complete_work_across_restart() {
    let Subject {
        mut proof,
        handle,
        object_id,
        evidence_object_ids,
    } = admitted_subject();
    // Positive control: the dependent subject is served before deletion.
    assert!(auto_inject_ids(&proof).contains(&object_id));
    let live_refs = "SELECT COUNT(*) FROM evidence_meta WHERE invalidated_commit_seq IS NULL";
    assert_eq!(count_sql(&proof, live_refs), 2);

    let result = proof
        .store()
        .delete_artifact(deletion("delete", &handle.digest))
        .unwrap();
    assert!(!result.already_applied);
    assert_eq!(result.kind, ArtifactDeletionKind::Delete);
    assert_eq!(result.digest, handle.digest);
    assert_eq!(result.commit_seq, proof.tip());
    assert_eq!(
        result.affected_object_ids, evidence_object_ids,
        "deletion invalidates every evidence reference, not the admitted subject"
    );

    let check_state = |proof: &Proof| {
        assert_eq!(count_sql(proof, live_refs), 0);
        // `evidence_meta` and `object_registry` are stamped by separate statements.
        for table in ["object_registry", "evidence_meta"] {
            assert_eq!(
                ids_sql(
                    proof,
                    &format!(
                        "SELECT object_id FROM {table} WHERE invalidated_commit_seq={}
                         ORDER BY object_id",
                        result.commit_seq
                    )
                ),
                result.affected_object_ids,
                "{table} did not stamp the affected ids at the deletion commit"
            );
        }
        let known = proof.store().known_as_of(proof.tip()).unwrap();
        for id in &result.affected_object_ids {
            assert!(
                !known.objects.iter().any(|row| &row.object_id == id),
                "{id} is still live after deletion"
            );
        }
        // The bytes stay on disk, but the deleted handle must not read them.
        assert_eq!(
            proof.store().read_artifact(&handle).unwrap_err().kind(),
            ArtifactErrorKind::ReferenceUnavailable
        );
        let rows = propagation_rows(proof, result.commit_seq);
        let mut kinds = rows
            .iter()
            .map(|(kind, _)| kind.as_str())
            .collect::<Vec<_>>();
        kinds.sort_unstable();
        let mut expected = PROPAGATION_TARGETS.to_vec();
        expected.sort_unstable();
        assert_eq!(kinds, expected);
        for (kind, payload) in &rows {
            assert_eq!(payload["audit"]["barrier_id"], result.barrier_id);
            assert_eq!(payload["audit"]["target_class"], *kind);
            assert_eq!(payload["audit"]["digest"], handle.digest);
            assert_eq!(payload["audit"]["deletion_kind"], "delete");
            assert_eq!(payload["audit"]["deletion_commit_seq"], result.commit_seq);
            // Without the ids, a consumer cannot tell what to invalidate.
            assert_eq!(
                payload["audit"]["affected_object_ids"],
                serde_json::json!(result.affected_object_ids),
                "{kind} payload lost the affected object ids"
            );
        }
        let barrier = proof.store().deletion_barrier(&result.barrier_id).unwrap();
        assert_eq!(barrier.deletion_commit_seq, result.commit_seq);
        assert_eq!(barrier.digest, handle.digest);
        assert_eq!(barrier.consumers.len(), 1);
        let consumer = &barrier.consumers[0];
        assert_eq!(consumer.consumer_id, "search");
        // A required checkpoint below the deletion commit would let the next checkpoint clear the barrier without consuming this deletion's work.
        assert_eq!(consumer.required_checkpoint_commit_seq, result.commit_seq);
        // A registered consumer checkpoint below the deletion commit keeps the barrier uncleared.
        let checkpoint = consumer
            .checkpoint_commit_seq
            .expect("a registered consumer has a checkpoint");
        assert!(
            checkpoint < consumer.required_checkpoint_commit_seq,
            "checkpoint {checkpoint} already reached the deletion commit"
        );
        assert!(!consumer.satisfied);
        assert!(consumer.abandoned_by.is_none());
        assert!(!barrier.cleared);
    };
    check_state(&proof);
    assert_object_retained(&proof, &handle.digest);
    // `visible_as_of` never consults evidence liveness, so the subject stays
    // served until a consumer of `admission_state` records a new decision.
    assert!(auto_inject_ids(&proof).contains(&object_id));
    let projection = proof.store().rebuild_alignment().unwrap();
    let before_restart = proof.digest();

    proof.restart();
    check_state(&proof);
    assert_object_retained(&proof, &handle.digest);
    assert!(auto_inject_ids(&proof).contains(&object_id));
    assert_eq!(proof.store().rebuild_alignment().unwrap(), projection);
    assert_eq!(proof.digest(), before_restart);

    // A fresh operation key exercises deletion without receipt replay.
    let before_repeat = proof.digest();
    let repeated = proof
        .store()
        .delete_artifact(deletion("delete-again", &handle.digest))
        .unwrap();
    assert!(repeated.already_applied);
    assert_eq!(repeated.kind, ArtifactDeletionKind::Delete);
    assert_eq!(repeated.digest, handle.digest);
    assert_eq!(repeated.commit_seq, result.commit_seq);
    assert_eq!(repeated.barrier_id, result.barrier_id);
    assert_eq!(repeated.affected_object_ids, result.affected_object_ids);
    assert_written_tables_unchanged(&before_repeat, &proof.digest(), "the repeated request");
    assert_object_retained(&proof, &handle.digest);

    // A reingested live reference makes the repeated deletion return its
    // operation receipt rather than take the no-live-references branch.
    let reingested = ingest("evidence-third", b"evidence bytes", Sensitivity::Normal);
    let reingested_object_id = reingested.object_id.clone();
    let reingested_handle = proof.store().ingest_artifact(reingested).unwrap();
    assert_eq!(reingested_handle.digest, handle.digest);
    assert_eq!(count_sql(&proof, live_refs), 1);
    let before_replay = proof.digest();

    let replayed = proof
        .store()
        .delete_artifact(deletion("delete", &handle.digest))
        .unwrap();
    assert!(replayed.already_applied);
    assert_eq!(replayed.kind, ArtifactDeletionKind::Delete);
    assert_eq!(replayed.digest, handle.digest);
    assert_eq!(replayed.commit_seq, result.commit_seq);
    assert_eq!(replayed.barrier_id, result.barrier_id);
    assert_eq!(replayed.affected_object_ids, result.affected_object_ids);
    // A replay serves the receipt instead of re-running the deletion, so the
    // reference ingested after the original commit stays live.
    assert_eq!(count_sql(&proof, live_refs), 1);
    assert!(proof
        .store()
        .known_as_of(proof.tip())
        .unwrap()
        .objects
        .iter()
        .any(|row| row.object_id == reingested_object_id));
    assert_eq!(
        count_sql(
            &proof,
            "SELECT COUNT(*) FROM deletion_backfill_barriers WHERE completed_at IS NULL"
        ),
        1,
        "the replay opened a second barrier"
    );
    assert_written_tables_unchanged(&before_replay, &proof.digest(), "the replay");
}

#[test]
fn deletion_fault_before_commit_leaves_references_live_and_no_barrier_across_restart() {
    let Subject {
        mut proof,
        handle,
        object_id,
        ..
    } = admitted_subject();
    assert!(auto_inject_ids(&proof).contains(&object_id));
    proof.fault_deletion(deletion("delete", &handle.digest));
    // Both references remain live; no barrier or propagation row exists.
    assert!(auto_inject_ids(&proof).contains(&object_id));
    assert_eq!(
        count_sql(
            &proof,
            "SELECT COUNT(*) FROM evidence_meta WHERE invalidated_commit_seq IS NULL"
        ),
        2
    );
    assert_eq!(
        count_sql(&proof, "SELECT COUNT(*) FROM deletion_backfill_barriers"),
        0
    );
    assert_eq!(
        count_sql(
            &proof,
            "SELECT COUNT(*) FROM outbox WHERE source_kind='artifact_deletion'"
        ),
        0
    );
    // Positive control: the same request lands once the fault is gone.
    let result = proof
        .store()
        .delete_artifact(deletion("delete", &handle.digest))
        .unwrap();
    assert!(!result.already_applied);
    assert_eq!(
        count_sql(
            &proof,
            "SELECT COUNT(*) FROM evidence_meta WHERE invalidated_commit_seq IS NULL"
        ),
        0
    );
}
