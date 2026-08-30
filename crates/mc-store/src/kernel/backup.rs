use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use rusqlite::backup::{Backup, StepResult};
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use rustix::fs::{self as rfs, Mode, OFlags};
use serde::Serialize;

use super::durable_fs::{
    create_new_file, create_secure_directory, durable_unlink, next_unique_id,
    publish_noreplace_locked, sync_directory as sync_directory_fd, temp_name as durable_temp_name,
    write_and_sync, PublishOutcome,
};
use super::envelope::check_fence;
use super::open::{
    activate_wal, apply_preclassification_profile, current_time_ms, family_sidecars, harden_family,
    open_reader, open_writer, restore_marker_path, stamp_writer_fence, sync_directory, sync_parent,
    verify_exact_identity,
};
use super::{KernelError, KernelStore, Sensitivity};

const BACKUP_PAGES_PER_STEP: i32 = 128;
const DEFAULT_CAPTURE_PIN_LIFETIME_MS: i64 = 24 * 60 * 60 * 1_000;
const BACKUP_PREFIX: &str = "core-backup-";
const RESTORE_INFIX: &str = ".mc-restore-";
const RESTORE_MARKER_PROTOCOL: &str = "mc-kernel-restore-marker-v1";
#[cfg(target_os = "linux")]
const LOCAL_FILESYSTEMS: &[i64] = &[
    0x0000_ef53, // ext2, ext3, ext4
    0x5846_5342, // XFS
    0x9123_683e, // Btrfs
    0x0102_1994, // tmpfs
    0x8584_58f6, // ramfs
    0x794c_7630, // overlayfs
    0x2fc1_2fc1, // ZFS
    0x0000_f15f, // eCryptfs
    0x2405_1905, // UBIFS
    0xf2f5_2010, // F2FS
    0x0000_72b6, // JFFS2
    0x5265_4973, // ReiserFS
    0x0000_3434, // NILFS
];

#[derive(Debug, Clone)]
pub struct BackupRequest {
    pub destination_directory: PathBuf,
    pub deadline: Instant,
    pub capture_pin_expires_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupManifest {
    pub captured_commit_seq: i64,
    pub evidence_refs: Vec<String>,
    pub max_sensitivity: Sensitivity,
    pub capture_pin_id: Option<String>,
    pub destination_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupResult {
    pub manifest: BackupManifest,
}

#[cfg(feature = "test-support")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupFault {
    BeforeRename,
}

#[cfg(feature = "test-support")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreFault {
    AfterDisplace,
    RecoveryFailure,
}

struct CaptureState {
    commit_seq: i64,
    evidence_refs: Vec<String>,
    max_sensitivity: Sensitivity,
    pin_id: Option<String>,
}

impl KernelStore {
    pub fn backup(&self, request: BackupRequest) -> Result<BackupResult, KernelError> {
        self.backup_inner(request, false, None, None)
    }

    #[cfg(feature = "test-support")]
    pub fn backup_with_fault_for_test(
        &self,
        request: BackupRequest,
        fault: BackupFault,
    ) -> Result<BackupResult, KernelError> {
        self.backup_inner(request, fault == BackupFault::BeforeRename, None, None)
    }

    #[cfg(feature = "test-support")]
    pub fn backup_with_hook_for_test(
        &self,
        request: BackupRequest,
        mut hook: impl FnMut(),
    ) -> Result<BackupResult, KernelError> {
        self.backup_inner(request, false, Some(&mut hook), None)
    }

    #[cfg(feature = "test-support")]
    pub fn backup_with_final_name_for_test(
        &self,
        request: BackupRequest,
        final_name: &str,
    ) -> Result<BackupResult, KernelError> {
        self.backup_inner(request, false, None, Some(final_name))
    }

    fn backup_inner(
        &self,
        request: BackupRequest,
        fault_before_rename: bool,
        mut hook: Option<&mut dyn FnMut()>,
        final_name_override: Option<&str>,
    ) -> Result<BackupResult, KernelError> {
        let destination = secure_destination(&request.destination_directory)?;
        if Instant::now() >= request.deadline {
            return Err(KernelError::Deadline);
        }
        let mut writer = self.lock_writer()?;
        if Instant::now() >= request.deadline {
            return Err(KernelError::Deadline);
        }
        let capture = capture_state(
            &mut writer,
            self.lease_epoch(),
            request.capture_pin_expires_at,
        )?;
        let unique = next_unique_id();
        let final_name = final_name_override
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{BACKUP_PREFIX}{}-{unique}.sqlite", capture.commit_seq));
        let temp_name = durable_temp_name(&format!("{BACKUP_PREFIX}{}", capture.commit_seq));
        let final_path = request.destination_directory.join(&final_name);

        let mut published = false;
        let result = (|| {
            drop(create_new_file(&destination, &temp_name).map_err(|_| KernelError::Io)?);
            if let Some(callback) = hook.as_mut() {
                callback();
            }
            let sqlite_temp_path = fd_child_path(&destination, &temp_name);
            let mut target = Connection::open_with_flags(
                &sqlite_temp_path,
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|_| KernelError::InvalidBackup)?;
            {
                let backup =
                    Backup::new(&writer, &mut target).map_err(|_| KernelError::InvalidBackup)?;
                loop {
                    if Instant::now() >= request.deadline {
                        return Err(KernelError::Deadline);
                    }
                    match backup
                        .step(BACKUP_PAGES_PER_STEP)
                        .map_err(|_| KernelError::InvalidBackup)?
                    {
                        StepResult::Done => break,
                        StepResult::More | StepResult::Busy | StepResult::Locked => {
                            std::thread::yield_now();
                        }
                        _ => return Err(KernelError::InvalidBackup),
                    }
                }
            }
            drop(target);
            if Instant::now() >= request.deadline {
                return Err(KernelError::Deadline);
            }
            verify_database(
                &sqlite_temp_path,
                Some(capture.commit_seq),
                KernelError::InvalidBackup,
                Some(request.deadline),
            )?;
            if Instant::now() >= request.deadline {
                return Err(KernelError::Deadline);
            }
            File::open(&sqlite_temp_path)
                .and_then(|file| file.sync_all())
                .map_err(|_| KernelError::Io)?;
            if Instant::now() >= request.deadline {
                return Err(KernelError::Deadline);
            }
            if fault_before_rename {
                return Err(KernelError::Fault);
            }
            if publish_noreplace_locked(&destination, &temp_name, &final_name)
                .map_err(|_| KernelError::Io)?
                == PublishOutcome::AlreadyExists
            {
                return Err(KernelError::Io);
            }
            published = true;
            cleanup_backup_sidecars(&destination, &temp_name)?;
            if Instant::now() >= request.deadline {
                return Err(KernelError::Deadline);
            }
            sync_directory_fd(&destination).map_err(|_| KernelError::Io)?;
            if Instant::now() >= request.deadline {
                return Err(KernelError::Deadline);
            }
            Ok(BackupResult {
                manifest: BackupManifest {
                    captured_commit_seq: capture.commit_seq,
                    evidence_refs: capture.evidence_refs.clone(),
                    max_sensitivity: capture.max_sensitivity,
                    capture_pin_id: capture.pin_id.clone(),
                    destination_path: final_path.clone(),
                },
            })
        })();

        if result.is_err() {
            cleanup_backup_family(&destination, &temp_name);
            if published {
                cleanup_backup_family(&destination, &final_name);
            }
            let _ = destination.sync_all();
            if let Some(pin_id) = capture.pin_id.as_deref() {
                rollback_capture_pin(&mut writer, self.lease_epoch(), pin_id);
            }
        }
        result
    }

    pub fn release_capture_pin(
        &self,
        capture_pin_id: &str,
        released_at: i64,
    ) -> Result<(), KernelError> {
        if capture_pin_id.trim().is_empty() || released_at < 0 {
            return Err(KernelError::InvalidInput);
        }
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        check_fence(&tx, self.lease_epoch())?;
        let changed = tx
            .execute(
                "UPDATE capture_pins SET released_at=?1
                 WHERE capture_pin_id=?2 AND released_at IS NULL",
                params![released_at, capture_pin_id],
            )
            .map_err(|_| KernelError::Io)?;
        if changed != 1 {
            return Err(KernelError::NotFound);
        }
        tx.execute(
            "UPDATE capture_pin_refs SET released_at=?1
             WHERE capture_pin_id=?2 AND released_at IS NULL",
            params![released_at, capture_pin_id],
        )
        .map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)
    }

    pub(super) fn run_capture_pin_maintenance(&self, now_ms: i64) -> Result<(), KernelError> {
        let mut writer = self.lock_writer()?;
        let tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        check_fence(&tx, self.lease_epoch())?;
        tx.execute(
            "UPDATE capture_pins SET released_at=?1
             WHERE released_at IS NULL AND expires_at IS NOT NULL AND expires_at<=?1",
            [now_ms],
        )
        .map_err(|_| KernelError::Io)?;
        tx.execute(
            "UPDATE capture_pin_refs
             SET released_at=(SELECT released_at FROM capture_pins
                              WHERE capture_pin_id=capture_pin_refs.capture_pin_id)
             WHERE released_at IS NULL AND capture_pin_id IN (
                 SELECT capture_pin_id FROM capture_pins WHERE released_at IS NOT NULL
             )",
            [],
        )
        .map_err(|_| KernelError::Io)?;
        tx.commit().map_err(|_| KernelError::Io)
    }

    #[cfg(feature = "test-support")]
    pub fn run_capture_pin_maintenance_for_test(&self, now_ms: i64) -> Result<(), KernelError> {
        self.run_capture_pin_maintenance(now_ms)
    }

    pub fn restore(&self, backup_path: impl AsRef<Path>) -> Result<i64, KernelError> {
        self.restore_inner(backup_path.as_ref(), false, false, None)
    }

    #[cfg(feature = "test-support")]
    pub fn restore_with_hook_for_test(
        &self,
        backup_path: impl AsRef<Path>,
        mut hook: impl FnMut(),
    ) -> Result<i64, KernelError> {
        self.restore_inner(backup_path.as_ref(), false, false, Some(&mut hook))
    }

    #[cfg(feature = "test-support")]
    pub fn restore_with_fault_for_test(
        &self,
        backup_path: impl AsRef<Path>,
        fault: RestoreFault,
    ) -> Result<i64, KernelError> {
        self.restore_inner(
            backup_path.as_ref(),
            true,
            fault == RestoreFault::RecoveryFailure,
            None,
        )
    }

    fn restore_inner(
        &self,
        backup_path: &Path,
        fault_after_displace: bool,
        force_recovery_failure: bool,
        mut hook: Option<&mut dyn FnMut()>,
    ) -> Result<i64, KernelError> {
        let mut source = open_private_regular_nofollow(backup_path)?;
        let source_seq =
            verify_database(&fd_path(&source), None, KernelError::InvalidRestore, None)?;

        let mut writer = self.lock_writer()?;
        let mut readers = self
            .readers
            .iter()
            .map(|reader| reader.lock().map_err(|_| KernelError::Io))
            .collect::<Result<Vec<_>, _>>()?;
        let fence_tx = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| KernelError::Io)?;
        check_fence(&fence_tx, self.lease_epoch())?;
        let live_seq = fence_tx
            .query_row(
                "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| KernelError::Io)?;
        fence_tx.commit().map_err(|_| KernelError::Io)?;
        let recovery_dir = allocate_recovery_dir(&self.db_path)?;
        let temp_path = restore_temp_path(&self.db_path);
        let mut temporary = (0..=readers.len())
            .map(|_| Connection::open_in_memory().map_err(|_| KernelError::Io))
            .collect::<Result<Vec<_>, _>>()?;
        if let Err(error) = publish_restore_marker(&self.db_path, &recovery_dir) {
            let _ = fs::remove_dir(&recovery_dir);
            return Err(error);
        }
        let temporary_writer = temporary.remove(0);
        let old_writer = std::mem::replace(&mut *writer, temporary_writer);
        let old_readers = readers
            .iter_mut()
            .zip(temporary)
            .map(|(guard, replacement)| std::mem::replace(&mut **guard, replacement))
            .collect::<Vec<_>>();
        drop(old_readers);
        drop(old_writer);
        let mut displaced = false;
        let restore_result = (|| {
            displace_family(&self.db_path, &recovery_dir)?;
            displaced = true;
            if let Some(callback) = hook.as_mut() {
                callback();
            }
            if fault_after_displace {
                return Err(KernelError::Fault);
            }
            copy_to_private_temp(&mut source, &temp_path)?;
            fs::rename(&temp_path, &self.db_path).map_err(|_| KernelError::Io)?;
            sync_parent(&self.db_path)?;
            let opened =
                open_live_family(&self.db_path, self.lease_epoch(), source_seq, readers.len())?;
            remove_restore_marker(&self.db_path)?;
            cleanup_recovery_dir(&self.db_path, &recovery_dir);
            Ok(opened)
        })();

        match restore_result {
            Ok((new_writer, new_readers)) => {
                *writer = new_writer;
                for (guard, connection) in readers.iter_mut().zip(new_readers) {
                    **guard = connection;
                }
                Ok(source_seq)
            }
            Err(error) => {
                let _ = fs::remove_file(&temp_path);
                if displaced {
                    let _ = remove_family(&self.db_path);
                }
                let recovered = if force_recovery_failure {
                    Err(KernelError::InvalidRestore)
                } else {
                    match restore_displaced_family(&self.db_path, &recovery_dir) {
                        Ok(()) => match open_live_family(
                            &self.db_path,
                            self.lease_epoch(),
                            live_seq,
                            readers.len(),
                        ) {
                            Ok(opened) => Ok(opened),
                            Err(error) => {
                                let _ = displace_family(&self.db_path, &recovery_dir);
                                Err(error)
                            }
                        },
                        Err(error) => {
                            let _ = displace_family(&self.db_path, &recovery_dir);
                            Err(error)
                        }
                    }
                };
                match recovered {
                    Ok((original_writer, original_readers)) => {
                        *writer = original_writer;
                        for (guard, connection) in readers.iter_mut().zip(original_readers) {
                            **guard = connection;
                        }
                        if remove_restore_marker(&self.db_path).is_err() {
                            self.poison();
                            return Err(KernelError::InvalidRestore);
                        }
                        cleanup_recovery_dir(&self.db_path, &recovery_dir);
                        Err(error)
                    }
                    Err(_) => {
                        self.poison();
                        Err(KernelError::InvalidRestore)
                    }
                }
            }
        }
    }
}

fn secure_destination(path: &Path) -> Result<File, KernelError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| KernelError::UnsafeDestination)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o077 != 0
        || !owner_is_current(metadata.uid())
    {
        return Err(KernelError::UnsafeDestination);
    }
    let directory = File::open(path).map_err(|_| KernelError::UnsafeDestination)?;
    let opened = directory
        .metadata()
        .map_err(|_| KernelError::UnsafeDestination)?;
    if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
        return Err(KernelError::UnsafeDestination);
    }
    classify_destination_filesystem(&directory)?;
    Ok(directory)
}

#[cfg(target_os = "linux")]
fn classify_destination_filesystem(directory: &File) -> Result<(), KernelError> {
    let filesystem = rfs::fstatfs(directory).map_err(|_| KernelError::UnsafeDestination)?;
    if filesystem_is_unsafe(filesystem.f_type as i64) {
        return Err(KernelError::UnsafeDestination);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn classify_destination_filesystem(directory: &File) -> Result<(), KernelError> {
    let filesystem = rfs::fstatfs(directory).map_err(|_| KernelError::UnsafeDestination)?;
    let end = filesystem
        .f_fstypename
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(filesystem.f_fstypename.len());
    let name = filesystem.f_fstypename[..end]
        .iter()
        .map(|byte| *byte as u8)
        .collect::<Vec<_>>();
    let name = std::str::from_utf8(&name).map_err(|_| KernelError::UnsafeDestination)?;
    if filesystem_name_is_unsafe(name) {
        return Err(KernelError::UnsafeDestination);
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn classify_destination_filesystem(_directory: &File) -> Result<(), KernelError> {
    Err(KernelError::UnsafeDestination)
}

fn filesystem_is_unsafe(fs_type: i64) -> bool {
    #[cfg(target_os = "linux")]
    {
        !LOCAL_FILESYSTEMS.contains(&fs_type)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = fs_type;
        true
    }
}

#[cfg(any(target_os = "macos", feature = "test-support"))]
fn filesystem_name_is_unsafe(name: &str) -> bool {
    !matches!(name, "apfs" | "hfs" | "tmpfs")
}

#[cfg(feature = "test-support")]
pub fn filesystem_is_unsafe_for_test(fs_type: i64) -> bool {
    filesystem_is_unsafe(fs_type)
}

#[cfg(feature = "test-support")]
pub fn filesystem_name_is_unsafe_for_test(name: &str) -> bool {
    filesystem_name_is_unsafe(name)
}

fn owner_is_current(uid: u32) -> bool {
    uid == rustix::process::geteuid().as_raw()
}

#[cfg(feature = "test-support")]
pub fn owner_is_current_for_test(uid: u32) -> bool {
    owner_is_current(uid)
}

fn capture_state(
    writer: &mut Connection,
    lease_epoch: u64,
    expires_at: Option<i64>,
) -> Result<CaptureState, KernelError> {
    let tx = writer
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| KernelError::Io)?;
    check_fence(&tx, lease_epoch)?;
    let commit_seq = tx
        .query_row(
            "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| KernelError::Io)?;
    let evidence_refs = tx
        .prepare(
            "SELECT evidence_id FROM evidence_meta
             WHERE created_commit_seq<=?1
               AND (invalidated_commit_seq IS NULL OR invalidated_commit_seq>?1)
             ORDER BY evidence_id",
        )
        .and_then(|mut statement| {
            statement
                .query_map([commit_seq], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|_| KernelError::Io)?;
    let sensitive = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM object_registry WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM domains WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM entities WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM entity_aliases WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM propositions WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM predicate_schemas WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM scopes WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM anchors WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM evidence_meta WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM asserted_edges WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM relation_registry WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM extraction_runs WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM candidates WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM decisions WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM observations WHERE sensitivity_class<>'normal')
                 OR EXISTS(SELECT 1 FROM outbox WHERE sensitivity_class<>'normal')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|_| KernelError::Io)?;
    let created_at = current_time_ms();
    let expires_at =
        expires_at.unwrap_or_else(|| created_at.saturating_add(DEFAULT_CAPTURE_PIN_LIFETIME_MS));
    if expires_at < created_at {
        return Err(KernelError::InvalidInput);
    }
    let pin_id = if evidence_refs.is_empty() {
        None
    } else {
        let pin_id: String = tx
            .query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
            .map_err(|_| KernelError::Io)?;
        let epoch = i64::try_from(lease_epoch).map_err(|_| KernelError::InvalidInput)?;
        tx.execute(
            "INSERT INTO capture_pins(
                 capture_pin_id,pin_kind,owner_id,commit_seq,lease_epoch,writer_epoch,
                 created_at,expires_at
             ) VALUES (?1,'backup',?2,?3,?4,?4,?5,?6)",
            params![
                pin_id,
                format!("backup:{commit_seq}"),
                commit_seq,
                epoch,
                created_at,
                expires_at,
            ],
        )
        .map_err(|_| KernelError::Io)?;
        for evidence_id in &evidence_refs {
            tx.execute(
                "INSERT INTO capture_pin_refs(capture_pin_id,evidence_id,expires_at)
                 VALUES (?1,?2,?3)",
                params![pin_id, evidence_id, expires_at],
            )
            .map_err(|_| KernelError::Io)?;
        }
        Some(pin_id)
    };
    tx.commit().map_err(|_| KernelError::Io)?;
    Ok(CaptureState {
        commit_seq,
        evidence_refs,
        max_sensitivity: if sensitive {
            Sensitivity::Sensitive
        } else {
            Sensitivity::Normal
        },
        pin_id,
    })
}

fn rollback_capture_pin(writer: &mut Connection, lease_epoch: u64, pin_id: &str) {
    let Ok(tx) = writer.transaction_with_behavior(TransactionBehavior::Immediate) else {
        return;
    };
    if check_fence(&tx, lease_epoch).is_err() {
        return;
    }
    if tx
        .execute(
            "DELETE FROM capture_pin_refs WHERE capture_pin_id=?1",
            [pin_id],
        )
        .and_then(|_| tx.execute("DELETE FROM capture_pins WHERE capture_pin_id=?1", [pin_id]))
        .is_ok()
    {
        let _ = tx.commit();
    }
}

fn cleanup_backup_family(directory: &File, name: &str) {
    for candidate in [
        name.to_string(),
        format!("{name}-journal"),
        format!("{name}-wal"),
        format!("{name}-shm"),
    ] {
        let _ = durable_unlink(directory, &candidate);
    }
}

fn cleanup_backup_sidecars(directory: &File, name: &str) -> Result<(), KernelError> {
    for candidate in [
        format!("{name}-journal"),
        format!("{name}-wal"),
        format!("{name}-shm"),
    ] {
        durable_unlink(directory, &candidate).map_err(|_| KernelError::Io)?;
    }
    Ok(())
}

fn verify_database(
    path: &Path,
    expected_seq: Option<i64>,
    invalid_error: KernelError,
    deadline: Option<Instant>,
) -> Result<i64, KernelError> {
    if deadline.is_some_and(|value| Instant::now() >= value) {
        return Err(KernelError::Deadline);
    }
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| invalid_error)?;
    apply_preclassification_profile(&connection).map_err(|_| invalid_error)?;
    let interrupted = Arc::new(AtomicBool::new(false));
    if let Some(deadline) = deadline {
        let interrupted = Arc::clone(&interrupted);
        connection
            .progress_handler(
                1_000,
                Some(move || {
                    let expired = Instant::now() >= deadline;
                    if expired {
                        interrupted.store(true, Ordering::Release);
                    }
                    expired
                }),
            )
            .map_err(|_| invalid_error)?;
    }
    let verification_error = || {
        if interrupted.load(Ordering::Acquire) {
            KernelError::Deadline
        } else {
            invalid_error
        }
    };
    verify_exact_identity(&mut connection).map_err(|_| verification_error())?;
    let commit_seq = connection
        .query_row(
            "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| verification_error())?;
    if expected_seq.is_some_and(|expected| expected != commit_seq) {
        return Err(invalid_error);
    }
    Ok(commit_seq)
}

#[cfg(feature = "test-support")]
pub fn verify_backup_with_deadline_for_test(
    path: &Path,
    expected_seq: i64,
    deadline: Instant,
) -> Result<i64, KernelError> {
    verify_database(
        path,
        Some(expected_seq),
        KernelError::InvalidBackup,
        Some(deadline),
    )
}

#[derive(Serialize)]
struct RestoreMarker<'a> {
    protocol: &'static str,
    database_path: &'a Path,
    recovery_directory: &'a Path,
}

fn publish_restore_marker(path: &Path, recovery_dir: &Path) -> Result<(), KernelError> {
    let marker_path = restore_marker_path(path);
    let temp_path = PathBuf::from(format!(
        "{}.{}.tmp",
        marker_path.display(),
        next_unique_id()
    ));
    let bytes = serde_json::to_vec(&RestoreMarker {
        protocol: RESTORE_MARKER_PROTOCOL,
        database_path: path,
        recovery_directory: recovery_dir,
    })
    .map_err(|_| KernelError::Io)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    let mut file = options.open(&temp_path).map_err(|_| KernelError::Io)?;
    if write_and_sync(&mut file, &bytes).is_err() {
        drop(file);
        let _ = fs::remove_file(&temp_path);
        return Err(KernelError::Io);
    }
    drop(file);
    if fs::rename(&temp_path, &marker_path).is_err() {
        let _ = fs::remove_file(&temp_path);
        return Err(KernelError::Io);
    }
    sync_parent(path)
}

fn remove_restore_marker(path: &Path) -> Result<(), KernelError> {
    fs::remove_file(restore_marker_path(path)).map_err(|_| KernelError::Io)?;
    sync_parent(path)
}

fn cleanup_recovery_dir(path: &Path, recovery_dir: &Path) {
    if fs::remove_dir_all(recovery_dir).is_ok() {
        let _ = sync_parent(path);
    }
}

fn open_private_regular_nofollow(path: &Path) -> Result<File, KernelError> {
    let fd = rfs::open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| KernelError::InvalidRestore)?;
    let file = File::from(fd);
    let metadata = file.metadata().map_err(|_| KernelError::InvalidRestore)?;
    if !metadata.is_file() || metadata.mode() & 0o077 != 0 || !owner_is_current(metadata.uid()) {
        return Err(KernelError::InvalidRestore);
    }
    Ok(file)
}

fn open_live_family(
    path: &Path,
    lease_epoch: u64,
    expected_seq: i64,
    reader_count: usize,
) -> Result<(Connection, Vec<Connection>), KernelError> {
    let mut writer = open_writer(path).map_err(|_| KernelError::InvalidRestore)?;
    apply_preclassification_profile(&writer).map_err(|_| KernelError::InvalidRestore)?;
    verify_exact_identity(&mut writer).map_err(|_| KernelError::InvalidRestore)?;
    let actual_seq = writer
        .query_row(
            "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| KernelError::InvalidRestore)?;
    if actual_seq != expected_seq {
        return Err(KernelError::InvalidRestore);
    }
    stamp_writer_fence(&mut writer, lease_epoch)?;
    activate_wal(&writer)?;
    harden_family(path)?;
    let readers = (0..reader_count)
        .map(|_| open_reader(path))
        .collect::<Result<Vec<_>, _>>()?;
    harden_family(path)?;
    Ok((writer, readers))
}

fn allocate_recovery_dir(path: &Path) -> Result<PathBuf, KernelError> {
    let parent_path = path.parent().ok_or(KernelError::Io)?;
    let parent = File::open(parent_path).map_err(|_| KernelError::Io)?;
    for _ in 0..10_000 {
        let candidate = PathBuf::from(format!(
            "{}{}{unique}",
            path.display(),
            RESTORE_INFIX,
            unique = next_unique_id()
        ));
        let name = candidate
            .file_name()
            .and_then(std::ffi::OsStr::to_str)
            .ok_or(KernelError::Io)?;
        match create_secure_directory(&parent, name) {
            Ok(_) => return Ok(candidate),
            Err(error) if error.raw_os_error() == Some(rustix::io::Errno::EXIST.raw_os_error()) => {
                continue;
            }
            Err(_) => return Err(KernelError::Io),
        }
    }
    Err(KernelError::Io)
}

fn displace_family(path: &Path, recovery_dir: &Path) -> Result<(), KernelError> {
    for source in family_sidecars(path)
        .into_iter()
        .chain(std::iter::once(path.to_path_buf()))
    {
        if source.exists() {
            let name = source.file_name().ok_or(KernelError::Io)?;
            fs::rename(&source, recovery_dir.join(name)).map_err(|_| KernelError::Io)?;
        }
    }
    sync_directory(recovery_dir)?;
    sync_parent(path)
}

fn restore_displaced_family(path: &Path, recovery_dir: &Path) -> Result<(), KernelError> {
    if !recovery_dir.exists() {
        return Err(KernelError::InvalidRestore);
    }
    for destination in family_sidecars(path)
        .into_iter()
        .chain(std::iter::once(path.to_path_buf()))
    {
        let name = destination.file_name().ok_or(KernelError::Io)?;
        let source = recovery_dir.join(name);
        if source.exists() {
            fs::rename(source, destination).map_err(|_| KernelError::Io)?;
        }
    }
    sync_directory(recovery_dir)?;
    sync_parent(path)
}

fn remove_family(path: &Path) -> Result<(), KernelError> {
    for candidate in family_sidecars(path)
        .into_iter()
        .chain(std::iter::once(path.to_path_buf()))
    {
        match fs::remove_file(candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(KernelError::Io),
        }
    }
    sync_parent(path)
}

fn restore_temp_path(path: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.restore-{}.tmp",
        path.display(),
        next_unique_id()
    ))
}

fn copy_to_private_temp(source: &mut File, destination: &Path) -> Result<(), KernelError> {
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| KernelError::Io)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    let mut target = options.open(destination).map_err(|_| KernelError::Io)?;
    if std::io::copy(source, &mut target)
        .and_then(|_| target.sync_all())
        .is_err()
    {
        drop(target);
        let _ = fs::remove_file(destination);
        return Err(KernelError::Io);
    }
    Ok(())
}

fn fd_path(file: &File) -> PathBuf {
    PathBuf::from(format!("{}/{}", fd_directory(), file.as_raw_fd()))
}

fn fd_child_path(directory: &File, name: &str) -> PathBuf {
    PathBuf::from(format!(
        "{}/{}/{name}",
        fd_directory(),
        directory.as_raw_fd()
    ))
}

#[cfg(target_os = "linux")]
fn fd_directory() -> &'static str {
    "/proc/self/fd"
}

#[cfg(target_os = "macos")]
fn fd_directory() -> &'static str {
    "/dev/fd"
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn fd_directory() -> &'static str {
    "/unsupported-fd-path"
}
