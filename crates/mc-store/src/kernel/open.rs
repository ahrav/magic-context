use cortexkit_lease::{
    protect_file, FileLeaseStore, LeaseError, LeaseHandle, LeaseKey, LeaseStore,
};
use mc_core::claim_operation::is_lower_hex;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex, PoisonError, TryLockError};
use std::time::Instant;

use super::schema::{
    apply_kernel_schema, kernel_schema_digest, kernel_schema_object_inventory,
    KERNEL_APPLICATION_ID, KERNEL_FORMAT_EPOCH,
};
use crate::current_time_ms;
use crate::sqlite_runtime::{
    compute_marker_digest_for_application_id, evaluate_sqlite_runtime_gate,
    probe_sqlite_engine_identity_off_path, SqliteEngineIdentity,
};

const BUSY_TIMEOUT_MS: i64 = 5_000;
const READ_POOL_SIZE: usize = 2;
const WRITER_ACQUIRE_POLL: std::time::Duration = std::time::Duration::from_millis(1);
const RESET_MARKER_PROTOCOL: &str = "mc-kernel-reset-marker-v1";
const RESET_MARKER_SUFFIX: &str = ".mc-reset";
const RESET_MARKER_STAGING_SUFFIX: &str = ".staging";
const RESTORE_MARKER_SUFFIX: &str = ".mc-restore";
const QUARANTINE_INFIX: &str = ".mc-quarantine-";
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";

/// Limit marker reads to 64 KiB so invalid marker data cannot control
/// allocation size.
const RESET_MARKER_MAX_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum KernelError {
    Held,
    EngineUnsupported,
    Foreign,
    Inconclusive,
    Io,
    Busy,
    IdentityMismatch,
    FenceLost,
    Conflict,
    InvalidInput,
    FutureSnapshot,
    NotFound,
    InvalidCheckpoint,
    NoRequiredConsumers,
    ConsumerPending,
    Fault,
    Deadline,
    UnsafeDestination,
    InvalidBackup,
    InvalidRestore,
}

impl KernelError {
    /// Returns true only when retrying the unchanged request is valid.
    pub fn is_retryable(self) -> bool {
        matches!(self, Self::Busy | Self::Held)
    }
}

impl fmt::Display for KernelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Held => "kernel store is held by another writer",
            Self::EngineUnsupported => "SQLite engine is unsupported for the kernel store",
            Self::Foreign => "kernel store path contains a foreign database family",
            Self::Inconclusive => "kernel store identity could not be established safely",
            Self::Io => "kernel store I/O failed",
            Self::Busy => "kernel store lock was not acquired before the busy timeout",
            Self::IdentityMismatch => "kernel store identity does not match this build",
            Self::FenceLost => "kernel store writer fence was lost",
            Self::Conflict => "kernel operation conflicts with an existing receipt",
            Self::InvalidInput => "kernel operation input is invalid",
            Self::FutureSnapshot => "kernel snapshot is newer than the committed tip",
            Self::NotFound => "kernel object was not found",
            Self::InvalidCheckpoint => "outbox checkpoint is invalid",
            Self::NoRequiredConsumers => "outbox pruning requires at least one consumer",
            Self::ConsumerPending => "outbox consumer has not reached the commit-log tip",
            Self::Fault => "kernel operation was interrupted",
            Self::Deadline => "kernel operation exceeded its deadline",
            Self::UnsafeDestination => "backup destination is not a private local directory",
            Self::InvalidBackup => "backup artifact failed verification",
            Self::InvalidRestore => "restore source failed verification",
        })
    }
}

impl fmt::Debug for KernelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl std::error::Error for KernelError {}

pub struct KernelStore {
    writer: Mutex<Connection>,
    pub(super) readers: Vec<Mutex<Connection>>,
    next_reader: AtomicUsize,
    // Distinct from mutex poisoning, which `PoisonError::into_inner` recovers: this
    // records that an unrecoverable restore left the family unusable.
    poisoned: AtomicBool,
    lease_epoch: u64,
    pub(super) db_path: PathBuf,
    _lease: Box<dyn LeaseHandle>,
}

impl fmt::Debug for KernelStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KernelStore")
            .field("lease_epoch", &self.lease_epoch)
            .field("read_pool_size", &self.readers.len())
            .finish_non_exhaustive()
    }
}

impl KernelStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, KernelError> {
        let identity =
            probe_sqlite_engine_identity_off_path().map_err(|_| KernelError::EngineUnsupported)?;
        Self::open_with_engine_identity(root, &identity)
    }

    fn open_with_engine_identity(
        root: impl AsRef<Path>,
        identity: &SqliteEngineIdentity,
    ) -> Result<Self, KernelError> {
        if !evaluate_sqlite_runtime_gate(identity).is_empty() {
            return Err(KernelError::EngineUnsupported);
        }
        Self::open_supported(root)
    }

    #[cfg(feature = "test-support")]
    pub fn open_with_engine_identity_for_test(
        root: impl AsRef<Path>,
        identity: &SqliteEngineIdentity,
    ) -> Result<Self, KernelError> {
        Self::open_with_engine_identity(root, identity)
    }

    fn open_supported(root: impl AsRef<Path>) -> Result<Self, KernelError> {
        let root = prepare_root(root.as_ref())?;
        let db_path = root.join("core.sqlite");
        let lease_store = FileLeaseStore::new(root.join("leases"));
        let lease_key = LeaseKey::new("magic-context-kernel", "sqlite", "core");
        let lease = lease_store.acquire(&lease_key).map_err(map_lease_error)?;
        let lease_epoch = lease.epoch();

        if entry_exists(&restore_marker_path(&db_path))? {
            super::backup::resume_restore(&db_path)?;
        } else {
            super::backup::reap_orphan_restore_recovery(&db_path)?;
        }

        if entry_exists(&reset_marker_path(&db_path))? {
            resume_quarantine(&db_path)?;
        }

        let header = inspect_header(&db_path)?;
        let mut writer = match header {
            HeaderState::Pristine => bootstrap(&db_path)?,
            HeaderState::Kernel => match classify_existing_family(&db_path)? {
                OpenIdentity::Exact => {
                    let conn = open_writer(&db_path).map_err(|_| KernelError::Inconclusive)?;
                    apply_preclassification_profile(&conn)
                        .map_err(|_| KernelError::Inconclusive)?;
                    conn
                }
                OpenIdentity::Mismatch { incarnation } => {
                    quarantine(&db_path, &incarnation, lease_epoch)?;
                    bootstrap(&db_path)?
                }
            },
        };

        activate_wal(&writer)?;
        stamp_writer_fence(&mut writer, lease_epoch)?;
        // A store written by the parent build retains a digest of pre-redaction
        // candidate input, so it is rewritten before the store is handed out.
        super::envelope::strip_legacy_candidate_verifiers(&mut writer)?;
        // Two hardening passes are required because the family grows between
        // them. WAL activation creates `-wal` and `-shm` under the process umask,
        // so the first pass restricts them as early as possible; a read-only open
        // recreates `-shm` when it is missing, so the second pass restricts that
        // one too.
        harden_family(&db_path)?;
        let readers = open_read_pool(&db_path)?;
        harden_family(&db_path)?;

        let store = Self {
            writer: Mutex::new(writer),
            readers,
            next_reader: AtomicUsize::new(0),
            poisoned: AtomicBool::new(false),
            lease_epoch,
            db_path,
            _lease: lease,
        };
        // Reclaiming an expired lease keeps every row; deleting aged runs is left to an
        // explicit call, so opening a store is not a destructive act.
        store.abandon_expired_staging_runs(crate::current_time_ms())?;
        Ok(store)
    }

    pub fn lease_epoch(&self) -> u64 {
        self.lease_epoch
    }

    /// A panic in a caller's closure drops the guard mid-unwind and poisons the
    /// mutex, so recovering the guard keeps one caught panic from disabling every
    /// later write. Dropping a rusqlite `Transaction` rolls it back, so the
    /// recovered connection has no in-flight statement.
    pub(super) fn lock_writer(&self) -> Result<std::sync::MutexGuard<'_, Connection>, KernelError> {
        if self.poisoned.load(Ordering::Acquire) {
            return Err(KernelError::InvalidRestore);
        }
        let writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        if self.poisoned.load(Ordering::Acquire) {
            return Err(KernelError::InvalidRestore);
        }
        Ok(writer)
    }

    /// `Mutex::lock` has no timeout, so a deadline-bounded caller polls instead of
    /// blocking behind an operation that may outlive its own budget.
    pub(super) fn lock_writer_before(
        &self,
        deadline: Instant,
    ) -> Result<std::sync::MutexGuard<'_, Connection>, KernelError> {
        loop {
            if self.poisoned.load(Ordering::Acquire) {
                return Err(KernelError::InvalidRestore);
            }
            let guard = match self.writer.try_lock() {
                Ok(guard) => guard,
                Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
                Err(TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        return Err(KernelError::Deadline);
                    }
                    std::thread::sleep(WRITER_ACQUIRE_POLL);
                    continue;
                }
            };
            if self.poisoned.load(Ordering::Acquire) {
                return Err(KernelError::InvalidRestore);
            }
            return Ok(guard);
        }
    }

    pub(super) fn poison(&self) {
        self.poisoned.store(true, Ordering::Release);
    }

    pub(super) fn lock_reader(&self) -> Result<std::sync::MutexGuard<'_, Connection>, KernelError> {
        if self.poisoned.load(Ordering::Acquire) {
            return Err(KernelError::InvalidRestore);
        }
        let index = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        let reader = self.readers[index]
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if self.poisoned.load(Ordering::Acquire) {
            return Err(KernelError::InvalidRestore);
        }
        Ok(reader)
    }

    #[cfg(feature = "test-support")]
    pub fn invalidate_writer_fence_for_test(&self) -> Result<(), KernelError> {
        let writer = self.lock_writer()?;
        writer
            .execute(
                "UPDATE writer_fence SET writer_epoch=writer_epoch+1 WHERE id=0",
                [],
            )
            .map_err(|_| KernelError::Io)?;
        Ok(())
    }

    #[allow(
        dead_code,
        reason = "connection ownership is restricted to kernel mutation modules"
    )]
    pub(crate) fn with_writer<T>(
        &self,
        operation: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<T>,
    ) -> Result<T, KernelError> {
        let mut writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        // `BEGIN IMMEDIATE` blocks a competing writer until this transaction ends.
        // The fence check and the mutation are therefore atomic.
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        let durable_epoch: i64 = tx
            .query_row(
                "SELECT writer_epoch FROM writer_fence WHERE id=0",
                [],
                |row| row.get(0),
            )
            .map_err(|_| KernelError::FenceLost)?;
        if u64::try_from(durable_epoch).ok() != Some(self.lease_epoch) {
            return Err(KernelError::FenceLost);
        }
        let value = operation(&tx).map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(value)
    }

    #[allow(
        dead_code,
        reason = "connection ownership is restricted to kernel query modules"
    )]
    pub(crate) fn with_reader<T>(
        &self,
        operation: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, KernelError> {
        let index = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        // Recovering a poisoned reader guard keeps its pool slot usable.
        // `Transaction::Drop` rolls back after a closure panic.
        let mut reader = self.readers[index]
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // After its first read, the transaction keeps one snapshot for the
        // closure. Several reads therefore observe one consistent state.
        let tx = reader.transaction().map_err(|_| KernelError::Io)?;
        let value = operation(&tx).map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        Ok(value)
    }
}

enum HeaderState {
    Pristine,
    Kernel,
}

/// `Path::exists` maps every error to `false`; only `NotFound` counts as absence.
fn entry_exists(path: &Path) -> Result<bool, KernelError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err(KernelError::Io),
    }
}

/// A zero-length main file has never held a committed page.
///
/// A `-journal` does not prevent treating an empty main file as pristine.
fn classify_empty_family(path: &Path) -> Result<HeaderState, KernelError> {
    if entry_exists(&suffix_path(path, "-wal"))? || entry_exists(&suffix_path(path, "-shm"))? {
        return Err(KernelError::Inconclusive);
    }
    Ok(HeaderState::Pristine)
}

fn inspect_header(path: &Path) -> Result<HeaderState, KernelError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return classify_empty_family(path),
        Err(_) => return Err(KernelError::Io),
    };
    if !metadata.is_file() {
        return Err(KernelError::Inconclusive);
    }
    if metadata.len() == 0 {
        return classify_empty_family(path);
    }
    if metadata.len() < 100 {
        return Err(KernelError::Inconclusive);
    }
    let mut header = [0_u8; 100];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|_| KernelError::Inconclusive)?;
    if &header[..16] != SQLITE_HEADER {
        return Err(KernelError::Foreign);
    }
    let application_id =
        u32::from_be_bytes(header[68..72].try_into().map_err(|_| KernelError::Io)?);
    if application_id != KERNEL_APPLICATION_ID {
        return Err(KernelError::Foreign);
    }
    Ok(HeaderState::Kernel)
}

struct ExpectedIdentity {
    digest: String,
    inventory: Vec<(String, String)>,
}

static EXPECTED_IDENTITY: LazyLock<Option<ExpectedIdentity>> = LazyLock::new(|| {
    let mut conn = Connection::open_in_memory().ok()?;
    apply_kernel_schema(&mut conn, "00000000000000000000000000000000", 0).ok()?;
    Some(ExpectedIdentity {
        digest: kernel_schema_digest(&conn).ok()?,
        inventory: kernel_schema_object_inventory(&conn).ok()?,
    })
});

fn expected_identity() -> Result<&'static ExpectedIdentity, KernelError> {
    EXPECTED_IDENTITY.as_ref().ok_or(KernelError::Io)
}

/// Classification must leave the database and its `-wal` byte-identical.
///
/// The `Foreign` and `Inconclusive` outcomes promise untouched durable content.
/// Journal recovery and WAL checkpointing would both break that promise.
///
/// A read-only open may recreate a missing `-shm`; it contains no durable data.
/// SQLite rebuilds the `-shm` from the `-wal` on demand.
fn classify_existing_family(path: &Path) -> Result<OpenIdentity, KernelError> {
    let expected = expected_identity()?;
    let mut conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| KernelError::Inconclusive)?;
    conn.pragma_update(None, "query_only", "ON")
        .map_err(|_| KernelError::Inconclusive)?;
    conn.pragma_update(None, "trusted_schema", "OFF")
        .map_err(|_| KernelError::Inconclusive)?;
    conn.pragma_update(None, "busy_timeout", BUSY_TIMEOUT_MS)
        .map_err(|_| KernelError::Inconclusive)?;
    classify_open_kernel(&mut conn, expected)
}

enum OpenIdentity {
    Exact,
    Mismatch { incarnation: String },
}

struct FormatMarker {
    epoch: i64,
    incarnation: String,
    schema_digest: String,
    created_at: i64,
    marker_digest: String,
}

pub(super) fn verify_exact_identity(conn: &mut Connection) -> Result<(), KernelError> {
    let integrity_check: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|_| KernelError::Inconclusive)?;
    if integrity_check != "ok" {
        return Err(KernelError::Inconclusive);
    }
    // `integrity_check` validates page structure, not references, so a family
    // written with `foreign_keys=OFF` can pass it while holding dangling rows.
    let foreign_key_violations: i64 = conn
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(|_| KernelError::Inconclusive)?;
    if foreign_key_violations != 0 {
        return Err(KernelError::Inconclusive);
    }
    match classify_open_kernel(conn, expected_identity()?)? {
        OpenIdentity::Exact => Ok(()),
        OpenIdentity::Mismatch { .. } => Err(KernelError::IdentityMismatch),
    }
}

fn classify_open_kernel(
    conn: &mut Connection,
    expected: &ExpectedIdentity,
) -> Result<OpenIdentity, KernelError> {
    let tx = conn.transaction().map_err(|_| KernelError::Inconclusive)?;
    let quick_check: String = tx
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|_| KernelError::Inconclusive)?;
    if quick_check != "ok" {
        return Err(KernelError::Inconclusive);
    }
    let marker = read_valid_marker(&tx)?;
    let application_id: u32 = tx
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(|_| KernelError::Inconclusive)?;
    let user_version: i64 = tx
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| KernelError::Inconclusive)?;
    let inventory = kernel_schema_object_inventory(&tx).map_err(|_| KernelError::Inconclusive)?;
    let digest = kernel_schema_digest(&tx).map_err(|_| KernelError::Inconclusive)?;
    let exact = application_id == KERNEL_APPLICATION_ID
        && user_version == KERNEL_FORMAT_EPOCH
        && marker.epoch == KERNEL_FORMAT_EPOCH
        && marker.schema_digest == expected.digest
        && digest == expected.digest
        && inventory == expected.inventory;
    tx.commit().map_err(|_| KernelError::Inconclusive)?;
    if exact {
        Ok(OpenIdentity::Exact)
    } else {
        Ok(OpenIdentity::Mismatch {
            incarnation: marker.incarnation,
        })
    }
}

fn read_valid_marker(conn: &Connection) -> Result<FormatMarker, KernelError> {
    let present: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mc_kernel_format_marker'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| KernelError::Inconclusive)?;
    if present.is_none() {
        return Err(KernelError::Inconclusive);
    }
    // A lookalike table has no singleton constraint, so `LIMIT 2` detects multiple
    // rows.
    let mut statement = conn
        .prepare(
            "SELECT format_epoch,database_incarnation_id,schema_digest,created_at,marker_digest
             FROM mc_kernel_format_marker
             WHERE length(database_incarnation_id)=32
               AND length(schema_digest)=64
               AND length(marker_digest)=64
             LIMIT 2",
        )
        .map_err(|_| KernelError::Inconclusive)?;
    let rows = statement
        .query_map([], |row| {
            Ok(FormatMarker {
                epoch: row.get(0)?,
                incarnation: row.get(1)?,
                schema_digest: row.get(2)?,
                created_at: row.get(3)?,
                marker_digest: row.get(4)?,
            })
        })
        .map_err(|_| KernelError::Inconclusive)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| KernelError::Inconclusive)?;
    let [marker] = rows.as_slice() else {
        return Err(KernelError::Inconclusive);
    };
    if !is_lower_hex(&marker.incarnation, 32)
        || !is_lower_hex(&marker.schema_digest, 64)
        || !is_lower_hex(&marker.marker_digest, 64)
        || marker.epoch < 1
        || marker.created_at < 0
    {
        return Err(KernelError::Inconclusive);
    }
    let expected_marker_digest = compute_marker_digest_for_application_id(
        KERNEL_APPLICATION_ID,
        marker.epoch,
        &marker.incarnation,
        &marker.schema_digest,
        marker.created_at,
    );
    if marker.marker_digest != expected_marker_digest {
        return Err(KernelError::Inconclusive);
    }
    Ok(FormatMarker {
        epoch: marker.epoch,
        incarnation: marker.incarnation.clone(),
        schema_digest: marker.schema_digest.clone(),
        created_at: marker.created_at,
        marker_digest: marker.marker_digest.clone(),
    })
}

pub(super) fn open_writer(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
}

fn bootstrap(path: &Path) -> Result<Connection, KernelError> {
    let mut conn = open_writer(path).map_err(|_| KernelError::Io)?;
    apply_preclassification_profile(&conn).map_err(|_| KernelError::Io)?;
    let incarnation: String = conn
        .query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
        .map_err(|_| KernelError::Io)?;
    apply_kernel_schema(&mut conn, &incarnation, current_time_ms()).map_err(|_| KernelError::Io)?;
    Ok(conn)
}

pub(super) fn apply_preclassification_profile(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "trusted_schema", "OFF")?;
    conn.pragma_update(None, "busy_timeout", BUSY_TIMEOUT_MS)?;
    // REPLACE deletes the conflicting row, which fires its BEFORE DELETE trigger
    // only when recursive_triggers is ON.
    conn.pragma_update(None, "recursive_triggers", "ON")?;
    Ok(())
}

/// `PRAGMA journal_mode` returns the mode now in effect rather than failing.
///
/// Readers depend on WAL for snapshot isolation, so the returned mode is checked.
pub(super) fn activate_wal(conn: &Connection) -> Result<(), KernelError> {
    let mode: String = conn
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
        .map_err(|_| KernelError::Io)?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(KernelError::Io);
    }
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(|_| KernelError::Io)
}

pub(super) fn stamp_writer_fence(conn: &mut Connection, epoch: u64) -> Result<(), KernelError> {
    let epoch = i64::try_from(epoch).map_err(|_| KernelError::IdentityMismatch)?;
    let tx = conn.transaction().map_err(|_| KernelError::Io)?;
    if tx
        .execute(
            "UPDATE writer_fence SET writer_epoch=?1 WHERE id=0",
            [epoch],
        )
        .map_err(|_| KernelError::Io)?
        != 1
    {
        return Err(KernelError::IdentityMismatch);
    }
    tx.commit().map_err(|_| KernelError::Io)
}

pub(super) fn open_reader(path: &Path) -> Result<Connection, KernelError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(super::map_sqlite)?;
    conn.pragma_update(None, "query_only", "ON")
        .map_err(super::map_sqlite)?;
    apply_preclassification_profile(&conn).map_err(super::map_sqlite)?;
    Ok(conn)
}

fn open_read_pool(path: &Path) -> Result<Vec<Mutex<Connection>>, KernelError> {
    (0..READ_POOL_SIZE)
        .map(|_| {
            let conn = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|_| KernelError::Io)?;
            conn.pragma_update(None, "query_only", "ON")
                .map_err(|_| KernelError::Io)?;
            apply_preclassification_profile(&conn).map_err(|_| KernelError::Io)?;
            let query_only: i64 = conn
                .query_row("PRAGMA query_only", [], |row| row.get(0))
                .map_err(|_| KernelError::Io)?;
            if query_only != 1 {
                return Err(KernelError::Io);
            }
            Ok(Mutex::new(conn))
        })
        .collect()
}

pub(super) fn family_sidecars(path: &Path) -> [PathBuf; 3] {
    [
        suffix_path(path, "-wal"),
        suffix_path(path, "-shm"),
        suffix_path(path, "-journal"),
    ]
}

pub(super) fn harden_family(path: &Path) -> Result<(), KernelError> {
    protect_file(path).map_err(|_| KernelError::Io)?;
    for sidecar in family_sidecars(path) {
        protect_file(&sidecar).map_err(|_| KernelError::Io)?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResetMarker {
    protocol: String,
    db_path: PathBuf,
    database_incarnation_id: String,
    quarantine_dir: PathBuf,
    marker_digest: String,
}

fn quarantine(path: &Path, incarnation: &str, lease_epoch: u64) -> Result<(), KernelError> {
    let quarantine_dir = allocate_quarantine_dir(path, lease_epoch)?;
    let mut marker = ResetMarker {
        protocol: RESET_MARKER_PROTOCOL.to_string(),
        db_path: path.to_path_buf(),
        database_incarnation_id: incarnation.to_string(),
        quarantine_dir,
        marker_digest: String::new(),
    };
    marker.marker_digest = reset_marker_digest(&marker);
    publish_reset_marker(path, &marker)?;
    move_family(path, &marker)
}

fn resume_quarantine(path: &Path) -> Result<(), KernelError> {
    let marker_path = reset_marker_path(path);
    let metadata = fs::symlink_metadata(&marker_path).map_err(|_| KernelError::Inconclusive)?;
    if !metadata.is_file() || metadata.len() > RESET_MARKER_MAX_BYTES {
        return Err(KernelError::Inconclusive);
    }
    let bytes = fs::read(&marker_path).map_err(|_| KernelError::Inconclusive)?;
    let marker: ResetMarker =
        serde_json::from_slice(&bytes).map_err(|_| KernelError::Inconclusive)?;
    if marker.protocol != RESET_MARKER_PROTOCOL
        || marker.db_path != path
        || !is_lower_hex(&marker.database_incarnation_id, 32)
        || marker.marker_digest != reset_marker_digest(&marker)
        || !valid_quarantine_path(path, &marker.quarantine_dir)
    {
        return Err(KernelError::Inconclusive);
    }
    move_family(path, &marker)
}

/// The live marker name appears only once its bytes are durable.
fn publish_reset_marker(path: &Path, marker: &ResetMarker) -> Result<(), KernelError> {
    let marker_path = reset_marker_path(path);
    let staging = suffix_path(&marker_path, RESET_MARKER_STAGING_SUFFIX);
    let bytes = serde_json::to_vec(marker).map_err(|_| KernelError::Io)?;
    write_private_file(&staging, &bytes)?;
    fs::rename(&staging, &marker_path).map_err(|_| KernelError::Io)?;
    protect_file(&marker_path).map_err(|_| KernelError::Io)?;
    sync_parent(path)?;
    Ok(())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), KernelError> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let outcome = options.open(path).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if outcome.is_err() {
        let _ = fs::remove_file(path);
        return Err(KernelError::Io);
    }
    Ok(())
}

/// The marker's absence declares the reset complete.
///
/// Move the marker only after both directories are durable.
fn move_family(path: &Path, marker: &ResetMarker) -> Result<(), KernelError> {
    prepare_private_dir(&marker.quarantine_dir)?;
    for source in family_sidecars(path)
        .into_iter()
        .chain([path.to_path_buf()])
    {
        move_one(&source, &marker.quarantine_dir)?;
    }
    sync_directory(&marker.quarantine_dir)?;
    sync_parent(path)?;
    move_one(&reset_marker_path(path), &marker.quarantine_dir)?;
    sync_directory(&marker.quarantine_dir)?;
    sync_parent(path)
}

fn move_one(source: &Path, destination_dir: &Path) -> Result<(), KernelError> {
    let name = source.file_name().ok_or(KernelError::Inconclusive)?;
    let destination = destination_dir.join(name);
    match (entry_exists(source)?, entry_exists(&destination)?) {
        (true, false) => {
            fs::rename(source, &destination).map_err(|_| KernelError::Io)?;
            protect_file(&destination).map_err(|_| KernelError::Io)
        }
        (false, true) => protect_file(&destination).map_err(|_| KernelError::Io),
        (false, false) => Ok(()),
        (true, true) => Err(KernelError::Inconclusive),
    }
}

fn reset_marker_digest(marker: &ResetMarker) -> String {
    let canonical = format!(
        "{RESET_MARKER_PROTOCOL}\ndb_path={}\ndatabase_incarnation_id={}\nquarantine_dir={}",
        marker.db_path.display(),
        marker.database_incarnation_id,
        marker.quarantine_dir.display()
    );
    format!("{:x}", Sha256::digest(canonical.as_bytes()))
}

fn allocate_quarantine_dir(path: &Path, lease_epoch: u64) -> Result<PathBuf, KernelError> {
    let base = suffix_path(path, &format!("{QUARANTINE_INFIX}{lease_epoch}"));
    for suffix in 0..10_000_u32 {
        let candidate = if suffix == 0 {
            base.clone()
        } else {
            suffix_path(&base, &format!("-{suffix}"))
        };
        if !entry_exists(&candidate)? {
            return Ok(candidate);
        }
    }
    Err(KernelError::Io)
}

fn valid_quarantine_path(path: &Path, quarantine: &Path) -> bool {
    let Some(file_name) = path.file_name() else {
        return false;
    };
    let mut prefix = file_name.to_os_string();
    prefix.push(QUARANTINE_INFIX);
    quarantine.parent() == path.parent()
        && quarantine.file_name().is_some_and(|name| {
            name.as_encoded_bytes()
                .starts_with(prefix.as_encoded_bytes())
        })
}

pub(super) fn restore_marker_path(path: &Path) -> PathBuf {
    suffix_path(path, RESTORE_MARKER_SUFFIX)
}

fn reset_marker_path(path: &Path) -> PathBuf {
    suffix_path(path, RESET_MARKER_SUFFIX)
}

/// `Path::display` replaces non-UTF-8 bytes, which would name a different file.
pub(super) fn suffix_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// `resume_quarantine` compares the marker's `db_path` against this path by value.
///
/// Canonicalizing after creation gives every spelling of one directory one name.
fn prepare_root(root: &Path) -> Result<PathBuf, KernelError> {
    fs::create_dir_all(root).map_err(|_| KernelError::Io)?;
    prepare_private_dir(root)?;
    fs::canonicalize(root).map_err(|_| KernelError::Io)
}

fn prepare_private_dir(path: &Path) -> Result<(), KernelError> {
    // The umask would leave a readable window between `create_dir` and `chmod`.
    #[cfg(unix)]
    let created = {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(path)
    };
    #[cfg(not(unix))]
    let created = fs::create_dir(path);
    match created {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(_) => return Err(KernelError::Io),
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| KernelError::Io)?;
    if !metadata.is_dir() {
        return Err(KernelError::Io);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o700 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                .map_err(|_| KernelError::Io)?;
        }
    }
    Ok(())
}

pub(super) fn sync_parent(path: &Path) -> Result<(), KernelError> {
    let parent = path.parent().ok_or(KernelError::Io)?;
    sync_directory(parent)
}

pub(super) fn sync_directory(path: &Path) -> Result<(), KernelError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| KernelError::Io)
}

fn map_lease_error(error: LeaseError) -> KernelError {
    match error {
        LeaseError::Held { .. } => KernelError::Held,
        LeaseError::Io(_) => KernelError::Io,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_read_connections_are_query_only() {
        let directory = tempfile::tempdir().unwrap();
        let store = KernelStore::open(directory.path()).unwrap();
        store
            .with_reader(|connection| {
                assert_eq!(
                    connection.query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))?,
                    1
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn stale_writer_fence_blocks_the_operation() {
        let directory = tempfile::tempdir().unwrap();
        let store = KernelStore::open(directory.path()).unwrap();
        store
            .with_writer(|connection| {
                connection.execute(
                    "UPDATE writer_fence SET writer_epoch=writer_epoch+1 WHERE id=0",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let mut called = false;
        let error = store
            .with_writer(|_| {
                called = true;
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error, KernelError::FenceLost);
        assert!(!called);
    }

    #[test]
    fn failed_writer_operation_leaves_no_partial_write() {
        let directory = tempfile::tempdir().unwrap();
        let store = KernelStore::open(directory.path()).unwrap();
        let error = store
            .with_writer(|tx| -> rusqlite::Result<()> {
                tx.execute(
                    "INSERT INTO commit_log(
                         transaction_id,writer_epoch,producer,operation_key,request_digest,
                         recorded_at,actor,cause
                     ) VALUES('t1',1,'fixture','t1','',1,'actor','cause')",
                    [],
                )?;
                Err(rusqlite::Error::InvalidQuery)
            })
            .unwrap_err();
        assert_eq!(error, KernelError::Io);
        store
            .with_reader(|tx| {
                assert_eq!(
                    tx.query_row("SELECT COUNT(*) FROM commit_log", [], |row| row
                        .get::<_, i64>(0))?,
                    0
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn store_connections_run_delete_triggers_for_replace() {
        // The schema-level guard test drives a connection built by
        // `apply_kernel_connection_profile`, so it cannot observe the pragmas
        // `KernelStore` sets on its own writer.
        let directory = tempfile::tempdir().unwrap();
        let store = KernelStore::open(directory.path()).unwrap();
        store
            .with_writer(|tx| {
                assert_eq!(
                    tx.query_row("PRAGMA recursive_triggers", [], |row| row.get::<_, i64>(0))?,
                    1
                );
                tx.execute(
                    "INSERT INTO commit_log(
                         transaction_id,writer_epoch,producer,operation_key,request_digest,
                         recorded_at,actor,cause
                     ) VALUES('t1',1,'fixture','t1','',1,'actor','cause')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let commit_seq = store
            .with_reader(|tx| {
                tx.query_row("SELECT commit_seq FROM commit_log", [], |row| {
                    row.get::<_, i64>(0)
                })
            })
            .unwrap();

        for verb in ["INSERT OR REPLACE", "REPLACE"] {
            let error = store
                .with_writer(|tx| {
                    tx.execute(
                        &format!(
                            "{verb} INTO commit_log(
                                 commit_seq,transaction_id,writer_epoch,producer,operation_key,
                                 request_digest,recorded_at,actor,cause
                             ) VALUES(?1,'hijack',1,'fixture','hijack','',1,'attacker','rewrite')"
                        ),
                        [commit_seq],
                    )?;
                    Ok(())
                })
                .unwrap_err();
            assert_eq!(error, KernelError::Io, "{verb} must be refused");
        }

        store
            .with_reader(|tx| {
                assert_eq!(
                    tx.query_row("SELECT actor FROM commit_log", [], |row| row
                        .get::<_, String>(0))?,
                    "actor"
                );
                Ok(())
            })
            .unwrap();
    }
}
