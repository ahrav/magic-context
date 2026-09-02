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

use mc_kernel::{ArtifactHandle, Sensitivity, Surface, SurfaceVisibility};

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
    let handle = proof
        .store()
        .ingest_artifact(ingest("evidence", b"evidence bytes", Sensitivity::Normal))
        .unwrap();
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
    Subject {
        proof,
        handle,
        object_id,
    }
}

/// The evidence object the ingest fixture registers for `handle`.
fn handle_object_id(handle: &ArtifactHandle) -> String {
    handle
        .evidence_id
        .replacen("evidence-", "evidence-object-", 1)
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
    } = admitted_subject();
    // Positive control: the dependent subject is served before deletion.
    assert!(auto_inject_ids(&proof).contains(&object_id));
    let live_refs = "SELECT COUNT(*) FROM evidence_meta WHERE invalidated_commit_seq IS NULL";
    assert_eq!(count_sql(&proof, live_refs), 1);

    let result = proof
        .store()
        .delete_artifact(deletion("delete", &handle.digest))
        .unwrap();
    assert!(!result.already_applied);
    assert_eq!(result.commit_seq, proof.tip());
    assert_eq!(count_sql(&proof, live_refs), 0);
    assert_eq!(
        count_sql(
            &proof,
            &format!(
                "SELECT COUNT(*) FROM object_registry WHERE invalidated_commit_seq={}",
                result.commit_seq
            )
        ),
        result.affected_object_ids.len() as i64
    );

    assert_eq!(
        result.affected_object_ids,
        vec![handle_object_id(&handle)],
        "deletion invalidates the evidence object, not the admitted subject"
    );
    let check_state = |proof: &Proof| {
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
        }
        let barrier = proof.store().deletion_barrier(&result.barrier_id).unwrap();
        assert_eq!(barrier.deletion_commit_seq, result.commit_seq);
        assert_eq!(barrier.consumers.len(), 1);
        assert!(!barrier.cleared);
    };
    check_state(&proof);
    let projection = proof.store().rebuild_alignment().unwrap();
    let before_restart = proof.digest();

    proof.restart();
    check_state(&proof);
    assert_eq!(proof.store().rebuild_alignment().unwrap(), projection);
    assert_eq!(proof.digest(), before_restart);

    // Replaying the deletion adds no rows and reports the original commit.
    let replayed = proof
        .store()
        .delete_artifact(deletion("delete", &handle.digest))
        .unwrap();
    assert!(replayed.already_applied);
    assert_eq!(replayed.commit_seq, result.commit_seq);
    assert_eq!(replayed.barrier_id, result.barrier_id);
    assert_eq!(proof.digest(), before_restart);
}

#[test]
fn deletion_fault_before_commit_leaves_references_live_and_no_barrier_across_restart() {
    let Subject {
        mut proof,
        handle,
        object_id,
    } = admitted_subject();
    assert!(auto_inject_ids(&proof).contains(&object_id));
    proof.fault_deletion(deletion("delete", &handle.digest));
    // `fault_deletion` restarted; the reference is still live and no barrier
    // or propagation row exists.
    assert!(auto_inject_ids(&proof).contains(&object_id));
    assert_eq!(
        count_sql(
            &proof,
            "SELECT COUNT(*) FROM evidence_meta WHERE invalidated_commit_seq IS NULL"
        ),
        1
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
