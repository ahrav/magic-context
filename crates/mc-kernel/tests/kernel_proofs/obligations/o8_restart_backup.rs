//! O8, restart and backup restore identical canonical state: the same-root
//! digest over every declared table survives a reopen; a backup taken at
//! commit `N` restores to the digest observed right after `backup` returned
//! (capture pins are part of that state) with `commit_seq` back at `N`;
//! outbox positions never regress or get reused across prune plus reopen;
//! each restore fault rolls the live family back to its pre-restore state;
//! and an intent replayed after restore is served from its receipt.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};

use mc_kernel::schema::KERNEL_SCHEMA_COMPONENT_NAMES;
use mc_kernel::{
    ArtifactDeletionKind, BackupRequest, ConsumerAbandonment, DecisionEventPayload,
    DecisionEventSpec, RestoreFault, ScopeSpec, ScopeTermSpec, Sensitivity,
};

use crate::fixtures::{
    admit_request, admitted_domain, code_observation, decision, deletion, domain, ingest, intent,
    observation, root_domain, staging, DOMAIN,
};
use crate::harness::Proof;

/// Declared tables `assert_seeded` skips: the seed leaves them empty. commentlint: allow(JUDGE)
/// The first eight have no public writer. commentlint: allow(JUDGE)
/// Ingest removes its own `artifact_ingestion_reservations` row before returning. commentlint: allow(JUDGE)
/// A purge removes its own `artifact_pending_unlinks` row once the object is unlinked. commentlint: allow(JUDGE)
const UNSEEDED_TABLES: &[&str] = &[
    "entities",
    "entity_aliases",
    "propositions",
    "predicate_schemas",
    "anchors",
    "asserted_edges",
    "relation_registry",
    "candidate_scores",
    "artifact_ingestion_reservations",
    "artifact_pending_unlinks",
];

/// Declared tables `backup` fills; `assert_seeded` skips them until a backup has run. commentlint: allow(JUDGE)
const BACKUP_TABLES: &[&str] = &["capture_pins", "capture_pin_refs"];

/// A detector-recognizable secret that causes redacted text to create a `durable_text_redactions` row.
const SECRET: &str = "sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGH12345678";

/// A newly declared table must be seeded or listed as unseeded, so a digest
/// equality cannot silently become empty-vs-empty for it.
fn assert_seeded(proof: &Proof, after_backup: bool) {
    for table in UNSEEDED_TABLES.iter().chain(BACKUP_TABLES) {
        assert!(
            KERNEL_SCHEMA_COMPONENT_NAMES.contains(table),
            "{table} is not a declared table"
        );
        assert!(
            !(UNSEEDED_TABLES.contains(table) && BACKUP_TABLES.contains(table)),
            "{table} listed as both unseeded and backup-populated"
        );
    }
    for table in KERNEL_SCHEMA_COMPONENT_NAMES {
        if UNSEEDED_TABLES.contains(table) || (!after_backup && BACKUP_TABLES.contains(table)) {
            continue;
        }
        assert!(proof.count_table(table) > 0, "{table} not seeded");
    }
}

fn max_outbox_position(proof: &Proof) -> i64 {
    proof
        .db()
        .query_row(
            "SELECT COALESCE(MAX(outbox_position),0) FROM outbox",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

struct Seeded {
    proof: Proof,
    /// Index of a pre-backup intent, replayed after restore.
    replay_index: usize,
}

/// Seeds every table `assert_seeded` checks.
fn seeded() -> Seeded {
    let mut proof = Proof::open();
    proof.commit(intent("seed"), |envelope| {
        envelope.insert_domain(root_domain())?;
        envelope.insert_domain(domain(1))?;
        Ok(String::new())
    });
    proof.commit(intent("consumer"), |envelope| {
        envelope.register_outbox_consumer("search", 10)?;
        envelope.register_outbox_consumer("retired", 10)?;
        Ok(String::new())
    });
    proof.commit(intent("slice"), |envelope| {
        envelope.insert_decision(decision(1))?;
        envelope.insert_observation(observation(2, "decision-object-1"))?;
        envelope.append_decision_event(
            "decision-1",
            DecisionEventSpec {
                event_kind: "status".to_string(),
                payload: DecisionEventPayload {
                    summary: "seeded".to_string(),
                },
                evidence_id: None,
                recorded_at: 11,
            },
        )?;
        // A secret in a term value populates `durable_text_redactions`.
        envelope.insert_scope(ScopeSpec {
            scope_id: "scope-1".to_string(),
            object_id: "scope-object-1".to_string(),
            domain_id: DOMAIN.to_string(),
            source_kind: "fixture".to_string(),
            source_id: "scope".to_string(),
            source_revision: 1,
            sensitivity: Sensitivity::Normal,
            terms: vec![ScopeTermSpec {
                dimension: "branch".to_string(),
                operator: "exact".to_string(),
                exact_value: Some(format!("feature/{SECRET}")),
                ..ScopeTermSpec::default()
            }],
        })?;
        Ok(String::new())
    });
    proof.store().rebuild_alignment().unwrap();
    proof
        .store()
        .stage_candidate(staging("run-1", "candidate-1", "name"))
        .unwrap();
    let (_, replay_index) = proof.commit(intent("admit"), |envelope| {
        let trigger = code_observation("candidate-1");
        let request = admit_request("candidate-1", &trigger.observation_id);
        envelope.insert_observation(trigger)?;
        envelope.admit_domain_candidate(request, admitted_domain("candidate-1", "name"))?;
        Ok(String::new())
    });
    // One artifact stays referenced so a backup has something to pin.
    proof
        .store()
        .ingest_artifact(ingest("kept", b"kept", Sensitivity::Normal))
        .unwrap();
    let deleted = proof
        .store()
        .ingest_artifact(ingest("deleted", b"deleted", Sensitivity::Sensitive))
        .unwrap();
    proof
        .store()
        .delete_artifact(deletion("delete", &deleted.digest))
        .unwrap();
    let purged = proof
        .store()
        .ingest_artifact(ingest("purged", b"purged", Sensitivity::Normal))
        .unwrap();
    let mut purge = deletion("purge", &purged.digest);
    purge.kind = ArtifactDeletionKind::Purge;
    purge.operator_id = Some("operator".to_string());
    purge.target_locator = Some("incident://seed".to_string());
    purge.reason = Some("seed".to_string());
    proof.store().delete_artifact(purge).unwrap();
    // `search` stays registered for the outbox proofs; `retired` is abandoned.
    proof.commit(intent("abandon"), |envelope| {
        envelope.abandon_outbox_consumer(
            "retired",
            ConsumerAbandonment {
                operator_id: "operator".to_string(),
                reason: "seed".to_string(),
                abandoned_at: 20,
                barrier_id: None,
            },
        )?;
        Ok(String::new())
    });
    proof
        .store()
        .mark_outbox_published_through(max_outbox_position(&proof), 30)
        .unwrap();
    assert_seeded(&proof, false);
    Seeded {
        proof,
        replay_index,
    }
}

fn private_dir() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    directory
}

fn backup_request(destination: &std::path::Path) -> BackupRequest {
    BackupRequest {
        destination_directory: destination.to_path_buf(),
        deadline: Instant::now() + Duration::from_secs(30),
        capture_pin_expires_at: None,
    }
}

#[test]
fn seeded_state_digest_survives_reopen() {
    let Seeded { mut proof, .. } = seeded();
    let before = proof.digest();
    let known = proof.store().known_as_of(proof.tip()).unwrap();
    proof.restart();
    assert_eq!(proof.digest(), before);
    assert_eq!(proof.store().known_as_of(proof.tip()).unwrap(), known);
}

#[test]
fn backup_and_restore_reproduce_every_table_and_the_commit_seq() {
    let Seeded {
        mut proof,
        replay_index,
    } = seeded();
    let destination = private_dir();
    let backup = proof
        .store()
        .backup(backup_request(destination.path()))
        .unwrap();
    let captured = proof.tip();
    assert_eq!(backup.captured_commit_seq, captured);
    // The fixture leaves `evidence-kept` live and invalidates `evidence-deleted` commentlint: allow(JUDGE)
    // and `evidence-purged`, so capture owes exactly the live one. Comparing commentlint: allow(JUDGE)
    // identities catches a capture that pins a stale row or misses the live one. commentlint: allow(JUDGE)
    assert_eq!(backup.evidence_refs, ["evidence-kept"]);
    let capture_pin_id = backup.capture_pin_id.clone().unwrap();
    let pinned = proof
        .db()
        .prepare(
            "SELECT evidence_id FROM capture_pin_refs WHERE capture_pin_id=?1 ORDER BY evidence_id",
        )
        .unwrap()
        .query_map([&capture_pin_id], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(pinned, ["evidence-kept"]);
    // `backup` commits its capture pins before copying, so the digest to
    // restore to is the one observed after it returns.
    let expected = proof.digest();
    assert_seeded(&proof, true);

    proof.commit(intent("after-backup"), |envelope| {
        envelope.insert_domain(domain(2))?;
        Ok(String::new())
    });
    assert_ne!(proof.digest(), expected, "positive control: state moved on");

    assert_eq!(
        proof.store().restore(&backup.destination_path).unwrap(),
        captured
    );
    assert_eq!(proof.digest(), expected);
    assert_eq!(proof.tip(), captured);
    proof.restart();
    assert_eq!(proof.digest(), expected);

    // A pre-backup intent replays from its restored receipt.
    let replayed = proof.replay(replay_index);
    assert!(replayed.replayed);
    assert_eq!(proof.digest(), expected);
}

#[test]
fn outbox_position_never_regresses_or_reuses_across_prune_and_reopen() {
    let Seeded { mut proof, .. } = seeded();
    let tip = proof.tip();
    proof.store().acknowledge_outbox("search", tip, 40).unwrap();
    let high_water = max_outbox_position(&proof);
    let pruned = proof.store().prune_outbox().unwrap();
    assert!(pruned.deleted > 0, "positive control: prune removed rows");
    proof.restart();
    proof.commit(intent("after-prune"), |envelope| {
        envelope.insert_domain(domain(3))?;
        Ok(String::new())
    });
    let positions = proof
        .db()
        .prepare("SELECT outbox_position FROM outbox ORDER BY outbox_position")
        .unwrap()
        .query_map([], |row| row.get::<_, i64>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(
        !positions.is_empty(),
        "positive control: the after-prune commit emitted outbox rows"
    );
    assert!(
        positions.iter().all(|position| *position > high_water),
        "{positions:?}"
    );
}

#[test]
fn each_restore_fault_rolls_back_to_the_pre_restore_state() {
    for &fault in RestoreFault::ALL {
        let Seeded { mut proof, .. } = seeded();
        let destination = private_dir();
        let backup = proof
            .store()
            .backup(backup_request(destination.path()))
            .unwrap();
        let restored = proof.digest();
        proof.commit(intent("after-backup"), |envelope| {
            envelope.insert_domain(domain(2))?;
            Ok(String::new())
        });
        let pre_restore = proof.digest();
        assert_ne!(pre_restore, restored);
        // Every restore fault fires before the restored family is published,
        // so recovery rolls the live family back rather than completing.
        proof
            .fault_restore(&backup.destination_path, fault)
            .assert_same(&pre_restore, &format!("{fault:?} did not roll back"));
        // The store is writable afterwards and the digest is stable.
        proof.commit(intent("after-fault"), |envelope| {
            envelope.insert_domain(domain(4))?;
            Ok(String::new())
        });
        let after = proof.digest();
        proof.restart();
        assert_eq!(proof.digest(), after, "{fault:?}");
    }
}
