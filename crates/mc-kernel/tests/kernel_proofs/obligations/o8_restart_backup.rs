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

use mc_kernel::{BackupRequest, RestoreFault, Sensitivity};

use crate::fixtures::{
    admit_request, admitted_domain, code_observation, decision, deletion, domain, ingest, intent,
    observation, root_domain, staging,
};
use crate::harness::Proof;

/// Tables the seed must populate so the digest comparison is not vacuous
/// over empty tables.
const SEEDED_TABLES: [&str; 20] = [
    "commit_log",
    "change_event",
    "outbox",
    "outbox_publication",
    "operation_receipts",
    "outbox_consumers",
    "deletion_backfill_barriers",
    "deletion_backfill_barrier_consumers",
    "object_registry",
    "domains",
    "evidence_meta",
    "extraction_runs",
    "candidates",
    "admission_decisions",
    "decisions",
    "observations",
    "observation_dependencies",
    "alignment_projection",
    "alignment_projection_state",
    "capture_pins",
];

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

/// Seeds every table group the kernel writes through its public API.
fn seeded() -> Seeded {
    let mut proof = Proof::open();
    proof.commit(intent("seed"), |envelope| {
        envelope.insert_domain(root_domain())?;
        envelope.insert_domain(domain(1))?;
        Ok(String::new())
    });
    proof.commit(intent("consumer"), |envelope| {
        envelope.register_outbox_consumer("search", 10)?;
        Ok(String::new())
    });
    proof.commit(intent("slice"), |envelope| {
        envelope.insert_decision(decision(1))?;
        envelope.insert_observation(observation(2, "decision-object-1"))?;
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
    // One artifact stays referenced so a backup has something to pin and the
    // digest covers a live evidence row beside the deleted one.
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
    proof
        .store()
        .mark_outbox_published_through(max_outbox_position(&proof), 30)
        .unwrap();
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
    for table in SEEDED_TABLES
        .iter()
        .filter(|table| **table != "capture_pins")
    {
        assert!(proof.count_table(table) > 0, "{table} not seeded");
    }
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
    assert!(backup.capture_pin_id.is_some());
    // `backup` commits its capture pins before copying, so the digest to
    // restore to is the one observed after it returns.
    let expected = proof.digest();
    for table in SEEDED_TABLES {
        assert!(proof.count_table(table) > 0, "{table} not seeded");
    }

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
        positions.iter().all(|position| *position > high_water),
        "{positions:?}"
    );
}

#[test]
fn each_restore_fault_rolls_back_to_the_pre_restore_state() {
    for fault in [
        RestoreFault::BeforeDisplace,
        RestoreFault::AfterDisplace,
        RestoreFault::RecoveryFailure,
    ] {
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
