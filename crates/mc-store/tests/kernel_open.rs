use mc_store::kernel::schema::{
    apply_kernel_connection_profile, apply_kernel_schema, kernel_schema_digest,
    KERNEL_APPLICATION_ID,
};
use mc_store::kernel::{KernelError, KernelStore};
use mc_store::sqlite_runtime::compute_marker_digest_for_application_id;
#[cfg(feature = "test-support")]
use mc_store::sqlite_runtime::SqliteEngineIdentity;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const INCARNATION: &str = "0123456789abcdef0123456789abcdef";

fn core_path(root: &Path) -> PathBuf {
    root.join("core.sqlite")
}

fn inspect<T>(root: &Path, query: impl FnOnce(&Connection) -> T) -> T {
    let conn = Connection::open_with_flags(core_path(root), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open read-only inspection connection");
    query(&conn)
}

fn seed_kernel(root: &Path) -> Connection {
    fs::create_dir_all(root).unwrap();
    let mut conn = Connection::open(core_path(root)).unwrap();
    apply_kernel_connection_profile(&mut conn, 5_000).unwrap();
    apply_kernel_schema(&mut conn, INCARNATION, 1_000).unwrap();
    conn
}

fn marker_digest(epoch: i64, schema_digest: &str) -> String {
    compute_marker_digest_for_application_id(
        KERNEL_APPLICATION_ID,
        epoch,
        INCARNATION,
        schema_digest,
        1_000,
    )
}

fn replace_marker(conn: &Connection, epoch: i64, schema_digest: &str) {
    conn.execute_batch(
        "DROP TRIGGER mc_kernel_format_marker_no_update;
         DROP TRIGGER mc_kernel_format_marker_no_delete;",
    )
    .unwrap();
    conn.execute(
        "UPDATE mc_kernel_format_marker
         SET format_epoch=?1, schema_digest=?2, marker_digest=?3",
        (epoch, schema_digest, marker_digest(epoch, schema_digest)),
    )
    .unwrap();
    conn.execute_batch(
        "CREATE TRIGGER mc_kernel_format_marker_no_update
         BEFORE UPDATE ON mc_kernel_format_marker BEGIN
           SELECT RAISE(ABORT, 'mc_kernel_format_marker is immutable');
         END;
         CREATE TRIGGER mc_kernel_format_marker_no_delete
         BEFORE DELETE ON mc_kernel_format_marker BEGIN
           SELECT RAISE(ABORT, 'mc_kernel_format_marker is immutable');
         END;",
    )
    .unwrap();
}

fn quarantine_dirs(root: &Path) -> Vec<PathBuf> {
    let mut paths = fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("core.sqlite.mc-quarantine-")
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

#[test]
fn fresh_open_and_exact_reopen_preserve_identity_and_advance_fence() {
    let dir = tempfile::tempdir().unwrap();
    let first = KernelStore::open(dir.path()).unwrap();
    let first_epoch = first.lease_epoch();
    let incarnation = inspect(dir.path(), |conn| {
        conn.query_row(
            "SELECT database_incarnation_id FROM mc_kernel_format_marker",
            [],
            |row| row.get::<_, String>(0),
        )
    })
    .unwrap();
    assert_eq!(
        inspect(dir.path(), |conn| conn.query_row(
            "SELECT writer_epoch FROM writer_fence WHERE id=0",
            [],
            |row| row.get::<_, i64>(0)
        ))
        .unwrap(),
        i64::try_from(first_epoch).unwrap()
    );
    drop(first);

    let second = KernelStore::open(dir.path()).unwrap();
    assert!(second.lease_epoch() > first_epoch);
    assert_eq!(
        inspect(dir.path(), |conn| {
            conn.query_row(
                "SELECT database_incarnation_id FROM mc_kernel_format_marker",
                [],
                |row| row.get::<_, String>(0),
            )
        })
        .unwrap(),
        incarnation
    );
}

#[test]
fn second_opener_is_held_without_touching_database_family() {
    let dir = tempfile::tempdir().unwrap();
    let first = KernelStore::open(dir.path()).unwrap();
    let before = fs::read(core_path(dir.path())).unwrap();
    assert_eq!(
        KernelStore::open(dir.path()).unwrap_err(),
        KernelError::Held
    );
    assert_eq!(fs::read(core_path(dir.path())).unwrap(), before);
    drop(first);
}

#[test]
fn every_conclusive_kernel_mismatch_is_quarantined_and_rebuilt() {
    for mismatch in ["epoch", "digest", "inventory"] {
        let dir = tempfile::tempdir().unwrap();
        let conn = seed_kernel(dir.path());
        match mismatch {
            "epoch" => {
                let digest = kernel_schema_digest(&conn).unwrap();
                replace_marker(&conn, 2, &digest);
            }
            "digest" => replace_marker(&conn, 1, &"a".repeat(64)),
            "inventory" => {
                conn.execute_batch("CREATE TABLE unexpected(value INTEGER) STRICT;")
                    .unwrap();
            }
            _ => unreachable!(),
        }
        drop(conn);

        let _store = KernelStore::open(dir.path()).unwrap();
        assert_eq!(quarantine_dirs(dir.path()).len(), 1, "{mismatch}");
        assert_eq!(
            inspect(dir.path(), |conn| conn.query_row(
                "SELECT COUNT(*) FROM mc_kernel_format_marker",
                [],
                |row| row.get::<_, i64>(0)
            ))
            .unwrap(),
            1
        );
    }
}

#[test]
fn foreign_family_is_refused_before_sqlite_can_touch_it() {
    // `FOREIGN_APPLICATION_ID` must differ from `KERNEL_APPLICATION_ID` so the
    // fixture exercises foreign-header classification.
    const FOREIGN_APPLICATION_ID: u32 = 0x5A5A_5A5A;
    assert_ne!(FOREIGN_APPLICATION_ID, KERNEL_APPLICATION_ID);

    let dir = tempfile::tempdir().unwrap();
    let path = core_path(dir.path());
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "application_id", FOREIGN_APPLICATION_ID)
        .unwrap();
    conn.execute_batch("CREATE TABLE legacy(value TEXT);")
        .unwrap();
    drop(conn);
    fs::write(format!("{}-wal", path.display()), b"foreign wal").unwrap();
    let before_main = fs::read(&path).unwrap();
    let before_wal = fs::read(format!("{}-wal", path.display())).unwrap();

    assert_eq!(
        KernelStore::open(dir.path()).unwrap_err(),
        KernelError::Foreign
    );
    assert_eq!(fs::read(&path).unwrap(), before_main);
    assert_eq!(
        fs::read(format!("{}-wal", path.display())).unwrap(),
        before_wal
    );
    assert!(quarantine_dirs(dir.path()).is_empty());
}

#[test]
fn a_sibling_mc_family_is_refused_and_left_untouched() {
    // `KERNEL_APPLICATION_ID` is shared across mc families; schema inspection
    // distinguishes them.
    let dir = tempfile::tempdir().unwrap();
    let path = core_path(dir.path());
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "application_id", KERNEL_APPLICATION_ID)
        .unwrap();
    conn.execute_batch("CREATE TABLE legacy(value TEXT);")
        .unwrap();
    drop(conn);
    let before_main = fs::read(&path).unwrap();

    assert_eq!(
        KernelStore::open(dir.path()).unwrap_err(),
        KernelError::Inconclusive
    );
    assert_eq!(fs::read(&path).unwrap(), before_main);
    assert!(quarantine_dirs(dir.path()).is_empty());
}

#[test]
fn malformed_marker_is_inconclusive_and_untouched() {
    // "g" fails the lowercase-hex check; the all-zero digest fails digest comparison.
    for digest in ["g".repeat(64), "0".repeat(64)] {
        let dir = tempfile::tempdir().unwrap();
        let conn = seed_kernel(dir.path());
        conn.execute_batch("DROP TRIGGER mc_kernel_format_marker_no_update;")
            .unwrap();
        conn.execute(
            "UPDATE mc_kernel_format_marker SET marker_digest=?1",
            [&digest],
        )
        .unwrap();
        drop(conn);
        let path = core_path(dir.path());
        let before = fs::read(&path).unwrap();

        assert_eq!(
            KernelStore::open(dir.path()).unwrap_err(),
            KernelError::Inconclusive,
            "{digest}"
        );
        assert_eq!(fs::read(&path).unwrap(), before, "{digest}");
        assert!(quarantine_dirs(dir.path()).is_empty(), "{digest}");
    }
}

#[test]
fn valid_interrupted_reset_marker_resumes_without_opening_old_family() {
    let dir = tempfile::tempdir().unwrap();
    // Quarantine resume compares paths lexically. A symlinked root
    // (`/var` -> `/private/var`) fails that comparison when spellings are mixed.
    //
    let root = dir.path().canonicalize().unwrap();
    let conn = seed_kernel(&root);
    conn.execute_batch("CREATE TABLE unexpected(value INTEGER) STRICT;")
        .unwrap();
    drop(conn);
    let db_path = core_path(&root);
    let quarantine = root.join("core.sqlite.mc-quarantine-resume");
    fs::create_dir(&quarantine).unwrap();
    fs::rename(&db_path, quarantine.join("core.sqlite")).unwrap();
    for suffix in ["-journal", "-wal", "-shm"] {
        fs::write(format!("{}{suffix}", db_path.display()), suffix.as_bytes()).unwrap();
    }
    let marker_without_digest = serde_json::json!({
        "protocol": "mc-kernel-reset-marker-v1",
        "db_path": db_path,
        "database_incarnation_id": INCARNATION,
        "quarantine_dir": quarantine,
    });
    let canonical = format!(
        "mc-kernel-reset-marker-v1\ndb_path={}\ndatabase_incarnation_id={}\nquarantine_dir={}",
        marker_without_digest["db_path"].as_str().unwrap(),
        INCARNATION,
        marker_without_digest["quarantine_dir"].as_str().unwrap(),
    );
    let digest = format!("{:x}", Sha256::digest(canonical.as_bytes()));
    let mut marker = marker_without_digest;
    marker["marker_digest"] = digest.into();
    fs::write(
        root.join("core.sqlite.mc-reset"),
        serde_json::to_vec(&marker).unwrap(),
    )
    .unwrap();

    let _store = KernelStore::open(&root).unwrap();
    assert!(core_path(&root).is_file());
    assert!(quarantine.join("core.sqlite.mc-reset").is_file());
    assert_owner_only(&quarantine, 0o700);
    for name in [
        "core.sqlite",
        "core.sqlite-journal",
        "core.sqlite-wal",
        "core.sqlite-shm",
        "core.sqlite.mc-reset",
    ] {
        assert_owner_only(&quarantine.join(name), 0o600);
    }
}

#[test]
fn writer_and_sidecars_are_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    let store = KernelStore::open(dir.path()).unwrap();
    let path = core_path(dir.path());
    assert_owner_only(&path, 0o600);
    assert_owner_only(&PathBuf::from(format!("{}-wal", path.display())), 0o600);
    assert_owner_only(&PathBuf::from(format!("{}-shm", path.display())), 0o600);
    assert_eq!(
        inspect(dir.path(), |conn| conn.query_row(
            "PRAGMA journal_mode",
            [],
            |row| row.get::<_, String>(0)
        ))
        .unwrap(),
        "wal"
    );
    drop(store);
}

#[cfg(feature = "test-support")]
#[test]
fn unsupported_engine_is_rejected_before_creating_lease_or_database_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("kernel");
    let identity = SqliteEngineIdentity {
        sqlite_version: "3.51.2".to_string(),
        sqlite_source_id: "2026-01-01 00:00:00 0123456789abcdef0123456789abcdef01234567"
            .to_string(),
    };
    assert_eq!(
        KernelStore::open_with_engine_identity_for_test(&root, &identity).unwrap_err(),
        KernelError::EngineUnsupported
    );
    assert!(!root.exists());
}

#[test]
fn kernel_with_uncheckpointed_wal_opens_and_preserves_rows() {
    let dir = tempfile::tempdir().unwrap();
    drop(KernelStore::open(dir.path()).unwrap());

    let conn = Connection::open(core_path(dir.path())).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.execute(
        "INSERT INTO commit_log(
             transaction_id,writer_epoch,producer,operation_key,request_digest,
             recorded_at,actor,cause
         ) VALUES('t1',1,'fixture','t1','',1,'actor','cause')",
        [],
    )
    .unwrap();
    let wal = PathBuf::from(format!("{}-wal", core_path(dir.path()).display()));
    assert!(wal.is_file(), "the row should still be in the WAL");
    // Leaking skips the clean close that would checkpoint and remove the WAL.
    // A crashed writer leaves the uncheckpointed WAL on disk.
    std::mem::forget(conn);

    let _store = KernelStore::open(dir.path()).unwrap();
    assert_eq!(
        inspect(dir.path(), |conn| conn.query_row(
            "SELECT COUNT(*) FROM commit_log",
            [],
            |row| row.get::<_, i64>(0)
        ))
        .unwrap(),
        1
    );
    assert!(quarantine_dirs(dir.path()).is_empty());
}

#[cfg(unix)]
fn assert_owner_only(path: &Path, expected: u32) {
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        expected
    );
}

#[cfg(not(unix))]
fn assert_owner_only(_path: &Path, _expected: u32) {}
