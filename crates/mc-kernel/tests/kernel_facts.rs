#![cfg(feature = "test-support")]

//! Storage facts distinguish SQLite main-file bytes from total database-family
//! bytes. Consumer lag uses commit-sequence counts, and age values use elapsed
//! milliseconds from the caller-supplied clock.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use mc_kernel::{CommitIntent, DomainSpec, KernelStore, Sensitivity, MAIN_FILE_WARN_BYTES};

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
fn main_file_bytes_names_the_main_file_and_family_bytes_adds_every_sidecar() {
    let root = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1);
    let main = root.path().join("core.sqlite");
    let wal = root.path().join("core.sqlite-wal");
    let shm = root.path().join("core.sqlite-shm");
    let main_bytes = file_len(&main);
    let wal_bytes = file_len(&wal);
    let shm_bytes = file_len(&shm);
    assert!(main_bytes > 0);
    assert!(wal_bytes > 0);
    assert_eq!(MAIN_FILE_WARN_BYTES, 1024 * 1024 * 1024);

    let facts = store.facts(1).unwrap();
    assert_eq!(facts.main_file_bytes, main_bytes);
    assert_eq!(facts.family_bytes, main_bytes + wal_bytes + shm_bytes);
    assert!(facts.family_bytes > facts.main_file_bytes);
    assert!(facts.main_file_bytes < MAIN_FILE_WARN_BYTES);
    assert_eq!(insert_domain(&store, 2), 2);
}

#[test]
fn no_consumers_report_absent_lag_rather_than_zero() {
    let root = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domain(&store, 1);
    let facts = store.facts(i64::MAX).unwrap();
    assert_eq!(facts.minimum_required_checkpoint, None);
    assert_eq!(facts.commit_lag, None);
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
    assert_eq!(empty_commit_lag.commit_lag, Some(1));
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
    assert_eq!(first.commit_lag, Some(3));
    assert_eq!(first.oldest_unconsumed_age_ms, Some(17));
    assert_eq!(second.oldest_unconsumed_age_ms, Some(42));

    store.acknowledge_outbox("required", 5, 5).unwrap();
    let caught_up = store.facts(i64::MAX).unwrap();
    assert_eq!(caught_up.commit_lag, Some(0));
    assert_eq!(caught_up.oldest_unconsumed_age_ms, None);
}

/// One commit inserting `count` domains emits `count` outbox rows.
fn insert_domains(store: &KernelStore, first_index: i64, count: i64) -> i64 {
    store
        .commit(
            intent(&format!("domains-{first_index}-{count}")),
            |envelope| {
                for index in first_index..first_index + count {
                    envelope.insert_domain(domain(index))?;
                }
                Ok("stored".to_string())
            },
        )
        .unwrap()
        .commit_seq
}

fn register(store: &KernelStore, consumer: &str) -> i64 {
    store
        .commit(intent(&format!("register-{consumer}")), |envelope| {
            envelope.register_outbox_consumer(consumer, 1)?;
            Ok("registered".to_string())
        })
        .unwrap()
        .commit_seq
}

#[test]
fn lag_uses_outbox_positions_and_the_required_consumer_minimum() {
    let root = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    // Commits 1..=3 emit 2, 5, and 1 outbox rows at positions 1-2, 3-7, and 8.
    assert_eq!(insert_domains(&store, 1, 2), 1);
    assert_eq!(insert_domains(&store, 3, 5), 2);
    assert_eq!(insert_domains(&store, 8, 1), 3);
    assert_eq!(store.facts(1).unwrap().retained_outbox_rows, 8);

    // Registration checkpoints at the commit before the oldest retained row and
    // emits one control row per consumer at positions 9 and 10.
    assert_eq!(register(&store, "a"), 4);
    assert_eq!(register(&store, "b"), 5);
    assert_eq!(store.facts(1).unwrap().retained_outbox_rows, 10);
    store.acknowledge_outbox("a", 1, 1).unwrap();
    store.acknowledge_outbox("b", 2, 1).unwrap();

    // Nothing published yet: rows past the slowest checkpoint are unconsumed but
    // count as zero positions of lag, while their age still accrues.
    let unpublished = store.outbox_lag(1).unwrap();
    assert_eq!(unpublished.position_lag, Some(0));
    assert_eq!(unpublished.consumer_count, 2);
    assert!(unpublished.oldest_unconsumed_age_ms.is_some());

    store.mark_outbox_published_through(7, 1).unwrap();
    let facts = store.facts(1).unwrap();
    assert_eq!(facts.minimum_required_checkpoint, Some(1));
    assert_eq!(facts.commit_lag, Some(4));
    assert_eq!(facts.outbox_position_lag, Some(5));
    assert_eq!(facts.retained_outbox_rows, 10);
    let lag = store.outbox_lag(1).unwrap();
    assert_eq!(lag.position_lag, Some(5));
    assert_eq!(lag.consumer_count, 2);
    assert_eq!(lag.oldest_unconsumed_age_ms, facts.oldest_unconsumed_age_ms);

    store.mark_outbox_published_through(8, 1).unwrap();
    assert_eq!(store.facts(1).unwrap().outbox_position_lag, Some(6));

    // The minimum governs: `a` catching up leaves `b` at commit 2, so position 8
    // (commit 3) is still unacknowledged.
    store.acknowledge_outbox("a", 5, 1).unwrap();
    assert_eq!(store.outbox_lag(1).unwrap().position_lag, Some(1));
    store.acknowledge_outbox("b", 5, 1).unwrap();
    let caught_up = store.facts(1).unwrap();
    assert_eq!(caught_up.outbox_position_lag, Some(0));
    assert_eq!(caught_up.oldest_unconsumed_age_ms, None);
    assert_eq!(caught_up.retained_outbox_rows, 10);
}

#[test]
fn no_consumers_report_absent_position_lag_and_count_retained_rows() {
    let root = private_dir();
    let store = KernelStore::open(root.path()).unwrap();
    insert_domains(&store, 1, 8);
    store.mark_outbox_published_through(8, 1).unwrap();
    let facts = store.facts(1).unwrap();
    assert_eq!(facts.outbox_position_lag, None);
    assert_eq!(facts.commit_lag, None);
    assert_eq!(facts.retained_outbox_rows, 8);
    let lag = store.outbox_lag(1).unwrap();
    assert_eq!(lag.position_lag, None);
    assert_eq!(lag.oldest_unconsumed_age_ms, None);
    assert_eq!(lag.consumer_count, 0);
    assert_eq!(
        store.outbox_lag(-1),
        Err(mc_kernel::KernelError::InvalidInput)
    );
}
