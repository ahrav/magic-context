use cortexkit_lease::{
    protect_file, FileLeaseStore, LeaseError, LeaseHandle, LeaseKey, LeaseStore,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use super::schema::{
    apply_kernel_schema, kernel_schema_digest, kernel_schema_object_inventory,
    KERNEL_APPLICATION_ID, KERNEL_FORMAT_EPOCH,
};
use crate::sqlite_runtime::{
    compute_marker_digest_for_application_id, evaluate_sqlite_runtime_gate,
    probe_sqlite_engine_identity_off_path, SqliteEngineIdentity,
};

const BUSY_TIMEOUT_MS: i64 = 5_000;
const READ_POOL_SIZE: usize = 2;
const RESET_MARKER_PROTOCOL: &str = "mc-kernel-reset-marker-v1";
const RESET_MARKER_SUFFIX: &str = ".mc-reset";
const RESTORE_MARKER_SUFFIX: &str = ".mc-restore";
const QUARANTINE_INFIX: &str = ".mc-quarantine-";
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum KernelError {
    Held,
    EngineUnsupported,
    Foreign,
    Inconclusive,
    Io,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelErrorKind {
    Held,
    EngineUnsupported,
    Foreign,
    Inconclusive,
    Io,
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
    pub fn kind(self) -> KernelErrorKind {
        match self {
            Self::Held => KernelErrorKind::Held,
            Self::EngineUnsupported => KernelErrorKind::EngineUnsupported,
            Self::Foreign => KernelErrorKind::Foreign,
            Self::Inconclusive => KernelErrorKind::Inconclusive,
            Self::Io => KernelErrorKind::Io,
            Self::IdentityMismatch => KernelErrorKind::IdentityMismatch,
            Self::FenceLost => KernelErrorKind::FenceLost,
            Self::Conflict => KernelErrorKind::Conflict,
            Self::InvalidInput => KernelErrorKind::InvalidInput,
            Self::FutureSnapshot => KernelErrorKind::FutureSnapshot,
            Self::NotFound => KernelErrorKind::NotFound,
            Self::InvalidCheckpoint => KernelErrorKind::InvalidCheckpoint,
            Self::NoRequiredConsumers => KernelErrorKind::NoRequiredConsumers,
            Self::ConsumerPending => KernelErrorKind::ConsumerPending,
            Self::Fault => KernelErrorKind::Fault,
            Self::Deadline => KernelErrorKind::Deadline,
            Self::UnsafeDestination => KernelErrorKind::UnsafeDestination,
            Self::InvalidBackup => KernelErrorKind::InvalidBackup,
            Self::InvalidRestore => KernelErrorKind::InvalidRestore,
        }
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
            Self::UnsafeDestination => "kernel backup destination is unsafe",
            Self::InvalidBackup => "kernel backup could not be verified",
            Self::InvalidRestore => "kernel restore source could not be verified",
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
        let root = absolute_path(root.as_ref())?;
        prepare_root(&root)?;
        let db_path = root.join("core.sqlite");
        let lease_store = FileLeaseStore::new(root.join("leases"));
        let lease_key = LeaseKey::new("magic-context-kernel", "sqlite", "core");
        let lease = lease_store.acquire(&lease_key).map_err(map_lease_error)?;
        let lease_epoch = lease.epoch();

        // The lease excludes concurrent opens while either path moves the database family.
        if marker_present(&restore_marker_path(&db_path))? {
            super::backup::resume_restore(&db_path)?;
        }

        if marker_present(&reset_marker_path(&db_path))? {
            resume_quarantine(&db_path)?;
        }

        let expected = expected_identity()?;
        let header = inspect_header(&db_path)?;
        let mut writer = match header {
            HeaderState::Pristine => bootstrap(&db_path)?,
            HeaderState::Kernel => {
                let mut conn = open_writer(&db_path).map_err(|_| KernelError::Inconclusive)?;
                apply_preclassification_profile(&conn).map_err(|_| KernelError::Inconclusive)?;
                match classify_open_kernel(&mut conn, &expected)? {
                    OpenIdentity::Exact => conn,
                    OpenIdentity::Mismatch { incarnation } => {
                        drop(conn);
                        quarantine(&db_path, &incarnation, lease_epoch)?;
                        bootstrap(&db_path)?
                    }
                }
            }
        };

        activate_wal(&writer)?;
        stamp_writer_fence(&mut writer, lease_epoch)?;
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
        store.run_capture_pin_maintenance(current_time_ms())?;
        store.run_staging_maintenance(current_time_ms())?;
        Ok(store)
    }

    pub fn lease_epoch(&self) -> u64 {
        self.lease_epoch
    }

    pub(super) fn lock_writer(&self) -> Result<std::sync::MutexGuard<'_, Connection>, KernelError> {
        if self.poisoned.load(Ordering::Acquire) {
            return Err(KernelError::InvalidRestore);
        }
        let writer = self.writer.lock().map_err(|_| KernelError::Io)?;
        if self.poisoned.load(Ordering::Acquire) {
            return Err(KernelError::InvalidRestore);
        }
        Ok(writer)
    }

    pub(super) fn lock_reader(&self) -> Result<std::sync::MutexGuard<'_, Connection>, KernelError> {
        if self.poisoned.load(Ordering::Acquire) {
            return Err(KernelError::InvalidRestore);
        }
        let index = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        let reader = self.readers[index].lock().map_err(|_| KernelError::Io)?;
        if self.poisoned.load(Ordering::Acquire) {
            return Err(KernelError::InvalidRestore);
        }
        Ok(reader)
    }

    pub(super) fn poison(&self) {
        self.poisoned.store(true, Ordering::Release);
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

    #[cfg(feature = "test-support")]
    pub fn set_writer_fence_for_test(&self, epoch: i64) -> Result<(), KernelError> {
        let writer = self.lock_writer()?;
        writer
            .execute(
                "UPDATE writer_fence SET writer_epoch=?1 WHERE id=0",
                [epoch],
            )
            .map_err(|_| KernelError::Io)?;
        Ok(())
    }
}

// `Path::exists` reports false for EACCES, EIO and ELOOP as well as for a
// missing file, which would let an unreadable marker pass as absent.
fn marker_present(path: &Path) -> Result<bool, KernelError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(KernelError::Inconclusive),
    }
}

enum HeaderState {
    Pristine,
    Kernel,
}

fn inspect_header(path: &Path) -> Result<HeaderState, KernelError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if family_sidecars(path).iter().any(|sidecar| sidecar.exists()) {
                return Err(KernelError::Inconclusive);
            }
            return Ok(HeaderState::Pristine);
        }
        Err(_) => return Err(KernelError::Io),
    };
    if !metadata.is_file() {
        return Err(KernelError::Inconclusive);
    }
    if metadata.len() == 0 {
        if family_sidecars(path).iter().any(|sidecar| sidecar.exists()) {
            return Err(KernelError::Inconclusive);
        }
        return Ok(HeaderState::Pristine);
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

fn expected_identity() -> Result<ExpectedIdentity, KernelError> {
    let mut conn = Connection::open_in_memory().map_err(|_| KernelError::Io)?;
    apply_kernel_schema(&mut conn, "00000000000000000000000000000000", 0)
        .map_err(|_| KernelError::Io)?;
    Ok(ExpectedIdentity {
        digest: kernel_schema_digest(&conn).map_err(|_| KernelError::Io)?,
        inventory: kernel_schema_object_inventory(&conn).map_err(|_| KernelError::Io)?,
    })
}

enum OpenIdentity {
    Exact,
    Mismatch { incarnation: String },
}

pub(super) fn verify_exact_identity(conn: &mut Connection) -> Result<(), KernelError> {
    let integrity_check: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|_| KernelError::Inconclusive)?;
    if integrity_check != "ok" {
        return Err(KernelError::Inconclusive);
    }
    match classify_open_kernel(conn, &expected_identity()?)? {
        OpenIdentity::Exact => Ok(()),
        OpenIdentity::Mismatch { .. } => Err(KernelError::IdentityMismatch),
    }
}

struct FormatMarker {
    epoch: i64,
    incarnation: String,
    schema_digest: String,
    created_at: i64,
    marker_digest: String,
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
    let mut statement = conn
        .prepare(
            "SELECT format_epoch,database_incarnation_id,schema_digest,created_at,marker_digest
             FROM mc_kernel_format_marker",
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

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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
    Ok(())
}

pub(super) fn activate_wal(conn: &Connection) -> Result<(), KernelError> {
    // A refused WAL conversion returns the original mode; verify the returned mode.
    let mode: String = conn
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
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

fn open_read_pool(path: &Path) -> Result<Vec<Mutex<Connection>>, KernelError> {
    (0..READ_POOL_SIZE)
        .map(|_| open_reader(path).map(Mutex::new))
        .collect()
}

pub(super) fn open_reader(path: &Path) -> Result<Connection, KernelError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| KernelError::Io)?;
    conn.pragma_update(None, "query_only", "ON")
        .map_err(|_| KernelError::Io)?;
    apply_preclassification_profile(&conn).map_err(|_| KernelError::Io)?;
    Ok(conn)
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
    let bytes = fs::read(reset_marker_path(path)).map_err(|_| KernelError::Inconclusive)?;
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

fn publish_reset_marker(path: &Path, marker: &ResetMarker) -> Result<(), KernelError> {
    let marker_path = reset_marker_path(path);
    let bytes = serde_json::to_vec(marker).map_err(|_| KernelError::Io)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&marker_path).map_err(|_| KernelError::Io)?;
    if file
        .write_all(&bytes)
        .and_then(|()| file.sync_all())
        .is_err()
    {
        drop(file);
        let _ = fs::remove_file(&marker_path);
        return Err(KernelError::Io);
    }
    protect_file(&marker_path).map_err(|_| KernelError::Io)?;
    sync_parent(path)?;
    Ok(())
}

fn move_family(path: &Path, marker: &ResetMarker) -> Result<(), KernelError> {
    prepare_private_dir(&marker.quarantine_dir)?;
    for source in [
        suffix_path(path, "-journal"),
        suffix_path(path, "-wal"),
        suffix_path(path, "-shm"),
        path.to_path_buf(),
    ] {
        move_one(&source, &marker.quarantine_dir)?;
    }
    let marker_path = reset_marker_path(path);
    move_one(&marker_path, &marker.quarantine_dir)?;
    sync_directory(&marker.quarantine_dir)?;
    sync_parent(path)
}

fn move_one(source: &Path, destination_dir: &Path) -> Result<(), KernelError> {
    let name = source.file_name().ok_or(KernelError::Inconclusive)?;
    let destination = destination_dir.join(name);
    let source_exists = source.exists();
    let destination_exists = destination.exists();
    match (source_exists, destination_exists) {
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
    let base = PathBuf::from(format!(
        "{}{}{}",
        path.display(),
        QUARANTINE_INFIX,
        lease_epoch
    ));
    for suffix in 0..10_000_u32 {
        let candidate = if suffix == 0 {
            base.clone()
        } else {
            PathBuf::from(format!("{}-{suffix}", base.display()))
        };
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(KernelError::Io)
}

fn valid_quarantine_path(path: &Path, quarantine: &Path) -> bool {
    quarantine.parent() == path.parent()
        && quarantine.file_name().is_some_and(|name| {
            name.to_string_lossy().starts_with(&format!(
                "{}{}",
                path.file_name().unwrap_or_default().to_string_lossy(),
                QUARANTINE_INFIX
            ))
        })
}

fn reset_marker_path(path: &Path) -> PathBuf {
    suffix_path(path, RESET_MARKER_SUFFIX)
}

pub(super) fn restore_marker_path(path: &Path) -> PathBuf {
    suffix_path(path, RESTORE_MARKER_SUFFIX)
}

// `Path::display` is lossy, so a non-UTF-8 database path would yield a sidecar
// path that names a different file.
pub(super) fn suffix_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn absolute_path(path: &Path) -> Result<PathBuf, KernelError> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|current| current.join(path))
            .map_err(|_| KernelError::Io)
    }
}

fn prepare_root(root: &Path) -> Result<(), KernelError> {
    fs::create_dir_all(root).map_err(|_| KernelError::Io)?;
    prepare_private_dir(root)
}

fn prepare_private_dir(path: &Path) -> Result<(), KernelError> {
    if !path.exists() {
        fs::create_dir(path).map_err(|_| KernelError::Io)?;
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| KernelError::Io)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(KernelError::Io);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| KernelError::Io)?;
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

pub(super) fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn map_lease_error(error: LeaseError) -> KernelError {
    match error {
        LeaseError::Held { .. } => KernelError::Held,
        LeaseError::Io(_) => KernelError::Io,
    }
}
