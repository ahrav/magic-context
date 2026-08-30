#![cfg(feature = "test-support")]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use mc_store::kernel::{CommitIntent, DomainSpec, KernelStore, Sensitivity, MAIN_FILE_WARN_BYTES};

fn intent(key: &str) -> CommitIntent {
    CommitIntent {
        producer: "kernel-facts-test".to_string(),
        operation_key: key.to_string(),
        request_digest: "b".repeat(64),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

fn domain(index: i64) -> DomainSpec {
    DomainSpec {
        domain_id: format!("domain-{index}"),
        object_id: format!("object-{index}"),
        name: format!("name-{index}"),
        source_kind: "fixture".to_string(),
        source_id: format!("source-{index}"),
        source_revision: index,
        sensitivity: Sensitivity::Normal,
    }
}

fn private_dir() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    directory
}

fn insert_domain(store: &KernelStore, index: i64) -> i64 {
    store
        .commit(intent(&format!("domain-{index}")), |envelope| {
            envelope.insert_domain(domain(index))?;
            Ok("stored".to_string())
        })
        .unwrap()
        .commit_seq
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

#[test]
fn main_size_warning_flips_at_threshold_and_excludes_wal() {
    let root = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1);
    let main = root.path().join("core.sqlite");
    let wal = root.path().join("core.sqlite-wal");
    let main_bytes = file_len(&main);
    let wal_bytes = file_len(&wal);
    assert!(wal_bytes > 0);
    assert_eq!(MAIN_FILE_WARN_BYTES, 1024 * 1024 * 1024);
    assert_eq!(
        store.facts(1).unwrap().main_file_warn,
        main_bytes >= MAIN_FILE_WARN_BYTES
    );

    let below = store
        .facts_with_warn_threshold_for_test(1, main_bytes + 1)
        .unwrap();
    let at = store
        .facts_with_warn_threshold_for_test(1, main_bytes)
        .unwrap();
    let above = store
        .facts_with_warn_threshold_for_test(1, main_bytes.saturating_sub(1))
        .unwrap();
    assert!(!below.main_file_warn);
    assert!(at.main_file_warn);
    assert!(above.main_file_warn);
    assert_eq!(at.main_file_bytes, main_bytes);
    assert_eq!(
        at.family_bytes,
        main_bytes + wal_bytes + file_len(&root.path().join("core.sqlite-shm"))
    );
    assert_eq!(insert_domain(&store, 2), 2);
}

#[test]
fn no_consumers_have_zero_lag_and_no_oldest_age() {
    let root = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1);
    let facts = store.facts(i64::MAX).unwrap();
    assert_eq!(facts.minimum_required_checkpoint, None);
    assert_eq!(facts.event_lag, 0);
    assert_eq!(facts.oldest_unconsumed_age_ms, None);
}

#[test]
fn lag_uses_slowest_consumer_and_oldest_age_grows_exactly() {
    let root = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    assert_eq!(insert_domain(&store, 1), 1);
    let registration = store
        .commit(intent("register"), |envelope| {
            envelope.register_outbox_consumer("required", 1)?;
            Ok("registered".to_string())
        })
        .unwrap();
    assert_eq!(registration.commit_seq, 2);
    store.acknowledge_outbox("required", 2, 2).unwrap();
    assert_eq!(
        store
            .commit(intent("empty"), |_| Ok("empty".to_string()))
            .unwrap()
            .commit_seq,
        3
    );
    let empty_commit_lag = store.facts(i64::MAX).unwrap();
    assert_eq!(empty_commit_lag.minimum_required_checkpoint, Some(2));
    assert_eq!(empty_commit_lag.event_lag, 1);
    assert_eq!(empty_commit_lag.oldest_unconsumed_age_ms, None);

    store
        .commit(intent("register-fast"), |envelope| {
            envelope.register_outbox_consumer("faster", 1)?;
            Ok("registered".to_string())
        })
        .unwrap();
    store.acknowledge_outbox("faster", 4, 4).unwrap();
    assert_eq!(insert_domain(&store, 2), 5);
    store.acknowledge_outbox("faster", 5, 5).unwrap();
    let created_at: i64 = rusqlite::Connection::open(root.path().join("core.sqlite"))
        .unwrap()
        .query_row(
            "SELECT MIN(created_at) FROM outbox WHERE commit_seq>2",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let first = store.facts(created_at + 17).unwrap();
    let second = store.facts(created_at + 42).unwrap();
    assert_eq!(first.minimum_required_checkpoint, Some(2));
    assert_eq!(first.event_lag, 3);
    assert_eq!(first.oldest_unconsumed_age_ms, Some(17));
    assert_eq!(second.oldest_unconsumed_age_ms, Some(42));

    store.acknowledge_outbox("required", 5, 5).unwrap();
    let caught_up = store.facts(i64::MAX).unwrap();
    assert_eq!(caught_up.event_lag, 0);
    assert_eq!(caught_up.oldest_unconsumed_age_ms, None);
}
