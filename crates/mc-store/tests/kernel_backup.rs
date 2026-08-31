#![cfg(feature = "test-support")]

use std::cell::Cell;
use std::fs::{self, OpenOptions};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
use mc_store::kernel::filesystem_is_unsafe_for_test;
use mc_store::kernel::schema::apply_kernel_connection_profile;
use mc_store::kernel::{
    owner_is_current_for_test, sensitivity_bearing_tables_for_test,
    verify_backup_with_deadline_for_test, BackupRequest, CommitIntent, DomainSpec, KernelError,
    KernelStore, RestoreFault, Sensitivity,
};
use rusqlite::{params, Connection};

fn intent(key: &str) -> CommitIntent {
    CommitIntent {
        producer: "kernel-backup-test".to_string(),
        operation_key: key.to_string(),
        request_digest: "a".repeat(64),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

fn domain(index: i64, sensitivity: Sensitivity) -> DomainSpec {
    DomainSpec {
        domain_id: format!("domain-{index}"),
        object_id: format!("object-{index}"),
        name: format!("name-{index}"),
        source_kind: "fixture".to_string(),
        source_id: format!("source-{index}"),
        source_revision: index,
        sensitivity,
    }
}

fn private_dir() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    directory
}

fn request(destination: &Path) -> BackupRequest {
    BackupRequest {
        destination_directory: destination.to_path_buf(),
        deadline: Instant::now() + Duration::from_secs(30),
        capture_pin_expires_at: None,
    }
}

fn insert_domain(store: &KernelStore, index: i64, sensitivity: Sensitivity) -> i64 {
    store
        .commit(intent(&format!("domain-{index}")), |envelope| {
            envelope.insert_domain(domain(index, sensitivity))?;
            Ok("stored".to_string())
        })
        .unwrap()
        .commit_seq
}

fn inspect(root: &Path) -> Connection {
    Connection::open(root.join("core.sqlite")).unwrap()
}

fn seed_evidence(root: &Path, evidence_id: &str, sensitivity: &str) {
    let mut connection = inspect(root);
    apply_kernel_connection_profile(&mut connection, 5_000).unwrap();
    let tx = connection.transaction().unwrap();
    let epoch: i64 = tx
        .query_row(
            "SELECT writer_epoch FROM writer_fence WHERE id=0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    tx.execute(
        "INSERT INTO commit_log(
             transaction_id,writer_epoch,producer,operation_key,request_digest,
             recorded_at,actor,cause
         ) VALUES (?1,?2,'fixture',?1,'digest',1,'test','evidence')",
        params![format!("evidence-{evidence_id}"), epoch],
    )
    .unwrap();
    let commit_seq = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO object_registry(
             object_id,object_kind,domain_id,source_kind,source_id,source_revision,
             created_commit_seq,sensitivity_class
         ) VALUES (?1,'evidence','domain-1','fixture',?1,1,?2,?3)",
        params![
            format!("evidence-object-{evidence_id}"),
            commit_seq,
            sensitivity
        ],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO evidence_meta(
             evidence_id,object_id,artifact_reference,artifact_digest,byte_length,media_type,
             retention_class,provider_egress_class,redaction_metadata,created_commit_seq,
             sensitivity_class
         ) VALUES (?1,?2,'local','digest',1,'text/plain','durable','local',X'',?3,?4)",
        params![
            evidence_id,
            format!("evidence-object-{evidence_id}"),
            commit_seq,
            sensitivity,
        ],
    )
    .unwrap();
    tx.commit().unwrap();
}

fn destination_entries(path: &Path) -> Vec<PathBuf> {
    fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
struct RestoreOracle {
    domains: String,
    registry: String,
    changes: String,
    outbox: String,
    receipts: String,
    consumers: String,
    commit_tip: i64,
}

fn restore_oracle(root: &Path) -> RestoreOracle {
    let connection = inspect(root);
    RestoreOracle {
        domains: connection
            .query_row(
                "SELECT COALESCE(group_concat(row_value, ','),'') FROM (
                     SELECT domain_id || ':' || object_id || ':' || name || ':' ||
                            created_commit_seq || ':' || IFNULL(invalidated_commit_seq,'null') || ':' ||
                            IFNULL(superseded_by,'null') || ':' || sensitivity_class AS row_value
                     FROM domains ORDER BY domain_id
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap(),
        registry: connection
            .query_row(
                "SELECT COALESCE(group_concat(row_value, ','),'') FROM (
                     SELECT object_id || ':' || object_kind || ':' || domain_id || ':' ||
                            source_kind || ':' || source_id || ':' || source_revision || ':' ||
                            created_commit_seq || ':' || IFNULL(invalidated_commit_seq,'null') || ':' ||
                            IFNULL(superseded_by,'null') || ':' || sensitivity_class AS row_value
                     FROM object_registry ORDER BY object_id
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap(),
        changes: connection
            .query_row(
                "SELECT COALESCE(group_concat(row_value, ','),'') FROM (
                     SELECT commit_seq || ':' || ordinal || ':' || object_id || ':' ||
                            change_kind || ':' || IFNULL(source_span_id,'null') || ':' ||
                            idempotency_key || ':' || IFNULL(hex(payload),'null') AS row_value
                     FROM change_event ORDER BY commit_seq,ordinal
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap(),
        outbox: connection
            .query_row(
                "SELECT COALESCE(group_concat(row_value, ','),'') FROM (
                     SELECT outbox_position || ':' || commit_seq || ':' || ordinal || ':' ||
                            object_id || ':' || object_kind || ':' || source_kind || ':' ||
                            source_id || ':' || source_revision || ':' || sensitivity_class || ':' ||
                            hex(payload) || ':' || created_at || ':' ||
                            IFNULL(published_at,'null') AS row_value
                     FROM outbox ORDER BY outbox_position
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap(),
        receipts: connection
            .query_row(
                "SELECT COALESCE(group_concat(row_value, ','),'') FROM (
                     SELECT receipt_id || ':' || producer || ':' || operation_key || ':' ||
                            request_digest || ':' || IFNULL(commit_seq,'null') || ':' ||
                            result_payload || ':' || created_at AS row_value
                     FROM operation_receipts ORDER BY receipt_id
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap(),
        consumers: connection
            .query_row(
                "SELECT COALESCE(group_concat(row_value, ','),'') FROM (
                     SELECT consumer_id || ':' || checkpoint_commit_seq || ':' || updated_at AS row_value
                     FROM outbox_consumers ORDER BY consumer_id
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap(),
        commit_tip: connection
            .query_row(
                "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
                [],
                |row| row.get(0),
            )
            .unwrap(),
    }
}

fn unix_time_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

#[test]
fn fresh_store_backup_has_zero_tip_and_no_capture_pin() {
    let root = private_dir();
    let destination = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    let backup = store.backup(request(destination.path())).unwrap();
    assert_eq!(backup.captured_commit_seq, 0);
    assert!(backup.evidence_refs.is_empty());
    assert_eq!(backup.capture_pin_id, None);
    assert_eq!(destination_entries(destination.path()).len(), 1);
}

#[test]
fn backup_restores_exact_snapshot_and_reclaims_writer_fence() {
    let root = private_dir();
    let destination = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    assert_eq!(insert_domain(&store, 1, Sensitivity::Normal), 1);
    store
        .commit(intent("consumer"), |envelope| {
            envelope.register_outbox_consumer("restore-oracle", 1)?;
            Ok("registered".to_string())
        })
        .unwrap();
    let expected = store.known_as_of(2).unwrap();
    let backup = store.backup(request(destination.path())).unwrap();
    let expected_oracle = restore_oracle(root.path());
    assert_eq!(backup.captured_commit_seq, 2);
    assert!(backup
        .destination_path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .contains("-2-"));
    assert_eq!(
        fs::metadata(&backup.destination_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    insert_domain(&store, 2, Sensitivity::Normal);
    assert_eq!(
        store
            .restore_with_hook_for_test(&backup.destination_path, || {
                assert!(!root.path().join("core.sqlite").exists());
                assert_eq!(
                    fs::metadata(root.path().join("core.sqlite.mc-restore"))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
                assert_eq!(
                    KernelStore::open(root.path()).unwrap_err(),
                    KernelError::Held
                );
            })
            .unwrap(),
        2
    );
    assert_eq!(store.known_as_of(2).unwrap(), expected);
    assert_eq!(restore_oracle(root.path()), expected_oracle);
    assert_eq!(
        store.known_as_of(3).unwrap_err(),
        KernelError::FutureSnapshot
    );
    assert_eq!(insert_domain(&store, 3, Sensitivity::Normal), 3);
    assert!(!root.path().join("core.sqlite.mc-restore").exists());
    assert_eq!(
        KernelStore::open(root.path()).unwrap_err(),
        KernelError::Held
    );
}

#[test]
fn queued_writer_waits_for_backup_coordinator_then_proceeds() {
    let root = private_dir();
    let destination = private_dir();
    let store = Arc::new(KernelStore::open(root.path()).unwrap());
    insert_domain(&store, 1, Sensitivity::Normal);
    let backup_store = Arc::clone(&store);
    let (locked_tx, locked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let backup_destination = destination.path().to_path_buf();
    let backup_thread = std::thread::spawn(move || {
        backup_store.backup_with_hook_for_test(request(&backup_destination), || {
            locked_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        })
    });
    locked_rx.recv().unwrap();

    let writer_store = Arc::clone(&store);
    let (started_tx, started_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let writer_thread = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        done_tx
            .send(insert_domain(&writer_store, 2, Sensitivity::Normal))
            .unwrap();
    });
    started_rx.recv().unwrap();
    assert!(matches!(
        done_rx.recv_timeout(Duration::from_millis(300)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    release_tx.send(()).unwrap();
    assert!(backup_thread.join().unwrap().is_ok());
    assert_eq!(done_rx.recv().unwrap(), 2);
    writer_thread.join().unwrap();
}

#[test]
fn timeout_and_pre_publish_fault_leave_no_artifacts_and_retry_succeeds() {
    let root = private_dir();
    let destination = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    // The hook sleeps past the 200 ms deadline, so expiry occurs mid-flight.
    // `hook_ran` fails the test if `secure_destination` skips the hook.
    let expired = BackupRequest {
        destination_directory: destination.path().to_path_buf(),
        deadline: Instant::now() + Duration::from_millis(200),
        capture_pin_expires_at: None,
    };
    let hook_ran = Cell::new(false);
    assert_eq!(
        store
            .backup_with_hook_for_test(expired, || {
                hook_ran.set(true);
                let entries = destination_entries(destination.path());
                assert_eq!(entries.len(), 1);
                assert!(entries[0]
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .ends_with(".tmp"));
                std::thread::sleep(Duration::from_millis(250));
            })
            .unwrap_err(),
        KernelError::Deadline
    );
    assert!(hook_ran.get(), "mid-flight assertions never executed");
    assert!(destination_entries(destination.path()).is_empty());
    assert_eq!(
        store
            .backup_with_fault_before_rename_for_test(request(destination.path()))
            .unwrap_err(),
        KernelError::Fault
    );
    assert!(destination_entries(destination.path()).is_empty());
    assert!(store.backup(request(destination.path())).is_ok());
    assert_eq!(destination_entries(destination.path()).len(), 1);
}

#[test]
fn backup_deadline_interrupts_verification_sql() {
    let root = private_dir();
    let destination = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    let backup = store.backup(request(destination.path())).unwrap();

    assert_eq!(
        verify_backup_with_deadline_for_test(
            &backup.destination_path,
            backup.captured_commit_seq,
            Instant::now() - Duration::from_millis(1),
        )
        .unwrap_err(),
        KernelError::Deadline
    );
}

#[test]
fn backup_name_collision_preserves_preexisting_file() {
    let root = private_dir();
    let destination = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    let final_name = "preexisting.sqlite";
    let final_path = destination.path().join(final_name);
    let original = b"must remain unchanged";
    fs::write(&final_path, original).unwrap();
    fs::set_permissions(&final_path, fs::Permissions::from_mode(0o600)).unwrap();

    assert_eq!(
        store
            .backup_with_final_name_for_test(request(destination.path()), final_name)
            .unwrap_err(),
        KernelError::Io
    );
    assert_eq!(fs::read(&final_path).unwrap(), original);
    assert_eq!(destination_entries(destination.path()), [final_path]);
}

#[test]
fn evidence_manifest_pin_release_and_stale_reap_are_typed() {
    let root = private_dir();
    let destination = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    let normal_backup = store.backup(request(destination.path())).unwrap();
    assert_eq!(normal_backup.max_sensitivity, Sensitivity::Normal);
    drop(store);
    seed_evidence(root.path(), "z-evidence", "sensitive");
    seed_evidence(root.path(), "a-evidence", "normal");
    let store = KernelStore::open(root.path()).unwrap();
    assert_eq!(
        store
            .backup_with_fault_before_rename_for_test(request(destination.path()))
            .unwrap_err(),
        KernelError::Fault
    );
    assert_eq!(
        inspect(root.path())
            .query_row("SELECT COUNT(*) FROM capture_pins", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert_eq!(
        inspect(root.path())
            .query_row("SELECT COUNT(*) FROM capture_pin_refs", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    let backup = store.backup(request(destination.path())).unwrap();
    assert_eq!(
        backup.evidence_refs,
        ["a-evidence".to_string(), "z-evidence".to_string()]
    );
    assert_eq!(backup.max_sensitivity, Sensitivity::Sensitive);
    let pin = backup.capture_pin_id.unwrap();
    assert_eq!(
        inspect(root.path())
            .query_row(
                "SELECT COUNT(*) FROM capture_pin_refs
                 WHERE capture_pin_id=?1 AND released_at IS NULL",
                [&pin],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        2
    );
    let mut pinned_connection = inspect(root.path());
    apply_kernel_connection_profile(&mut pinned_connection, 5_000).unwrap();
    assert!(pinned_connection
        .execute(
            "DELETE FROM evidence_meta WHERE evidence_id='a-evidence'",
            [],
        )
        .is_err());
    store.release_capture_pin(&pin, 10).unwrap();
    assert_eq!(
        inspect(root.path())
            .query_row(
                "SELECT COUNT(*) FROM capture_pin_refs
                 WHERE capture_pin_id=?1 AND released_at IS NULL",
                [&pin],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    pinned_connection
        .execute(
            "DELETE FROM evidence_meta WHERE evidence_id='a-evidence'",
            [],
        )
        .unwrap();
    drop(pinned_connection);

    assert_eq!(
        store
            .backup(BackupRequest {
                capture_pin_expires_at: Some(0),
                ..request(destination.path())
            })
            .unwrap_err(),
        KernelError::InvalidInput
    );
    let now = unix_time_ms();
    let stale = store
        .backup(BackupRequest {
            capture_pin_expires_at: Some(now + 60_000),
            ..request(destination.path())
        })
        .unwrap()
        .capture_pin_id
        .unwrap();
    let non_stale = store
        .backup(BackupRequest {
            capture_pin_expires_at: Some(now + 120_000),
            ..request(destination.path())
        })
        .unwrap()
        .capture_pin_id
        .unwrap();
    assert_eq!(
        inspect(root.path())
            .query_row(
                "SELECT expires_at FROM capture_pins WHERE capture_pin_id=?1",
                [&non_stale],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        now + 120_000
    );
    let defaulted = store
        .backup(request(destination.path()))
        .unwrap()
        .capture_pin_id
        .unwrap();
    let default_lifetime: i64 = inspect(root.path())
        .query_row(
            "SELECT expires_at-created_at FROM capture_pins WHERE capture_pin_id=?1",
            [&defaulted],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(default_lifetime, 24 * 60 * 60 * 1_000);
    drop(store);
    let reopened = KernelStore::open(root.path()).unwrap();
    reopened
        .run_capture_pin_maintenance_for_test(now + 90_000)
        .unwrap();
    assert!(inspect(root.path())
        .query_row(
            "SELECT released_at IS NOT NULL FROM capture_pins WHERE capture_pin_id=?1",
            [&stale],
            |row| row.get::<_, bool>(0),
        )
        .unwrap());
    for live in [&non_stale, &defaulted] {
        assert!(!inspect(root.path())
            .query_row(
                "SELECT released_at IS NOT NULL FROM capture_pins WHERE capture_pin_id=?1",
                [live],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
    }
    assert_eq!(
        inspect(root.path())
            .query_row(
                "SELECT COUNT(*) FROM capture_pin_refs WHERE capture_pin_id=?1",
                [&stale],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
}

#[test]
fn staging_sensitivity_marks_backup_sensitive() {
    let root = private_dir();
    let destination = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    store
        .stage_candidate(mc_store::kernel::StagingCandidateSpec {
            extraction_run_id: "sensitive-run".to_string(),
            candidate_id: "sensitive-candidate".to_string(),
            extractor: "fixture".to_string(),
            source_kind: "fixture".to_string(),
            source_id: "source".to_string(),
            source_revision: 1,
            candidate_kind: "fact".to_string(),
            payload: "payload".to_string(),
            provenance: None,
            recorded_at: 1,
            lease_expires_at: 2,
        })
        .unwrap();
    assert_eq!(
        store
            .backup(request(destination.path()))
            .unwrap()
            .max_sensitivity,
        Sensitivity::Sensitive
    );
}

#[test]
fn unsafe_destinations_and_restore_sources_are_rejected_before_live_touch() {
    let root = private_dir();
    let destination = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);

    let file_destination = destination.path().join("file");
    fs::write(&file_destination, b"not a directory").unwrap();
    assert_eq!(
        store.backup(request(&file_destination)).unwrap_err(),
        KernelError::UnsafeDestination
    );
    let symlink_destination = destination.path().join("link");
    std::os::unix::fs::symlink(root.path(), &symlink_destination).unwrap();
    assert_eq!(
        store.backup(request(&symlink_destination)).unwrap_err(),
        KernelError::UnsafeDestination
    );
    let broad_destination = private_dir();
    fs::set_permissions(broad_destination.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        store.backup(request(broad_destination.path())).unwrap_err(),
        KernelError::UnsafeDestination
    );
    #[cfg(target_os = "linux")]
    {
        assert!(filesystem_is_unsafe_for_test(0x6969));
        assert!(filesystem_is_unsafe_for_test(0x6573_5546));
        assert!(filesystem_is_unsafe_for_test(0x1234_5678));
        assert!(!filesystem_is_unsafe_for_test(0x794c_7630));
    }
    #[cfg(target_os = "macos")]
    {
        for remote in ["nfs", "smbfs", "osxfuse", "macfuse", "webdav"] {
            assert!(mc_store::kernel::filesystem_name_is_unsafe_for_test(remote));
        }
        for local in ["apfs", "hfs", "tmpfs"] {
            assert!(!mc_store::kernel::filesystem_name_is_unsafe_for_test(local));
        }
    }
    let current_uid = rustix::process::geteuid().as_raw();
    assert!(owner_is_current_for_test(current_uid));
    assert!(!owner_is_current_for_test(current_uid.wrapping_add(1)));

    let backup = store.backup(request(destination.path())).unwrap();
    let source_symlink = destination.path().join("source-link.sqlite");
    std::os::unix::fs::symlink(&backup.destination_path, &source_symlink).unwrap();
    assert_eq!(
        store.restore(&source_symlink).unwrap_err(),
        KernelError::InvalidRestore
    );
    assert_eq!(
        store.restore(destination.path()).unwrap_err(),
        KernelError::InvalidRestore
    );
    let corrupt = destination.path().join(
        backup
            .destination_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .replace(".sqlite", "-corrupt.sqlite"),
    );
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    std::io::Write::write_all(&mut options.open(&corrupt).unwrap(), b"truncated").unwrap();
    let hook_called = Cell::new(false);
    assert_eq!(
        store
            .restore_with_hook_for_test(&corrupt, || hook_called.set(true))
            .unwrap_err(),
        KernelError::InvalidRestore
    );
    assert!(!hook_called.get());
    assert_eq!(store.known_as_of(1).unwrap().tip, 1);
    assert_eq!(insert_domain(&store, 2, Sensitivity::Normal), 2);
}

#[test]
fn failed_restore_after_displacement_recovers_live_family() {
    let root = private_dir();
    let destination = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    let backup = store.backup(request(destination.path())).unwrap();
    insert_domain(&store, 2, Sensitivity::Normal);
    assert_eq!(
        store
            .restore_with_fault_for_test(&backup.destination_path, RestoreFault::AfterDisplace,)
            .unwrap_err(),
        KernelError::Fault
    );
    assert_eq!(store.known_as_of(2).unwrap().tip, 2);
    assert_eq!(insert_domain(&store, 3, Sensitivity::Normal), 3);
    assert!(!root.path().join("core.sqlite.mc-restore").exists());
}

#[test]
fn restore_rejects_lost_fence_before_displacement() {
    let root = private_dir();
    let destination = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    let backup = store.backup(request(destination.path())).unwrap();
    insert_domain(&store, 2, Sensitivity::Normal);
    store.invalidate_writer_fence_for_test().unwrap();

    assert_eq!(
        store.restore(&backup.destination_path).unwrap_err(),
        KernelError::FenceLost
    );
    assert_eq!(restore_oracle(root.path()).commit_tip, 2);
    assert!(!root.path().join("core.sqlite.mc-restore").exists());
    assert!(!fs::read_dir(root.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".mc-restore-")));
}

#[test]
fn restore_into_fresh_store_family_allows_immediate_mutation() {
    let source_root = private_dir();
    let destination = private_dir();
    let source = KernelStore::open(source_root.path()).unwrap();
    insert_domain(&source, 1, Sensitivity::Normal);
    let backup = source.backup(request(destination.path())).unwrap();

    let fresh_root = private_dir();
    assert!(!fresh_root.path().join("leases").exists());
    let initial = KernelStore::open(fresh_root.path()).unwrap();
    let initial_epoch = initial.lease_epoch();
    drop(initial);
    let fresh = KernelStore::open(fresh_root.path()).unwrap();
    assert_ne!(fresh.lease_epoch(), initial_epoch);
    let source_epoch: i64 = Connection::open(&backup.destination_path)
        .unwrap()
        .query_row(
            "SELECT writer_epoch FROM writer_fence WHERE id=0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_ne!(source_epoch, i64::try_from(fresh.lease_epoch()).unwrap());
    let renamed = destination.path().join("owner-only-renamed.sqlite");
    fs::rename(&backup.destination_path, &renamed).unwrap();
    assert_eq!(fresh.restore(&renamed).unwrap(), 1);
    let restored_epoch: i64 = inspect(fresh_root.path())
        .query_row(
            "SELECT writer_epoch FROM writer_fence WHERE id=0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(restored_epoch, i64::try_from(fresh.lease_epoch()).unwrap());
    assert_eq!(insert_domain(&fresh, 2, Sensitivity::Normal), 2);
}

#[test]
fn unrecoverable_restore_poisons_the_handle_then_reopen_rolls_the_family_back() {
    let root = private_dir();
    let destination = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    let backup = store.backup(request(destination.path())).unwrap();
    insert_domain(&store, 2, Sensitivity::Normal);
    let live_oracle = restore_oracle(root.path());

    assert_eq!(
        store
            .restore_with_fault_for_test(&backup.destination_path, RestoreFault::RecoveryFailure,)
            .unwrap_err(),
        KernelError::InvalidRestore
    );
    assert_eq!(
        store.known_as_of(1).unwrap_err(),
        KernelError::InvalidRestore
    );
    assert_eq!(
        insert_domain_result(&store, 3).unwrap_err(),
        KernelError::InvalidRestore
    );
    assert!(fs::read_dir(root.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".mc-restore-")
    }));
    assert!(root.path().join("core.sqlite.mc-restore").exists());
    assert!(!root.path().join("core.sqlite").exists());
    drop(store);

    let reopened = KernelStore::open(root.path()).unwrap();
    assert!(root.path().join("core.sqlite").exists());
    assert!(!root.path().join("core.sqlite.mc-restore").exists());
    assert!(!fs::read_dir(root.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".mc-restore-")
    }));
    assert_eq!(reopened.facts(1).unwrap().commit_seq, 2);
    assert_eq!(restore_oracle(root.path()), live_oracle);
    assert_eq!(insert_domain(&reopened, 3, Sensitivity::Normal), 3);
}

fn insert_domain_result(
    store: &KernelStore,
    index: i64,
) -> Result<i64, mc_store::kernel::KernelError> {
    store
        .commit(intent(&format!("domain-{index}")), |envelope| {
            envelope.insert_domain(domain(index, Sensitivity::Normal))?;
            Ok("stored".to_string())
        })
        .map(|result| result.commit_seq)
}

#[test]
#[ignore = "writes about 3 GiB; run with: cargo test -p mc-store --features test-support --test kernel_backup threshold_size_restore_rto -- --ignored --nocapture"]
fn threshold_size_restore_rto() {
    let root = private_dir();
    let destination = private_dir();
    // The fixture, its backup and the restore copy are each about 1 GiB.
    for area in [root.path(), destination.path()] {
        let available = rustix::fs::statvfs(area).unwrap();
        let free = available.f_bavail * available.f_frsize;
        assert!(
            free >= 4 * 1024 * 1024 * 1024,
            "{} has {free} bytes free; this proof writes about 3 GiB",
            area.display()
        );
    }
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    drop(store);
    let mut connection = inspect(root.path());
    apply_kernel_connection_profile(&mut connection, 5_000).unwrap();
    connection
        .pragma_update(None, "synchronous", "OFF")
        .unwrap();
    let tx = connection.transaction().unwrap();
    for ordinal in 0..1024_i64 {
        tx.execute(
            "INSERT INTO outbox(
                 commit_seq,ordinal,object_id,object_kind,source_kind,source_id,
                 source_revision,sensitivity_class,payload,created_at
             ) VALUES (1,?1,?2,'fixture','fixture',?2,1,'normal',zeroblob(1048576),1)",
            params![ordinal + 1, format!("bulk-{ordinal}")],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(connection);
    assert!(fs::metadata(root.path().join("core.sqlite")).unwrap().len() >= 1024 * 1024 * 1024);
    let store = KernelStore::open(root.path()).unwrap();
    // The shared `request` helper allows 30 s, which a 1 GiB copy plus a full
    // integrity check can exceed on constrained I/O.
    let rto_request = BackupRequest {
        destination_directory: destination.path().to_path_buf(),
        deadline: Instant::now() + Duration::from_secs(300),
        capture_pin_expires_at: None,
    };
    let backup = store.backup(rto_request).unwrap();
    let started = Instant::now();
    store.restore(&backup.destination_path).unwrap();
    // `restore_elapsed` excludes backup time and the post-restore assertions.
    let restore_elapsed = started.elapsed();
    assert_eq!(store.known_as_of(1).unwrap().tip, 1);
    assert_eq!(insert_domain(&store, 2, Sensitivity::Normal), 2);
    assert!(
        restore_elapsed <= Duration::from_secs(300),
        "restore took {restore_elapsed:?}"
    );
}

fn header_write_read_versions(path: &Path) -> (u8, u8) {
    use std::io::Read;
    let mut header = [0u8; 20];
    fs::File::open(path)
        .unwrap()
        .read_exact(&mut header)
        .unwrap();
    (header[18], header[19])
}

#[test]
fn published_artifact_is_self_contained_and_restores_from_read_only_media() {
    let root = private_dir();
    let destination = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    let backup = store.backup(request(destination.path())).unwrap();

    assert_eq!(header_write_read_versions(&backup.destination_path), (1, 1));
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = PathBuf::from(format!(
            "{}{suffix}",
            backup.destination_path.to_str().unwrap()
        ));
        assert!(!sidecar.exists(), "{suffix} left beside the artifact");
    }
    assert_eq!(destination_entries(destination.path()).len(), 1);

    let archive = private_dir();
    let archived = archive.path().join("archived.sqlite");
    fs::copy(&backup.destination_path, &archived).unwrap();
    fs::set_permissions(&archived, fs::Permissions::from_mode(0o600)).unwrap();
    fs::set_permissions(archive.path(), fs::Permissions::from_mode(0o500)).unwrap();

    let target_root = private_dir();
    let target = KernelStore::open(target_root.path()).unwrap();
    assert_eq!(target.restore(&archived).unwrap(), 1);
    assert_eq!(target.facts(1).unwrap().commit_seq, 1);

    fs::set_permissions(archive.path(), fs::Permissions::from_mode(0o700)).unwrap();
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", archived.to_str().unwrap()));
        assert!(
            !sidecar.exists(),
            "restore created {suffix} beside the source"
        );
    }
}

#[test]
fn restore_interrupted_before_the_swap_rolls_back_on_the_next_open() {
    let root = private_dir();
    let destination = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    let backup = store.backup(request(destination.path())).unwrap();
    insert_domain(&store, 2, Sensitivity::Normal);
    let live_oracle = restore_oracle(root.path());

    // `AfterDisplace` abandons the family in the recovery directory with the
    // marker still published, matching a process killed mid-replacement.
    assert_eq!(
        store
            .restore_with_fault_for_test(&backup.destination_path, RestoreFault::AfterDisplace)
            .unwrap_err(),
        KernelError::Fault
    );
    drop(store);

    let reopened = KernelStore::open(root.path()).unwrap();
    assert_eq!(restore_oracle(root.path()), live_oracle);
    assert_eq!(reopened.facts(1).unwrap().commit_seq, 2);
    assert!(!root.path().join("core.sqlite.mc-restore").exists());
    assert!(!fs::read_dir(root.path()).unwrap().any(|entry| {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        name.contains(".mc-restore-") || name.contains(".restore-")
    }));
    assert_eq!(insert_domain(&reopened, 3, Sensitivity::Normal), 3);
}

#[test]
fn a_forged_restore_marker_fails_closed_instead_of_moving_the_family() {
    let root = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    drop(store);

    let marker = root.path().join("core.sqlite.mc-restore");
    fs::write(&marker, b"{\"protocol\":\"mc-kernel-restore-marker-v1\"}").unwrap();
    assert_eq!(
        KernelStore::open(root.path()).unwrap_err(),
        KernelError::Inconclusive
    );
    assert!(root.path().join("core.sqlite").exists());

    fs::remove_file(&marker).unwrap();
    let reopened = KernelStore::open(root.path()).unwrap();
    assert_eq!(reopened.facts(1).unwrap().commit_seq, 1);
}

#[test]
fn sensitivity_classification_scans_every_table_carrying_the_column() {
    let root = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    drop(store);

    let mut connection = inspect(root.path());
    let scanned = sensitivity_bearing_tables_for_test(&mut connection);
    let mut expected: Vec<String> = connection
        .prepare(
            "SELECT m.name FROM sqlite_schema m, pragma_table_info(m.name) p
             WHERE m.type='table' AND p.name='sensitivity_class'",
        )
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    expected.sort();

    assert!(!scanned.is_empty());
    assert_eq!(scanned, expected);
    for required in ["domains", "evidence_meta", "outbox", "candidates"] {
        assert!(
            scanned.iter().any(|name| name == required),
            "{required} missing from the sensitivity scan"
        );
    }
}

#[test]
fn restore_interrupted_before_displacement_keeps_the_live_family() {
    let root = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    insert_domain(&store, 2, Sensitivity::Normal);
    let live_oracle = restore_oracle(root.path());

    // A process killed here leaves the marker published, the recovery directory
    // empty, and the live family as the only copy of the data.
    let recovery_dir = store.abandon_restore_marker_for_test().unwrap();
    assert!(recovery_dir.is_dir());
    assert_eq!(fs::read_dir(&recovery_dir).unwrap().count(), 0);
    assert!(root.path().join("core.sqlite").exists());
    drop(store);

    let reopened = KernelStore::open(root.path()).unwrap();
    assert_eq!(restore_oracle(root.path()), live_oracle);
    assert_eq!(reopened.facts(1).unwrap().commit_seq, 2);
    assert!(!root.path().join("core.sqlite.mc-restore").exists());
    assert!(!recovery_dir.exists());
    assert_eq!(insert_domain(&reopened, 3, Sensitivity::Normal), 3);
}

#[test]
fn restore_interrupted_after_sidecars_move_keeps_the_live_main_file() {
    let root = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1, Sensitivity::Normal);
    insert_domain(&store, 2, Sensitivity::Normal);
    let live_oracle = restore_oracle(root.path());

    // `displace_family` moves sidecars before the main file, so a kill mid-way
    // leaves the main file live and its sidecars in the recovery directory.
    let recovery_dir = store.abandon_restore_marker_for_test().unwrap();
    drop(store);
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!(
            "{}{suffix}",
            root.path().join("core.sqlite").to_str().unwrap()
        ));
        if sidecar.exists() {
            fs::rename(&sidecar, recovery_dir.join(sidecar.file_name().unwrap())).unwrap();
        }
    }
    assert!(root.path().join("core.sqlite").exists());

    let reopened = KernelStore::open(root.path()).unwrap();
    assert_eq!(restore_oracle(root.path()), live_oracle);
    assert_eq!(reopened.facts(1).unwrap().commit_seq, 2);
    assert!(!recovery_dir.exists());
    assert_eq!(insert_domain(&reopened, 3, Sensitivity::Normal), 3);
}
