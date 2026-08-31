#![cfg(feature = "test-support")]

use std::fs::{self, File, FileTimes};
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, UNIX_EPOCH};

use mc_store::kernel::{
    ArtifactErrorKind, ArtifactGcFault, ArtifactIngestRequest, CommitIntent, DomainSpec,
    KernelStore, ProviderEgress, RepositoryProvenance, Sensitivity,
};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

const HOUR_MS: i64 = 60 * 60 * 1_000;
const DAY_MS: i64 = 24 * HOUR_MS;

fn intent(key: &str, payload: &[u8]) -> CommitIntent {
    CommitIntent {
        producer: "kernel-gc-test".to_string(),
        operation_key: key.to_string(),
        request_digest: format!("{:x}", Sha256::digest(payload)),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

fn seed_domain(store: &KernelStore) {
    store
        .commit(intent("domain", b"domain"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "domain".to_string(),
                object_id: "domain-object".to_string(),
                name: "fixture".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "domain".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok("domain".to_string())
        })
        .unwrap();
}

fn request(key: &str, payload: &[u8]) -> ArtifactIngestRequest {
    ArtifactIngestRequest {
        intent: intent(key, payload),
        payload: payload.to_vec(),
        evidence_id: format!("evidence-{key}"),
        object_id: format!("evidence-object-{key}"),
        object_kind: "evidence".to_string(),
        domain_id: "domain".to_string(),
        source_kind: "repository".to_string(),
        source_id: format!("src/{key}"),
        source_revision: 1,
        media_type: "text/plain".to_string(),
        retention_class: "canonical".to_string(),
        retain_until: None,
        asserted_sensitivity: Sensitivity::Normal,
        provider_egress: ProviderEgress::RemoteAllowed,
        provenance: Some(RepositoryProvenance {
            repository_id: "repo".to_string(),
            revision: "abc123".to_string(),
        }),
    }
}

fn object_path(root: &std::path::Path, digest: &str) -> std::path::PathBuf {
    root.join("artifacts/objects")
        .join(&digest[..2])
        .join(&digest[2..])
}

fn write_object(root: &std::path::Path, digest: &str, bytes: &[u8]) {
    let path = object_path(root, digest);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(path, bytes).unwrap();
}

fn invalidate(root: &std::path::Path, evidence_id: &str, recorded_at: i64) {
    let connection = Connection::open(root.join("core.sqlite")).unwrap();
    let next: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(commit_seq),0)+1 FROM commit_log",
            [],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO commit_log(commit_seq,transaction_id,writer_epoch,producer,operation_key,request_digest,recorded_at,actor,cause)
             VALUES (?1,?2,1,'test',?2,?3,?4,'test','invalidate')",
            params![next, format!("invalidate-{evidence_id}"), "a".repeat(64), recorded_at],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE evidence_meta SET invalidated_commit_seq=?1 WHERE evidence_id=?2",
            params![next, evidence_id],
        )
        .unwrap();
}

#[test]
fn referenced_and_recently_invalidated_artifacts_survive() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let referenced = store
        .ingest_artifact(request("referenced", b"referenced"))
        .unwrap();
    let recent = store.ingest_artifact(request("recent", b"recent")).unwrap();
    invalidate(root.path(), &recent.evidence_id, 0);

    let result = store.run_staging_maintenance(13 * DAY_MS).unwrap();

    assert_eq!(result.artifact_gc.reclaimed_objects, 0);
    assert!(object_path(root.path(), &referenced.digest).exists());
    assert!(object_path(root.path(), &recent.digest).exists());
}

#[test]
fn invalidated_artifact_reclaims_after_grace_but_backward_clock_keeps_it() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = store.ingest_artifact(request("old", b"old")).unwrap();
    invalidate(root.path(), &handle.evidence_id, DAY_MS);

    assert_eq!(
        store
            .run_staging_maintenance(DAY_MS - 1)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        0
    );
    assert_eq!(
        store
            .run_staging_maintenance(16 * DAY_MS)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        1
    );
    assert!(!object_path(root.path(), &handle.digest).exists());
}

#[test]
fn retain_until_is_an_absolute_floor_not_an_extra_grace_start() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let mut retained = request("retain-until", b"retained");
    retained.retain_until = Some(20 * DAY_MS);
    let handle = store.ingest_artifact(retained).unwrap();
    invalidate(root.path(), &handle.evidence_id, 0);

    assert_eq!(
        store
            .run_staging_maintenance(20 * DAY_MS - 1)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        0
    );
    assert_eq!(
        store
            .run_staging_maintenance(20 * DAY_MS)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        1
    );
}

#[test]
fn overflowing_grace_deadline_keeps_artifact() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = store
        .ingest_artifact(request("overflow", b"overflow"))
        .unwrap();
    invalidate(root.path(), &handle.evidence_id, i64::MAX - 1);

    assert_eq!(
        store
            .run_staging_maintenance(i64::MAX)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        0
    );
    assert!(object_path(root.path(), &handle.digest).exists());
}

#[test]
fn active_capture_pin_and_pin_release_grace_protect_artifact() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = store.ingest_artifact(request("pinned", b"pinned")).unwrap();
    invalidate(root.path(), &handle.evidence_id, 0);
    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    let commit_seq: i64 = connection
        .query_row("SELECT MAX(commit_seq) FROM commit_log", [], |row| {
            row.get(0)
        })
        .unwrap();
    connection
        .execute(
            "INSERT INTO capture_pins(capture_pin_id,pin_kind,owner_id,commit_seq,lease_epoch,writer_epoch,created_at,expires_at)
             VALUES ('pin','backup','test',?1,?2,?2,0,?3)",
            params![commit_seq, i64::try_from(store.lease_epoch()).unwrap(), 30 * DAY_MS],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO capture_pin_refs(capture_pin_id,evidence_id,expires_at) VALUES ('pin',?1,?2)",
            params![handle.evidence_id, 30 * DAY_MS],
        )
        .unwrap();
    drop(connection);

    assert_eq!(
        store
            .run_staging_maintenance(20 * DAY_MS)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        0
    );
    store.release_capture_pin("pin", 20 * DAY_MS).unwrap();
    assert_eq!(
        store
            .run_staging_maintenance(33 * DAY_MS)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        0
    );
    assert_eq!(
        store
            .run_staging_maintenance(35 * DAY_MS)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        1
    );
    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM capture_pins WHERE capture_pin_id='pin'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM capture_pin_refs WHERE capture_pin_id='pin'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
}

#[test]
fn same_maintenance_pass_does_not_reclaim_just_reaped_pin() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = store.ingest_artifact(request("reaped", b"reaped")).unwrap();
    invalidate(root.path(), &handle.evidence_id, 0);
    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    let commit_seq: i64 = connection
        .query_row("SELECT MAX(commit_seq) FROM commit_log", [], |row| {
            row.get(0)
        })
        .unwrap();
    connection
        .execute(
            "INSERT INTO capture_pins(capture_pin_id,pin_kind,owner_id,commit_seq,lease_epoch,writer_epoch,created_at,expires_at)
             VALUES ('stale-pin','backup','test',?1,?2,?2,0,1)",
            params![commit_seq, i64::try_from(store.lease_epoch()).unwrap()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO capture_pin_refs(capture_pin_id,evidence_id,expires_at)
             VALUES ('stale-pin',?1,1)",
            [&handle.evidence_id],
        )
        .unwrap();
    drop(connection);

    assert_eq!(
        store
            .run_staging_maintenance(20 * DAY_MS)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        0
    );
    assert!(object_path(root.path(), &handle.digest).exists());
    assert_eq!(
        store
            .run_staging_maintenance(35 * DAY_MS)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        1
    );
}

#[test]
fn reservation_honors_stored_and_renewed_lease_expiry() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    let payload = b"reserved";
    let digest = format!("{:x}", Sha256::digest(payload));
    write_object(root.path(), &digest, payload);
    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    connection.execute(
        "INSERT INTO artifact_ingestion_reservations(reservation_id,artifact_digest,artifact_reference,state,writer_epoch,created_at,heartbeat_at,lease_expires_at)
         VALUES ('reservation',?1,?2,'Live',?3,0,0,?4)",
        params![digest, format!("objects/{}/{}", &digest[..2], &digest[2..]), i64::try_from(store.lease_epoch()).unwrap(), HOUR_MS],
    ).unwrap();
    drop(connection);

    assert_eq!(
        store
            .run_staging_maintenance(59 * 60 * 1_000)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        0
    );
    Connection::open(root.path().join("core.sqlite"))
        .unwrap()
        .execute(
            "UPDATE artifact_ingestion_reservations
             SET heartbeat_at=?1,lease_expires_at=?2 WHERE reservation_id='reservation'",
            params![59 * 60 * 1_000, 2 * HOUR_MS],
        )
        .unwrap();
    assert_eq!(
        store
            .run_staging_maintenance(61 * 60 * 1_000)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        0
    );
    assert_eq!(
        store
            .run_staging_maintenance(2 * HOUR_MS + 1)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        1
    );
}

#[test]
fn re_reference_between_snapshot_and_recheck_survives() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = b"race";
    let old = store.ingest_artifact(request("old-race", payload)).unwrap();
    invalidate(root.path(), &old.evidence_id, 0);

    let result = store
        .run_staging_maintenance_with_hook_for_test(15 * DAY_MS, || {
            store.ingest_artifact(request("new-race", payload)).unwrap();
        })
        .unwrap();

    assert_eq!(result.artifact_gc.reclaimed_objects, 0);
    assert!(object_path(root.path(), &old.digest).exists());
}

#[test]
fn reclaiming_blocks_delayed_commit_and_startup_converges() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = b"crash";
    let old = store
        .ingest_artifact(request("crash-old", payload))
        .unwrap();
    invalidate(root.path(), &old.evidence_id, 0);

    assert!(store
        .run_staging_maintenance_with_fault_for_test(15 * DAY_MS, ArtifactGcFault::AfterReclaiming)
        .is_err());
    let error = store
        .ingest_artifact(request("delayed", payload))
        .unwrap_err();
    assert_eq!(error.kind(), ArtifactErrorKind::ReclaimInProgress);
    assert!(error.is_retriable());
    assert!(object_path(root.path(), &old.digest).exists());
    drop(store);

    let _reopened = KernelStore::open(root.path()).unwrap();
    assert!(!object_path(root.path(), &old.digest).exists());
}

#[test]
fn pending_purge_unlinks_even_when_reference_is_live() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = store.ingest_artifact(request("purge", b"purge")).unwrap();
    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    let commit_seq: i64 = connection
        .query_row("SELECT MAX(commit_seq) FROM commit_log", [], |row| {
            row.get(0)
        })
        .unwrap();
    let reference = format!("objects/{}/{}", &handle.digest[..2], &handle.digest[2..]);
    connection
        .execute(
            "INSERT INTO artifact_purge_tombstones(artifact_digest,artifact_reference,operator_id,reason,purged_at,commit_seq)
             VALUES (?1,?2,'operator','secret',1,?3)",
            params![handle.digest, reference, commit_seq],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO artifact_pending_unlinks(artifact_digest,artifact_reference,created_at)
             VALUES (?1,?2,1)",
            params![handle.digest, reference],
        )
        .unwrap();
    drop(connection);

    assert_eq!(
        store
            .run_staging_maintenance(1)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        1
    );
    assert!(!object_path(root.path(), &handle.digest).exists());
    assert_eq!(
        Connection::open(root.path().join("core.sqlite"))
            .unwrap()
            .query_row("SELECT COUNT(*) FROM artifact_pending_unlinks", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}

#[test]
fn reclaim_frees_capacity_for_next_write() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open_with_artifact_cap_for_test(root.path(), 4).unwrap();
    seed_domain(&store);
    let old = store.ingest_artifact(request("full", b"1234")).unwrap();
    invalidate(root.path(), &old.evidence_id, 0);

    assert_eq!(
        store
            .ingest_artifact(request("blocked", b"x"))
            .unwrap_err()
            .kind(),
        ArtifactErrorKind::Capacity
    );
    store.run_staging_maintenance(15 * DAY_MS).unwrap();
    store
        .ingest_artifact(request("replacement", b"5678"))
        .unwrap();
    assert_eq!(store.artifact_budget_facts().unwrap().usage_bytes, 4);
}

#[test]
fn orphan_mtime_grace_and_budget_facts_are_reconciled_from_objects() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open_with_artifact_cap_for_test(root.path(), 10).unwrap();
    let fresh_digest = "a".repeat(64);
    let old_digest = "b".repeat(64);
    for (digest, bytes) in [
        (&fresh_digest, b"12".as_slice()),
        (&old_digest, b"345678".as_slice()),
    ] {
        write_object(root.path(), digest, bytes);
    }
    File::options()
        .write(true)
        .open(object_path(root.path(), &old_digest))
        .unwrap()
        .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1)))
        .unwrap();

    let facts = store.facts(2 * HOUR_MS).unwrap();
    assert_eq!(facts.artifact_budget.usage_bytes, 8);
    assert_eq!(facts.artifact_budget.cap_bytes, 10);
    assert!(facts.artifact_budget.warn);
    assert_eq!(
        store
            .run_staging_maintenance(2 * HOUR_MS)
            .unwrap()
            .artifact_gc
            .reclaimed_bytes,
        6
    );
    assert!(object_path(root.path(), &fresh_digest).exists());
    assert!(!object_path(root.path(), &old_digest).exists());
    assert_eq!(
        store
            .facts(2 * HOUR_MS)
            .unwrap()
            .artifact_budget
            .usage_bytes,
        2
    );
}

fn seed_pending_unlink(root: &std::path::Path, digest: &str) {
    let connection = Connection::open(root.join("core.sqlite")).unwrap();
    let commit_seq: i64 = connection
        .query_row("SELECT MAX(commit_seq) FROM commit_log", [], |row| {
            row.get(0)
        })
        .unwrap();
    let reference = format!("objects/{}/{}", &digest[..2], &digest[2..]);
    connection
        .execute(
            "INSERT INTO artifact_purge_tombstones(artifact_digest,artifact_reference,operator_id,reason,purged_at,commit_seq)
             VALUES (?1,?2,'operator','secret',1,?3)",
            params![digest, reference, commit_seq],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO artifact_pending_unlinks(artifact_digest,artifact_reference,created_at)
             VALUES (?1,?2,1)",
            params![digest, reference],
        )
        .unwrap();
}

/// A directory where the object file belongs makes `unlink_artifact` fail for that
/// digest alone.
fn poison_object_path(root: &std::path::Path, digest: &str) {
    let path = object_path(root, digest);
    fs::create_dir_all(&path).unwrap();
    fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn one_unreclaimable_candidate_does_not_starve_the_rest() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open_with_artifact_cap_for_test(root.path(), 1024).unwrap();
    seed_domain(&store);
    let poison_digest = "a".repeat(64);
    let orphan_digest = "b".repeat(64);
    poison_object_path(root.path(), &poison_digest);
    seed_pending_unlink(root.path(), &poison_digest);
    write_object(root.path(), &orphan_digest, b"orphan");
    File::options()
        .write(true)
        .open(object_path(root.path(), &orphan_digest))
        .unwrap()
        .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1)))
        .unwrap();

    let result = store.run_staging_maintenance(2 * HOUR_MS).unwrap();

    assert_eq!(result.artifact_gc.failed_candidates, 1);
    assert_eq!(result.artifact_gc.reclaimed_objects, 1);
    assert_eq!(result.artifact_gc.reclaimed_bytes, 6);
    assert!(!object_path(root.path(), &orphan_digest).exists());
    assert!(object_path(root.path(), &poison_digest).exists());
}

#[test]
fn an_unreclaimable_candidate_does_not_block_store_open() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let poison_digest = "c".repeat(64);
    poison_object_path(root.path(), &poison_digest);
    seed_pending_unlink(root.path(), &poison_digest);
    drop(store);

    let reopened = KernelStore::open(root.path()).unwrap();
    assert_eq!(
        reopened
            .run_staging_maintenance(HOUR_MS)
            .unwrap()
            .artifact_gc
            .failed_candidates,
        1
    );
}

#[test]
fn reclaimed_digests_stop_being_gc_candidates() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = store
        .ingest_artifact(request("settled", b"settled"))
        .unwrap();
    invalidate(root.path(), &handle.evidence_id, 0);

    assert_eq!(
        store
            .run_staging_maintenance(15 * DAY_MS)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        1
    );
    assert!(!object_path(root.path(), &handle.digest).exists());

    // A digest whose bytes and control rows are already gone must not re-enter the
    // write path on every later pass.
    let reservations_before: i64 = Connection::open(root.path().join("core.sqlite"))
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM artifact_ingestion_reservations",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let commits_before: i64 = Connection::open(root.path().join("core.sqlite"))
        .unwrap()
        .query_row("SELECT COUNT(*) FROM commit_log", [], |row| row.get(0))
        .unwrap();

    for pass in 1..=3 {
        let result = store.run_staging_maintenance(15 * DAY_MS + pass).unwrap();
        assert_eq!(result.artifact_gc.reclaimed_objects, 0);
        assert_eq!(result.artifact_gc.failed_candidates, 0);
    }

    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM artifact_ingestion_reservations",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        reservations_before
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM commit_log", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        commits_before
    );
}

#[test]
fn resumed_purge_sweeps_digest_temps() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = store.ingest_artifact(request("temps", b"temps")).unwrap();
    seed_pending_unlink(root.path(), &handle.digest);
    let leftover = root
        .path()
        .join("artifacts/tmp")
        .join(format!(".artifact-{}-7.tmp", handle.digest));
    fs::write(&leftover, b"temps").unwrap();

    assert_eq!(
        store
            .run_staging_maintenance(HOUR_MS)
            .unwrap()
            .artifact_gc
            .reclaimed_objects,
        1
    );

    assert!(!object_path(root.path(), &handle.digest).exists());
    assert!(
        !leftover.exists(),
        "resumed purge left plaintext under artifacts/tmp"
    );
}
