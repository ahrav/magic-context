//! KTD2-KTD4).
//!
//! State is derived from lock ownership plus incarnation-fenced evidence.
//! The publication PID is never consulted, signaled, or used for cleanup;
//! probes never unlink, create, or chmod anything.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use rustix::fd::OwnedFd;
use rustix::fs::{flock, openat, unlinkat, AtFlags, FlockOperation, Mode, OFlags};

use crate::connection_file::{ConnectionInfo, KEY_LEN};

use crate::instance::{
    data_dir_path, flock_bounded, flock_exclusive_bounded, hex, io_err, is_safe_ancestor,
    is_secure_regular, mode_bits, read_all_fd, runtime_dir_path, secure_runtime_dir, InstanceError,
    InstanceGuard, CONNECTION_FILE_NAME, S_IFDIR, S_IFMT, S_IFREG,
};

/// `LIFECYCLE_RECORD_NAME` identifies the lifecycle record in the runtime directory.
pub const LIFECYCLE_RECORD_NAME: &str = "mc-host-lifecycle.json";

/// Persisted records that decode to an unknown schema are quarantined.
/// Unknown-schema records are preserved without repair.
///
/// `InstanceGuard::acquire` refuses records quarantined for `UNSUPPORTED_STATE_SCHEMA_REASON`.
/// Probe consumers must recognize `UNSUPPORTED_STATE_SCHEMA_REASON` in `Stopped` when both fences are free and in `Wedged` when a fence is held.
pub const UNSUPPORTED_STATE_SCHEMA_REASON: &str = "unsupported_state_schema";

/// `COORDINATION_DIR_NAME` names the version-neutral coordination directory under the data root.
pub const COORDINATION_DIR_NAME: &str = ".mc-host-coordination";

/// `TRANSACTION_LOCK_NAME` names the coordination file used for the cross-process transaction flock.
pub const TRANSACTION_LOCK_NAME: &str = "transaction.lock";

/// `LIFETIME_LOCK_NAME` names the coordination file used for the daemon's lifetime flock.
pub const LIFETIME_LOCK_NAME: &str = "lifetime.lock";

pub const PAYLOAD_MANIFEST_DIGEST_LEN: usize = 64;

pub fn is_canonical_payload_digest(digest: &str) -> bool {
    digest.len() == PAYLOAD_MANIFEST_DIGEST_LEN
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

const MAX_EVIDENCE_BYTES: usize = 65_536;

/// The coordination lock files serialize lifecycle mutation and fence each daemon incarnation's lifetime.
/// Keeping coordination outside `cortexkit` prevents replacement of that subtree from splitting the locks.
pub fn coordination_dir_path(data_dir_override: Option<&Path>) -> Result<PathBuf, InstanceError> {
    Ok(data_dir_path(data_dir_override)?.join(COORDINATION_DIR_NAME))
}

/// The replaceable lifecycle namespace carries no locks.
pub fn lifecycle_dir_path(data_dir_override: Option<&Path>) -> Result<PathBuf, InstanceError> {
    let run = runtime_dir_path(data_dir_override)?;
    let base = run
        .parent()
        .expect("runtime dir always has a cortexkit parent")
        .to_path_buf();
    Ok(base.join("lifecycle"))
}

/// The function accepts only owner-only, single-link regular files.
/// The function normalizes the validated descriptor's mode to 0600 instead of chmodding the path.
/// attacker-selected path.
fn open_coordination_lock_create(
    data_dir_override: Option<&Path>,
    name: &'static str,
) -> Result<(OwnedFd, PathBuf), InstanceError> {
    let dir_path = coordination_dir_path(data_dir_override)?;
    let dir = secure_runtime_dir(&dir_path)?;
    let mut requested = None;
    for lock_name in [TRANSACTION_LOCK_NAME, LIFETIME_LOCK_NAME] {
        let fd = create_validated_lock_file(&dir, &dir_path, lock_name)?;
        if lock_name == name {
            requested = Some(fd);
        }
    }
    let fd = requested.expect("every coordination lock name is materialized");
    Ok((fd, dir_path.join(name)))
}

/// `O_NONBLOCK` prevents a planted FIFO from blocking open; `fstat` then rejects the FIFO.
fn create_validated_lock_file(
    dir: &OwnedFd,
    dir_path: &Path,
    name: &'static str,
) -> Result<OwnedFd, InstanceError> {
    let path = dir_path.join(name);
    let fd = match openat(
        dir,
        name,
        OFlags::CREATE | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::from_raw_mode(0o600),
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::LOOP) | Err(rustix::io::Errno::NOTDIR) => {
            return Err(InstanceError::Insecure {
                what: "coordination lock file",
                path,
            });
        }
        Err(e) => return Err(io_err("open_coordination_lock", &path, e)),
    };
    let stat = rustix::fs::fstat(&fd).map_err(|e| io_err("fstat_coordination_lock", &path, e))?;
    let mode = mode_bits(&stat);
    let is_regular = (mode & S_IFMT) == S_IFREG;
    let owner_ok = stat.st_uid == rustix::process::geteuid().as_raw();
    if !is_regular || !owner_ok || stat.st_nlink != 1 {
        return Err(InstanceError::Insecure {
            what: "coordination lock file",
            path,
        });
    }
    rustix::fs::fchmod(&fd, Mode::from_raw_mode(0o600))
        .map_err(|e| io_err("fchmod_coordination_lock", &path, e))?;
    Ok(fd)
}

/// The function returns `Ok(None)` when the coordination directory or named lock file is absent.
/// Symlinks, FIFOs, wrong owners, loose modes, and extra links fail closed.
fn open_coordination_lock_probe(
    data_dir_override: Option<&Path>,
    name: &'static str,
) -> Result<Option<(OwnedFd, PathBuf)>, InstanceError> {
    let dir_path = coordination_dir_path(data_dir_override)?;
    let Some(dir) = open_validated_dir(&dir_path, "coordination directory")? else {
        return Ok(None);
    };
    let path = dir_path.join(name);
    let fd = match openat(
        &dir,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(rustix::io::Errno::LOOP) | Err(rustix::io::Errno::NOTDIR) => {
            return Err(InstanceError::Insecure {
                what: "coordination lock file",
                path,
            });
        }
        Err(e) => return Err(io_err("open_coordination_lock", &path, e)),
    };
    let stat = rustix::fs::fstat(&fd).map_err(|e| io_err("fstat_coordination_lock", &path, e))?;
    if !is_secure_regular(&stat) {
        return Err(InstanceError::Insecure {
            what: "coordination lock file",
            path,
        });
    }
    Ok(Some((fd, path)))
}

/// An exclusive flock on `lifetime.lock` fences each daemon incarnation.
/// The daemon acquires `lifetime.lock` before securing the runtime directory.
/// The daemon holds `lifetime.lock` through publication cleanup, component shutdown, and callback reaping.
/// `InstanceGuard` drops `lifetime.lock` after the runtime-directory lock.
/// `lifetime.lock` is never renamed and resides outside `cortexkit`.
/// Replacing `cortexkit` cannot release `lifetime.lock`.
/// A successor that opens `lifetime.lock` cannot overlap a displaced incarnation.
///
/// Only incarnations that open `lifetime.lock` participate in the fence.
/// Operators must stop the daemon before running a release that does not open `lifetime.lock`.
/// Renaming or removing `.mc-host-coordination` splits the lifetime fence.
/// Renaming the runtime directory also splits the runtime lock.
pub(crate) struct LifetimeLock {
    _file: OwnedFd,
}

impl LifetimeLock {
    /// `acquire` must not block because parking an executor thread can stall a same-process predecessor drain that releases `lifetime.lock`.
    /// The predecessor drain releases `lifetime.lock` when it completes.
    pub(crate) fn acquire(data_dir_override: Option<&Path>) -> Result<Self, InstanceError> {
        let (file, path) = open_coordination_lock_create(data_dir_override, LIFETIME_LOCK_NAME)?;
        match flock(&file, FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => Ok(Self { _file: file }),
            Err(rustix::io::Errno::WOULDBLOCK) => Err(InstanceError::AlreadyRunning),
            Err(e) => Err(io_err("flock_lifetime", &path, e)),
        }
    }
}

/// Tests `lifetime.lock` without blocking; `Ok(true)` means no incarnation holds it.
/// An absent coordination root or lock file reports free because supported deployments never rename or unlink the coordination names.
/// Supported deployments must not rename `.mc-host-coordination` while a daemon is live.
/// Renaming `.mc-host-coordination` under a live daemon makes the probe report free.
/// descriptor drops.
fn lifetime_lock_free(data_dir_override: Option<&Path>) -> Result<bool, InstanceError> {
    let Some((fd, path)) = open_coordination_lock_probe(data_dir_override, LIFETIME_LOCK_NAME)?
    else {
        return Ok(true);
    };
    match flock(&fd, FlockOperation::NonBlockingLockShared) {
        Ok(()) => Ok(true),
        Err(rustix::io::Errno::WOULDBLOCK) => Ok(false),
        Err(e) => Err(io_err("flock_lifetime_probe", &path, e)),
    }
}

/// Returns `true` when a regular lifecycle record has an unknown schema or cannot be read.
/// Supported code must not interpret, migrate, overwrite, or remove quarantined bytes.
///
/// Startup refuses when record bytes could exist but cannot be proven to carry a known schema.
/// Open failures other than `NOENT`, `LOOP`, and `NOTDIR`, plus `fstat` failures and read failures, refuse startup because the record schema cannot be proven known.
/// A record larger than [`MAX_EVIDENCE_BYTES`] refuses startup rather than permit an overwrite.
/// Startup's atomic rename replaces a non-regular lifecycle-record name without following it.
pub(crate) fn quarantined_record_present(
    dir: &OwnedFd,
    dir_path: &Path,
) -> Result<bool, InstanceError> {
    let path = || dir_path.join(LIFECYCLE_RECORD_NAME);
    let fd = match openat(
        dir,
        LIFECYCLE_RECORD_NAME,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT)
        | Err(rustix::io::Errno::LOOP)
        | Err(rustix::io::Errno::NOTDIR) => return Ok(false),
        Err(e) => return Err(io_err("open_lifecycle_record", &path(), e)),
    };
    let stat = rustix::fs::fstat(&fd).map_err(|e| io_err("fstat_lifecycle_record", &path(), e))?;
    if (mode_bits(&stat) & S_IFMT) != S_IFREG {
        return Ok(false);
    }
    let Ok(bytes) = read_all_fd(&fd, MAX_EVIDENCE_BYTES) else {
        return Ok(true);
    };
    Ok(matches!(decode_record(&bytes), RecordDecode::UnknownSchema))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecyclePhase {
    Starting,
    Running,
    Stopping,
}

impl LifecyclePhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
        }
    }

    fn parse(phase: &str) -> Option<Self> {
        match phase {
            "starting" => Some(Self::Starting),
            "running" => Some(Self::Running),
            "stopping" => Some(Self::Stopping),
            _ => None,
        }
    }
}

/// A schema-1 lifecycle record uses PID only as optional display metadata.
/// The daemon must not make decisions from PID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleRecord {
    pub phase: LifecyclePhase,
    pub launch_id: String,
    pub daemon_id: String,
    pub payload_manifest_digest: String,
    pub pid: u32,
    pub written_at_ms: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRecord {
    schema: u32,
    phase: String,
    launch_id: String,
    daemon_id: String,
    payload_manifest_digest: String,
    pid: u32,
    written_at_ms: u64,
}

const HEX_LAUNCH_LEN: usize = 32;
const HEX_DAEMON_LEN: usize = 32;

/// Unknown schemas are classified separately from corruption because they are quarantined rather than repaired.
/// `Legacy` records have schema 1 and an empty `payload_manifest_digest`; all other validated fields are valid.
/// `Legacy` records are not `Malformed` when only `payload_manifest_digest` is empty.
#[derive(Debug, PartialEq, Eq)]
enum RecordDecode {
    Valid(LifecycleRecord),
    Legacy(LifecycleRecord),
    UnknownSchema,
    Malformed,
}

fn decode_record(bytes: &[u8]) -> RecordDecode {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return RecordDecode::Malformed;
    };
    match value.get("schema").and_then(serde_json::Value::as_u64) {
        Some(1) => {}
        Some(_) => return RecordDecode::UnknownSchema,
        None => return RecordDecode::Malformed,
    }
    let Ok(wire) = serde_json::from_value::<WireRecord>(value) else {
        return RecordDecode::Malformed;
    };
    let Some(phase) = LifecyclePhase::parse(&wire.phase) else {
        return RecordDecode::Malformed;
    };
    let is_hex = |s: &str, len: usize| {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    // `payload_manifest_digest` is legacy only when empty; other noncanonical values are malformed.
    let legacy_digest = wire.payload_manifest_digest.is_empty();
    if !is_hex(&wire.launch_id, HEX_LAUNCH_LEN)
        || !is_hex(&wire.daemon_id, HEX_DAEMON_LEN)
        || !(legacy_digest || is_canonical_payload_digest(&wire.payload_manifest_digest))
    {
        return RecordDecode::Malformed;
    }
    let record = LifecycleRecord {
        phase,
        launch_id: wire.launch_id,
        daemon_id: wire.daemon_id,
        payload_manifest_digest: wire.payload_manifest_digest,
        pid: wire.pid,
        written_at_ms: wire.written_at_ms,
    };
    if legacy_digest {
        RecordDecode::Legacy(record)
    } else {
        RecordDecode::Valid(record)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

impl InstanceGuard {
    /// directory inode.
    ///
    pub fn write_lifecycle_record(&self, phase: LifecyclePhase) -> Result<(), InstanceError> {
        let record = WireRecord {
            schema: 1,
            phase: phase.as_str().to_owned(),
            launch_id: hex(self.launch_id()),
            daemon_id: hex(self.daemon_id()),
            // `payload_manifest_digest` is the same for every lifecycle phase of one `InstanceGuard`.
            payload_manifest_digest: self.payload_manifest_digest().to_owned(),
            pid: std::process::id(),
            written_at_ms: now_ms(),
        };
        let json = serde_json::to_vec(&record).expect("record serialization cannot fail");
        crate::instance::write_atomic_owner_only(
            self.dir(),
            self.dir_path(),
            LIFECYCLE_RECORD_NAME,
            &json,
        )
        .map(|_stat| ())
    }

    ///
    ///
    pub fn begin_stopping(&mut self) {
        let _ = self.write_lifecycle_record(LifecyclePhase::Stopping);
        self.remove_publication();
    }

    /// A launch ID or daemon ID mismatch leaves the record unchanged.
    /// The guard never deletes a successor's evidence.
    ///
    /// `O_NONBLOCK` prevents a planted FIFO from blocking the read open.
    /// `O_NOFOLLOW` rejects symlinks but not FIFOs.
    /// Opening a FIFO for reading blocks until a writer arrives.
    /// `is_secure_regular` rejects FIFOs after `openat` succeeds.
    pub fn remove_lifecycle_record(&self) {
        let Ok(fd) = openat(
            self.dir(),
            LIFECYCLE_RECORD_NAME,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        ) else {
            return;
        };
        let Ok(stat) = rustix::fs::fstat(&fd) else {
            return;
        };
        if !is_secure_regular(&stat) {
            return;
        }
        let Ok(bytes) = read_all_fd(&fd, MAX_EVIDENCE_BYTES) else {
            return;
        };
        let RecordDecode::Valid(record) = decode_record(&bytes) else {
            return;
        };
        if record.launch_id != hex(self.launch_id()) || record.daemon_id != hex(self.daemon_id()) {
            return;
        }
        let _ = unlinkat(self.dir(), LIFECYCLE_RECORD_NAME, AtFlags::empty());
    }
}

/// The transaction lock is an exclusive cross-process `flock` on `${dataDir}/.mc-host-coordination/transaction.lock`.
/// The transaction lock is never renamed.
///
/// The lock file serializes mutators but does not anchor runtime evidence.
/// Runtime evidence lives in the managed `cortexkit/run` directory.
/// Supported code never renames or unlinks `transaction.lock`.
/// Replacing `lifecycle`, `run`, or `cortexkit` cannot mint a second transaction owner.
/// A holder that mutates named entries must anchor mutations to retained descriptors.
/// `NamespaceAnchor` requires holders to abort mutations on identity drift.
/// The lock serializes mutators but does not prove that names still resolve to the opened tree.
///
/// The exclusion holds only among coordination-aware releases.
/// A release that predates `transaction.lock` serializes transactions on the `${dataDir}/cortexkit/lifecycle` directory inode instead.
/// `transaction.lock` and the legacy `lifecycle` directory inode are unrelated, so their flocks never contend.
/// A pre-coordination launcher's transaction can overlap one taken here.
/// Stop the daemon before mutating if a pre-coordination launcher may run.
pub struct LifecycleTransactionLock {
    _file: OwnedFd,
    path: PathBuf,
}

impl std::fmt::Debug for LifecycleTransactionLock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LifecycleTransactionLock")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl LifecycleTransactionLock {
    /// `AlreadyRunning` means another lifecycle transaction holds `transaction.lock`.
    ///
    /// `acquire_exclusive` retries because a probe's shared lock is transient; otherwise `AlreadyRunning` could identify no mutator.
    pub fn acquire_exclusive(data_dir_override: Option<&Path>) -> Result<Self, InstanceError> {
        let (file, path) = open_coordination_lock_create(data_dir_override, TRANSACTION_LOCK_NAME)?;
        flock_exclusive_bounded(&file, &path, "flock_transaction")?;
        Ok(Self { _file: file, path })
    }

    /// `acquire_shared` never creates the coordination root or lock file.
    /// `Ok(None)` means no coordination root exists or a mutator outlasted the bounded wait.
    /// The probe proceeds on evidence alone and relies on its bounded reread loop.
    /// reread loop.
    ///
    /// The wait uses the same bounded retry that mutators use against a probe's shared lock.
    /// Retrying lets the probe acquire the shared lock after a mutator releases it.
    /// Acquiring the shared lock prevents the probe from reading intermediate mutator state that its reread loop cannot detect.
    /// The bounded retry blocks the calling thread.
    pub fn acquire_shared(data_dir_override: Option<&Path>) -> Result<Option<Self>, InstanceError> {
        let Some((file, path)) =
            open_coordination_lock_probe(data_dir_override, TRANSACTION_LOCK_NAME)?
        else {
            return Ok(None);
        };
        if flock_bounded(
            &file,
            &path,
            "flock_transaction",
            FlockOperation::NonBlockingLockShared,
        )? {
            Ok(Some(Self { _file: file, path }))
        } else {
            Ok(None)
        }
    }
}

/// `NamespaceAnchor` retains managed-namespace descriptors for lifecycle mutators.
/// `NamespaceAnchor` retains `cortexkit` and its existing `lifecycle` and `run` children.
/// Transaction-lock holders capture the anchor and mutate through its retained descriptors.
/// Transaction-lock holders must call [`verify`] before reporting a named-namespace result.
/// A holder must abort if a captured name resolves to a different identity.
///
///
/// [`verify`]: NamespaceAnchor::verify
pub struct NamespaceAnchor {
    entries: Vec<AnchorEntry>,
}

struct AnchorEntry {
    path: PathBuf,
    /// The anchor retains each descriptor so mutations remain descriptor-relative for its lifetime.
    /// The anchor compares identities using each entry's recorded `(dev, ino)`.
    _fd: OwnedFd,
    dev: u64,
    ino: u64,
}

impl std::fmt::Debug for NamespaceAnchor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NamespaceAnchor")
            .field(
                "paths",
                &self
                    .entries
                    .iter()
                    .map(|entry| entry.path.clone())
                    .collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}

// `Stat::st_dev` is `i32` on macOS, so `stat_identity` casts it to `u64`.
// The cast is required on platforms where `st_dev` is not `u64`.
#[allow(clippy::unnecessary_cast)]
fn stat_identity(stat: &rustix::fs::Stat) -> (u64, u64) {
    (stat.st_dev as u64, stat.st_ino as u64)
}

impl NamespaceAnchor {
    /// `NamespaceAnchor::capture` uses validated no-follow descriptors and records each directory's identity.
    /// `NamespaceAnchor::capture` does not capture absent entries.
    /// Creating an uncaptured entry later does not constitute namespace drift.
    pub fn capture(data_dir_override: Option<&Path>) -> Result<Self, InstanceError> {
        let base = crate::instance::managed_dir_path(data_dir_override)?;
        let mut entries = Vec::new();
        for path in [base.clone(), base.join("lifecycle"), base.join("run")] {
            let Some(fd) = open_validated_dir(&path, "managed namespace directory")? else {
                continue;
            };
            let stat = rustix::fs::fstat(&fd).map_err(|e| io_err("fstat_namespace", &path, e))?;
            let (dev, ino) = stat_identity(&stat);
            entries.push(AnchorEntry {
                path,
                _fd: fd,
                dev,
                ino,
            });
        }
        Ok(Self { entries })
    }

    /// `NamespaceAnchor::verify` returns [`InstanceError::NamespaceDrift`] when a captured name is absent or resolves to a different identity.
    pub fn verify(&self) -> Result<(), InstanceError> {
        for entry in &self.entries {
            let drift = || InstanceError::NamespaceDrift {
                path: entry.path.clone(),
            };
            let Some(fd) = open_validated_dir(&entry.path, "managed namespace directory")? else {
                return Err(drift());
            };
            let stat =
                rustix::fs::fstat(&fd).map_err(|e| io_err("fstat_namespace", &entry.path, e))?;
            if stat_identity(&stat) != (entry.dev, entry.ino) {
                return Err(drift());
            }
        }
        Ok(())
    }
}

/// `open_validated_dir` does not follow intermediate or final symlinks.
/// `open_validated_dir` neither creates nor changes permissions on filesystem entries.
/// `None` indicates that at least one path component does not exist.
fn open_validated_dir(
    dir_path: &Path,
    what: &'static str,
) -> Result<Option<OwnedFd>, InstanceError> {
    let flags = OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::RDONLY | OFlags::CLOEXEC;
    let insecure = || InstanceError::Insecure {
        what,
        path: dir_path.to_path_buf(),
    };
    let mut current = match openat(
        rustix::fs::CWD,
        if dir_path.is_absolute() { "/" } else { "." },
        flags,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(e) => return Err(io_err("open_anchor", dir_path, e)),
    };
    let anchor_stat =
        rustix::fs::fstat(&current).map_err(|e| io_err("fstat_anchor", dir_path, e))?;
    if !is_safe_ancestor(&anchor_stat) {
        return Err(insecure());
    }
    let mut names = Vec::new();
    for component in dir_path.components() {
        match component {
            std::path::Component::RootDir | std::path::Component::CurDir => continue,
            std::path::Component::Normal(name) => names.push(name),
            std::path::Component::ParentDir | std::path::Component::Prefix(_) => {
                return Err(insecure());
            }
        }
    }
    if names.is_empty() {
        return Err(insecure());
    }
    let last = names.len() - 1;
    for (index, name) in names.into_iter().enumerate() {
        let next = match openat(&current, name, flags, Mode::empty()) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            // Opening a symlink component with `O_NOFOLLOW` fails with `ELOOP`.
            // Opening a non-directory component fails with `ENOTDIR`.
            // `ELOOP` and `ENOTDIR` are hostile shapes, not absence.
            Err(rustix::io::Errno::LOOP) | Err(rustix::io::Errno::NOTDIR) => {
                return Err(insecure());
            }
            Err(e) => return Err(io_err("open_component", dir_path, e)),
        };
        let stat = rustix::fs::fstat(&next).map_err(|e| io_err("fstat_component", dir_path, e))?;
        if index != last {
            if !is_safe_ancestor(&stat) {
                return Err(insecure());
            }
        } else {
            let mode = mode_bits(&stat);
            let is_dir = (mode & S_IFMT) == S_IFDIR;
            let owner_ok = stat.st_uid == rustix::process::geteuid().as_raw();
            if !is_dir || !owner_ok || mode & 0o077 != 0 {
                return Err(insecure());
            }
        }
        current = next;
    }
    Ok(Some(current))
}

/// `LifecycleState::Wedged` records an observation; this crate neither kills processes nor breaks locks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Wedged,
}

/// `PublicationSummary` is untrusted diagnostic data and never carries key bytes.
/// `PublicationSummary` never authorizes anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicationSummary {
    pub daemon_id: String,
    pub daemon_ver: String,
    pub pid: u32,
    pub port: u16,
}

/// `ProbeFreshness::window` limits how long `Starting` and `Stopping` evidence remains credible.
/// A held lock with expired `Starting` or `Stopping` evidence classifies as `Wedged`.
#[derive(Debug, Clone, Copy)]
pub struct ProbeFreshness {
    pub window: Duration,
}

impl Default for ProbeFreshness {
    fn default() -> Self {
        Self {
            window: Duration::from_secs(60),
        }
    }
}

#[derive(Debug)]
pub struct LifecycleProbe {
    pub state: LifecycleState,
    /// `reason` contains bounded static classification detail, never file content.
    pub reason: &'static str,
    pub record: Option<LifecycleRecord>,
    pub publication: Option<PublicationSummary>,
    pub instance_lock_free: bool,
    /// `lifetime_lock_free` is true when `lifetime.lock` had no holder at sample time.
    pub lifetime_lock_free: bool,
}

#[derive(PartialEq, Eq)]
struct EvidenceSample {
    record: EvidenceFile,
    publication: EvidenceFile,
}

/// Treat only `NOENT` as absence; fail closed on every other open error.
/// `O_NONBLOCK` prevents FIFO opens from blocking; `O_NOFOLLOW` does not reject FIFOs.
/// Without `O_NONBLOCK`, opening a FIFO for reading blocks until a writer arrives.
/// A blocking syscall can outlive any `spawn_blocking` timeout.
/// `O_NONBLOCK` does not change regular-file reads.
/// `is_secure_regular` rejects FIFOs after the nonblocking open.
fn read_evidence_file(dir: &OwnedFd, name: &str) -> EvidenceFile {
    let fd = match openat(
        dir,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        // Treat `ELOOP`, `ENOTDIR`, and `ENXIO` as insecure.
        // A symlink-open failure must not produce `Absent`.
        // Treating a symlink as absent could downgrade `Wedged` to `Starting` or `Stopping`.
        Err(rustix::io::Errno::NOENT) => return EvidenceFile::Absent,
        Err(_) => return EvidenceFile::Insecure,
    };
    let Ok(stat) = rustix::fs::fstat(&fd) else {
        return EvidenceFile::Insecure;
    };
    if !is_secure_regular(&stat) {
        return EvidenceFile::Insecure;
    }
    match read_all_fd(&fd, MAX_EVIDENCE_BYTES) {
        Ok(bytes) => EvidenceFile::Present(bytes),
        Err(_) => EvidenceFile::Insecure,
    }
}

#[derive(PartialEq, Eq)]
enum EvidenceFile {
    Absent,
    Present(Vec<u8>),
    /// `is_secure_regular` rejects files with the wrong type, owner, mode, link count, or size.
    Insecure,
}

impl EvidenceFile {
    fn bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Present(bytes) => Some(bytes),
            Self::Absent | Self::Insecure => None,
        }
    }
}

fn sample_evidence(dir: &OwnedFd) -> EvidenceSample {
    EvidenceSample {
        record: read_evidence_file(dir, LIFECYCLE_RECORD_NAME),
        publication: read_evidence_file(dir, CONNECTION_FILE_NAME),
    }
}

/// The probe checks instance-lock ownership nonblockingly on the evidence file's open file description.
/// The probe cannot pair one inode's evidence with another inode's lock after a directory swap.
/// `flock` ownership is per open file description.
/// Per-open-file-description ownership also detects a daemon holding the lock in the same process.
///
/// The test takes a shared lock because shared locks conflict with the daemon's exclusive lifetime lock.
/// A daemon holds the lifetime-lock inode exclusively for its entire incarnation.
/// Shared locking detects a daemon's exclusive lock without making concurrent probes conflict.
/// Exclusive probes conflict with each other.
/// An exclusive-lock loser reads `WOULDBLOCK` and reports the lock held.
/// An exclusive probe can misclassify a stopped host as `LifecycleState::Wedged` or stale evidence as `LifecycleState::Running`.
/// A free lock means no holder held the sampled lock at probe time.
fn instance_lock_free(dir: &OwnedFd, dir_path: &Path) -> Result<bool, InstanceError> {
    match flock(dir, FlockOperation::NonBlockingLockShared) {
        Ok(()) => {
            flock(dir, FlockOperation::Unlock).map_err(|e| io_err("flock_unlock", dir_path, e))?;
            Ok(true)
        }
        Err(rustix::io::Errno::WOULDBLOCK) => Ok(false),
        Err(e) => Err(io_err("flock_probe", dir_path, e)),
    }
}

/// A valid publication must satisfy the contract discovery accepts.
/// A publication no conforming client accepts cannot establish a running host.
/// `None` classifies a held lock with a `LifecycleState::Running` record as `LifecycleState::Wedged`.
/// than `running`.
fn publication_summary(bytes: &[u8]) -> Option<PublicationSummary> {
    let info: ConnectionInfo = serde_json::from_slice(bytes).ok()?;
    info.validate().ok()?;

    let endpoint = info.endpoints.first()?;
    if endpoint.host != "127.0.0.1"
        || endpoint.port == 0
        || info.daemon_ver.is_empty()
        || info.key.len() != KEY_LEN
    {
        return None;
    }
    Some(PublicationSummary {
        daemon_id: hex(&info.daemon_id),
        daemon_ver: info.daemon_ver,
        pid: info.pid,
        port: endpoint.port,
    })
}

/// `probe_lifecycle` classifies host lifecycle state from lock ownership and fenced evidence.
/// The probe blocks synchronously and creates nothing.
/// The probe does not change permissions, unlink files, or signal PIDs.
/// Async callers must use `spawn_blocking` because re-sampling may sleep the thread.
/// `spawn_blocking`.
pub fn probe_lifecycle(
    data_dir_override: Option<&Path>,
    freshness: &ProbeFreshness,
) -> Result<LifecycleProbe, InstanceError> {
    const MAX_REREADS: usize = 3;
    // A daemon acquires the instance lock before writing its `starting` record.
    // A probe that runs between lock acquisition and record creation sees a held lock with no evidence.
    // A held lock with no evidence is indistinguishable from a wedged host.
    // The record write fsyncs, but the window is not instantaneous.
    // The probe re-samples `ABSENT_RECORD_GRACE` times before classifying the holder as `wedged`.
    // A genuinely record-less holder classifies as `wedged` after the last attempt.
    // attempt.
    const ABSENT_RECORD_GRACE: usize = 2;
    // The daemon acquires the lifetime fence before the runtime lock and releases it afterward.
    // A probe can observe exactly one lock held while a daemon acquires or releases the fences.
    // The probe re-samples `LOCK_DISAGREEMENT_GRACE` times before treating a lifetime-fence/runtime-lock disagreement as a fault.
    const LOCK_DISAGREEMENT_GRACE: usize = 2;
    const GRACE_DELAY: Duration = Duration::from_millis(25);

    let dir_path = runtime_dir_path(data_dir_override)?;
    // A missing runtime directory means `stopped` only if the stable lifetime fence is free.
    // A held lifetime fence can identify a live incarnation whose namespace was replaced.
    // A held lifetime fence can also identify an incarnation still creating its runtime directory.
    // The probe re-samples `LOCK_DISAGREEMENT_GRACE` times while a live incarnation creates its runtime directory.
    // A free runtime lock does not prove that the lifetime-fence holder ended.
    let mut runtime_dir = None;
    for attempt in 0..=LOCK_DISAGREEMENT_GRACE {
        match open_validated_dir(&dir_path, "lifecycle evidence directory")? {
            Some(dir) => {
                runtime_dir = Some(dir);
                break;
            }
            None => {
                if lifetime_lock_free(data_dir_override)? {
                    return Ok(LifecycleProbe {
                        state: LifecycleState::Stopped,
                        reason: "no runtime directory",
                        record: None,
                        publication: None,
                        instance_lock_free: true,
                        lifetime_lock_free: true,
                    });
                }
                if attempt < LOCK_DISAGREEMENT_GRACE {
                    std::thread::sleep(GRACE_DELAY);
                }
            }
        }
    }
    let Some(dir) = runtime_dir else {
        return Ok(LifecycleProbe {
            state: LifecycleState::Wedged,
            reason: "lifetime fence held without a runtime directory",
            record: None,
            publication: None,
            instance_lock_free: true,
            lifetime_lock_free: false,
        });
    };

    let mut torn_rereads = 0;
    let mut grace_rereads = 0;
    let mut disagreement_rereads = 0;
    loop {
        // A shared transaction lock excludes in-flight mutators for each sample.
        // If the transaction lock is absent or exclusively held, the probe uses evidence-only sampling.
        // The bounded reread loop keeps evidence-only samples coherent.
        let sample = {
            let _root = LifecycleTransactionLock::acquire_shared(data_dir_override)?;
            let lifetime_before = lifetime_lock_free(data_dir_override)?;
            let before = sample_evidence(&dir);
            let lock_free = instance_lock_free(&dir, &dir_path)?;
            let after = sample_evidence(&dir);
            let lifetime_free = lifetime_lock_free(data_dir_override)?;
            (lifetime_before, before, lock_free, after, lifetime_free)
        };
        let (lifetime_before, before, lock_free, after, lifetime_free) = sample;
        if (before != after || lifetime_before != lifetime_free) && torn_rereads + 1 < MAX_REREADS {
            torn_rereads += 1;
            continue;
        }
        if lock_free != lifetime_free && disagreement_rereads < LOCK_DISAGREEMENT_GRACE {
            disagreement_rereads += 1;
            std::thread::sleep(GRACE_DELAY);
            continue;
        }
        // The probe retries absent or stale legacy records while both fences are held, up to `ABSENT_RECORD_GRACE` times.
        let stale_legacy = !lock_free
            && !lifetime_free
            && matches!(
                after.record.bytes().map(decode_record),
                Some(RecordDecode::Legacy(_))
            );
        if !lock_free
            && (after.record == EvidenceFile::Absent || stale_legacy)
            && grace_rereads < ABSENT_RECORD_GRACE
        {
            grace_rereads += 1;
            std::thread::sleep(GRACE_DELAY);
            continue;
        }
        return Ok(classify(after, lock_free, lifetime_free, freshness));
    }
}

/// A credible timestamp lies within `window` of now, in either direction:
fn timestamp_fresh(written_at_ms: u64, window: Duration) -> bool {
    let now = now_ms();
    let window_ms = u64::try_from(window.as_millis()).unwrap_or(u64::MAX);
    written_at_ms <= now.saturating_add(window_ms) && now.saturating_sub(written_at_ms) <= window_ms
}

fn classify(
    sample: EvidenceSample,
    lock_free: bool,
    lifetime_free: bool,
    freshness: &ProbeFreshness,
) -> LifecycleProbe {
    let decoded = sample.record.bytes().map(decode_record);
    let unknown_schema = matches!(decoded, Some(RecordDecode::UnknownSchema));
    let (record, legacy_record) = match decoded {
        Some(RecordDecode::Valid(record)) => (Some(record), None),
        Some(RecordDecode::Legacy(record)) => (None, Some(record)),
        _ => (None, None),
    };
    let publication = sample.publication.bytes().and_then(publication_summary);

    if lock_free && lifetime_free {
        let reason = if unknown_schema {
            UNSUPPORTED_STATE_SCHEMA_REASON
        } else if sample.record != EvidenceFile::Absent
            || sample.publication != EvidenceFile::Absent
        {
            "instance lock free; stale evidence remains"
        } else {
            "instance lock free"
        };
        return LifecycleProbe {
            state: LifecycleState::Stopped,
            reason,
            record,
            publication,
            instance_lock_free: true,
            lifetime_lock_free: true,
        };
    }

    let wedged = |reason: &'static str, record: Option<LifecycleRecord>| LifecycleProbe {
        state: LifecycleState::Wedged,
        reason,
        record,
        publication: publication.clone(),
        instance_lock_free: lock_free,
        lifetime_lock_free: lifetime_free,
    };

    let incumbent = !lock_free && lifetime_free && legacy_record.is_some();
    if lock_free != lifetime_free && !incumbent {
        return wedged("lifetime and runtime locks disagree", record);
    }

    if unknown_schema {
        return wedged(UNSUPPORTED_STATE_SCHEMA_REASON, record);
    }
    if sample.record == EvidenceFile::Insecure {
        return wedged("lifecycle record failed security checks", record);
    }
    if sample.publication == EvidenceFile::Insecure {
        return wedged("publication failed security checks", record);
    }
    let record = if incumbent {
        legacy_record
    } else if legacy_record.is_some() {
        return wedged("record carries no payload digest", None);
    } else {
        record
    };
    let Some(record) = record else {
        let reason = if sample.record == EvidenceFile::Absent {
            "instance lock held without a lifecycle record"
        } else {
            "lifecycle record is corrupt"
        };
        return wedged(reason, None);
    };
    if sample.publication != EvidenceFile::Absent && publication.is_none() {
        return wedged(
            "publication is corrupt or violates the contract",
            Some(record),
        );
    }
    let (state, reason) = match record.phase {
        LifecyclePhase::Starting => {
            if timestamp_fresh(record.written_at_ms, freshness.window) {
                (LifecycleState::Starting, "starting record is fresh")
            } else {
                (LifecycleState::Wedged, "starting record expired")
            }
        }
        LifecyclePhase::Running => match &publication {
            Some(publication) if publication.daemon_id == record.daemon_id => (
                LifecycleState::Running,
                "publication matches the running record",
            ),
            Some(_) => (
                LifecycleState::Wedged,
                "publication daemon ID does not match the record",
            ),
            None => (
                LifecycleState::Wedged,
                "running record without a publication",
            ),
        },
        LifecyclePhase::Stopping => {
            if timestamp_fresh(record.written_at_ms, freshness.window) {
                (LifecycleState::Stopping, "stopping record is fresh")
            } else {
                (LifecycleState::Wedged, "stopping record expired")
            }
        }
    };
    LifecycleProbe {
        state,
        reason,
        record: Some(record),
        publication,
        instance_lock_free: lock_free,
        lifetime_lock_free: lifetime_free,
    }
}

/// requester.
pub struct ShutdownLatch {
    phase: Mutex<LatchPhase>,
    changed: tokio::sync::Notify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LatchPhase {
    Open,
    ResponseInFlight,
    Committed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LatchDecision {
    /// response.
    Owner,
    Wait,
    Committed,
}

impl ShutdownLatch {
    pub fn new() -> Self {
        Self {
            phase: Mutex::new(LatchPhase::Open),
            changed: tokio::sync::Notify::new(),
        }
    }

    pub fn try_own(&self) -> LatchDecision {
        let mut phase = self.phase.lock().expect("latch lock");
        match *phase {
            LatchPhase::Open => {
                *phase = LatchPhase::ResponseInFlight;
                LatchDecision::Owner
            }
            LatchPhase::ResponseInFlight => LatchDecision::Wait,
            LatchPhase::Committed => LatchDecision::Committed,
        }
    }

    pub fn reopen(&self) {
        let mut phase = self.phase.lock().expect("latch lock");
        if *phase == LatchPhase::ResponseInFlight {
            *phase = LatchPhase::Open;
        }
        drop(phase);
        self.changed.notify_waiters();
    }

    pub fn commit(&self) {
        *self.phase.lock().expect("latch lock") = LatchPhase::Committed;
        self.changed.notify_waiters();
    }

    pub fn changed(&self) -> tokio::sync::futures::Notified<'_> {
        self.changed.notified()
    }
}

impl Default for ShutdownLatch {
    fn default() -> Self {
        Self::new()
    }
}

pub struct CommitOnAck {
    latch: std::sync::Arc<ShutdownLatch>,
    shutdown: tokio_util::sync::CancellationToken,
    acknowledged: bool,
}

impl CommitOnAck {
    pub fn new(
        latch: std::sync::Arc<ShutdownLatch>,
        shutdown: tokio_util::sync::CancellationToken,
    ) -> Self {
        Self {
            latch,
            shutdown,
            acknowledged: false,
        }
    }

    pub fn acknowledge(mut self) {
        self.acknowledged = true;
        self.latch.commit();
        self.shutdown.cancel();
    }
}

impl Drop for CommitOnAck {
    fn drop(&mut self) {
        if !self.acknowledged {
            self.latch.reopen();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const TEST_DIGEST: &str = "3d7f9a1c5b2e8f0a6d4c7b9e1f3a5c8d2b4e6f0a1c3d5e7f9b0d2f4a6c8e0b1d";

    fn acquire(root: &Path) -> InstanceGuard {
        InstanceGuard::acquire(Some(root), TEST_DIGEST).expect("acquire")
    }

    fn temp_root() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp data root")
    }

    fn record_path(guard: &InstanceGuard) -> PathBuf {
        guard.dir_path().join(LIFECYCLE_RECORD_NAME)
    }

    fn probe(root: &Path) -> LifecycleProbe {
        probe_lifecycle(Some(root), &ProbeFreshness::default()).expect("probe")
    }

    #[test]
    fn record_round_trips_and_removes_fenced() {
        let root = temp_root();
        let guard = acquire(root.path());
        guard
            .write_lifecycle_record(LifecyclePhase::Starting)
            .expect("write starting");

        let bytes = std::fs::read(record_path(&guard)).expect("read record");
        let RecordDecode::Valid(record) = decode_record(&bytes) else {
            panic!("strict decode");
        };
        assert_eq!(record.phase, LifecyclePhase::Starting);
        assert_eq!(record.launch_id, hex(guard.launch_id()));
        assert_eq!(record.daemon_id, hex(guard.daemon_id()));
        assert_eq!(record.payload_manifest_digest, TEST_DIGEST);
        assert_eq!(record.pid, std::process::id());

        let meta = std::fs::metadata(record_path(&guard)).expect("stat record");
        assert_eq!(meta.permissions().mode() & 0o7777, 0o600);

        guard.remove_lifecycle_record();
        assert!(!record_path(&guard).exists());
    }

    #[test]
    fn record_removal_spares_a_successor() {
        for field in ["launch_id", "daemon_id"] {
            let root = temp_root();
            let guard = acquire(root.path());
            guard
                .write_lifecycle_record(LifecyclePhase::Running)
                .expect("write running");

            let bytes = std::fs::read(record_path(&guard)).expect("read record");
            let mut json: serde_json::Value = serde_json::from_slice(&bytes).expect("parse");
            json[field] = serde_json::Value::String("ab".repeat(16));
            std::fs::write(
                record_path(&guard),
                serde_json::to_vec(&json).expect("encode"),
            )
            .expect("rewrite");
            std::fs::set_permissions(record_path(&guard), std::fs::Permissions::from_mode(0o600))
                .expect("mode");

            guard.remove_lifecycle_record();
            assert!(
                record_path(&guard).exists(),
                "a record with a foreign {field} must survive"
            );
        }
    }

    #[test]
    fn strict_decode_rejects_wrong_shapes() {
        let valid = serde_json::json!({
            "schema": 1,
            "phase": "running",
            "launch_id": "ab".repeat(16),
            "daemon_id": "cd".repeat(16),
            "payload_manifest_digest": TEST_DIGEST,
            "pid": 42,
            "written_at_ms": 1
        });
        assert!(matches!(
            decode_record(&serde_json::to_vec(&valid).unwrap()),
            RecordDecode::Valid(_)
        ));

        let mutate = |f: &dyn Fn(&mut serde_json::Value)| {
            let mut v = valid.clone();
            f(&mut v);
            decode_record(&serde_json::to_vec(&v).unwrap())
        };
        assert_eq!(
            mutate(&|v| v["schema"] = 2.into()),
            RecordDecode::UnknownSchema
        );
        assert_eq!(
            mutate(&|v| v["schema"] = 99.into()),
            RecordDecode::UnknownSchema
        );
        assert_eq!(
            mutate(&|v| v["phase"] = "paused".into()),
            RecordDecode::Malformed
        );
        assert_eq!(
            mutate(&|v| v["launch_id"] = "short".into()),
            RecordDecode::Malformed
        );
        assert_eq!(
            mutate(&|v| v["daemon_id"] = "zz".repeat(16).into()),
            RecordDecode::Malformed
        );
        assert_eq!(
            mutate(&|v| v["extra"] = 1.into()),
            RecordDecode::Malformed,
            "unknown fields are rejected"
        );
        for digest in [
            "d".repeat(PAYLOAD_MANIFEST_DIGEST_LEN - 1),
            "d".repeat(PAYLOAD_MANIFEST_DIGEST_LEN + 1),
            "d".repeat(129),
            TEST_DIGEST.to_uppercase(),
            format!("sha256:{}", &TEST_DIGEST[..57]),
            "g".repeat(PAYLOAD_MANIFEST_DIGEST_LEN),
        ] {
            assert_eq!(
                mutate(&|v| v["payload_manifest_digest"] = digest.clone().into()),
                RecordDecode::Malformed,
                "digest {digest:?} must be rejected"
            );
        }
        assert!(matches!(
            mutate(&|v| v["payload_manifest_digest"] = "".into()),
            RecordDecode::Legacy(_)
        ));
        assert_eq!(decode_record(b"not json"), RecordDecode::Malformed);
        assert_eq!(decode_record(b"[1,2]"), RecordDecode::Malformed);
    }

    #[test]
    fn canonical_digest_shape_is_enforced_at_acquire() {
        let root = temp_root();
        for digest in ["", "short", &"D".repeat(64), &"e".repeat(65)] {
            assert!(
                matches!(
                    InstanceGuard::acquire(Some(root.path()), digest),
                    Err(InstanceError::InvalidPayloadDigest)
                ),
                "digest {digest:?} must be rejected before any lock or mutation"
            );
        }
        assert!(
            std::fs::read_dir(root.path())
                .expect("read root")
                .next()
                .is_none(),
            "a rejected digest must create nothing"
        );
    }

    #[test]
    fn the_same_digest_is_recorded_across_every_phase() {
        let root = temp_root();
        let guard = acquire(root.path());
        for phase in [
            LifecyclePhase::Starting,
            LifecyclePhase::Running,
            LifecyclePhase::Stopping,
        ] {
            guard.write_lifecycle_record(phase).expect("write");
            let bytes = std::fs::read(record_path(&guard)).expect("read");
            let RecordDecode::Valid(record) = decode_record(&bytes) else {
                panic!("strict decode for {phase:?}");
            };
            assert_eq!(record.payload_manifest_digest, TEST_DIGEST, "{phase:?}");
        }
    }

    #[test]
    fn probe_reports_stopped_on_an_empty_root_without_creating_anything() {
        let root = temp_root();
        let observed = probe(root.path());
        assert_eq!(observed.state, LifecycleState::Stopped);
        assert!(observed.instance_lock_free);
        assert!(
            std::fs::read_dir(root.path())
                .expect("read root")
                .next()
                .is_none(),
            "a probe must create nothing"
        );
    }

    #[test]
    fn probe_classifies_starting_running_stopping_and_stopped() {
        let root = temp_root();
        let mut guard = acquire(root.path());

        guard
            .write_lifecycle_record(LifecyclePhase::Starting)
            .expect("starting");
        assert_eq!(probe(root.path()).state, LifecycleState::Starting);

        guard.publish(43123, "mc-host/test").expect("publish");
        guard
            .write_lifecycle_record(LifecyclePhase::Running)
            .expect("running");
        let observed = probe(root.path());
        assert_eq!(observed.state, LifecycleState::Running);
        assert_eq!(
            observed.publication.expect("summary").daemon_id,
            hex(guard.daemon_id())
        );

        guard
            .write_lifecycle_record(LifecyclePhase::Stopping)
            .expect("stopping");
        guard.remove_publication();
        assert_eq!(probe(root.path()).state, LifecycleState::Stopping);

        drop(guard);
        let observed = probe(root.path());
        assert_eq!(observed.state, LifecycleState::Stopped);
        assert!(observed.instance_lock_free);
    }

    #[test]
    fn expired_starting_and_stopping_evidence_is_wedged() {
        let root = temp_root();
        let guard = acquire(root.path());
        for phase in [LifecyclePhase::Starting, LifecyclePhase::Stopping] {
            guard.write_lifecycle_record(phase).expect("write");
            let zero = ProbeFreshness {
                window: Duration::ZERO,
            };
            std::thread::sleep(Duration::from_millis(5));
            let observed = probe_lifecycle(Some(root.path()), &zero).expect("probe");
            assert_eq!(observed.state, LifecycleState::Wedged, "{phase:?}");
        }
    }

    #[test]
    fn future_timestamps_beyond_the_window_are_wedged() {
        let root = temp_root();
        let guard = acquire(root.path());
        guard
            .write_lifecycle_record(LifecyclePhase::Starting)
            .expect("write");
        let path = record_path(&guard);
        let bytes = std::fs::read(&path).expect("read");
        let mut json: serde_json::Value = serde_json::from_slice(&bytes).expect("parse");
        json["written_at_ms"] = serde_json::Value::from(now_ms() + 3_600_000);
        std::fs::write(&path, serde_json::to_vec(&json).expect("encode")).expect("rewrite");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("mode");

        assert_eq!(probe(root.path()).state, LifecycleState::Wedged);
    }

    #[test]
    fn held_lock_with_missing_corrupt_or_mismatched_evidence_is_wedged() {
        let root = temp_root();
        let mut guard = acquire(root.path());

        let observed = probe(root.path());
        assert_eq!(observed.state, LifecycleState::Wedged);
        assert!(!observed.instance_lock_free);

        // Corrupt record.
        let path = record_path(&guard);
        std::fs::write(&path, b"{\"schema\":").expect("corrupt");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("mode");
        assert_eq!(probe(root.path()).state, LifecycleState::Wedged);

        guard
            .write_lifecycle_record(LifecyclePhase::Running)
            .expect("running");
        guard.publish(43123, "mc-host/test").expect("publish");
        let publication = guard.dir_path().join(CONNECTION_FILE_NAME);
        let bytes = std::fs::read(&publication).expect("read publication");
        let mut json: serde_json::Value = serde_json::from_slice(&bytes).expect("parse");
        json["daemon_id"] = serde_json::json!(vec![0u8; 16]);
        std::fs::write(&publication, serde_json::to_vec(&json).expect("encode")).expect("rewrite");
        std::fs::set_permissions(&publication, std::fs::Permissions::from_mode(0o600))
            .expect("mode");
        let observed = probe(root.path());
        assert_eq!(observed.state, LifecycleState::Wedged);

        std::fs::write(&publication, b"not json").expect("corrupt publication");
        std::fs::set_permissions(&publication, std::fs::Permissions::from_mode(0o600))
            .expect("mode");
        assert_eq!(probe(root.path()).state, LifecycleState::Wedged);

        guard.publish(43123, "mc-host/test").expect("republish");
        std::fs::set_permissions(&publication, std::fs::Permissions::from_mode(0o644))
            .expect("loosen publication");
        assert_eq!(probe(root.path()).state, LifecycleState::Wedged);
        std::fs::set_permissions(&publication, std::fs::Permissions::from_mode(0o600))
            .expect("restore mode");

        std::fs::remove_file(&publication).expect("remove publication");
        assert_eq!(probe(root.path()).state, LifecycleState::Wedged);

        guard
            .write_lifecycle_record(LifecyclePhase::Starting)
            .expect("rewrite starting");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("loosen");
        assert_eq!(probe(root.path()).state, LifecycleState::Wedged);
    }

    #[test]
    fn free_lock_with_stale_publication_is_stopped_and_untouched() {
        let root = temp_root();
        let publication;
        {
            let mut guard = acquire(root.path());
            guard
                .write_lifecycle_record(LifecyclePhase::Running)
                .expect("running");
            guard.publish(43123, "mc-host/test").expect("publish");
            publication = guard.dir_path().join(CONNECTION_FILE_NAME);
            // The test rewrites the publication under a foreign daemon ID so fenced `Drop` cleanup leaves it behind, simulating a crash.
            let bytes = std::fs::read(&publication).expect("read");
            let mut json: serde_json::Value = serde_json::from_slice(&bytes).expect("parse");
            json["daemon_id"] = serde_json::json!(vec![7u8; 16]);
            // The stale PID is this live test process; PID liveness does not affect classification.
            json["pid"] = serde_json::Value::from(std::process::id());
            std::fs::write(&publication, serde_json::to_vec(&json).expect("encode"))
                .expect("rewrite");
            std::fs::set_permissions(&publication, std::fs::Permissions::from_mode(0o600))
                .expect("mode");
        }
        assert!(
            publication.exists(),
            "the foreign publication survived drop"
        );
        let observed = probe(root.path());
        assert_eq!(observed.state, LifecycleState::Stopped);
        assert!(observed.instance_lock_free);
        assert!(publication.exists(), "a probe must never unlink");
    }

    #[test]
    fn fresh_starting_record_beside_a_crashed_predecessors_publication_is_starting() {
        let root = temp_root();
        let mut guard = acquire(root.path());
        guard
            .write_lifecycle_record(LifecyclePhase::Starting)
            .expect("starting");
        // A crashed predecessor can leave a well-formed foreign-daemon publication for its successor to overwrite at `publish`.
        guard.publish(43123, "mc-host/test").expect("publish");
        let publication = guard.dir_path().join(CONNECTION_FILE_NAME);
        let bytes = std::fs::read(&publication).expect("read");
        let mut json: serde_json::Value = serde_json::from_slice(&bytes).expect("parse");
        json["daemon_id"] = serde_json::json!(vec![7u8; 16]);
        std::fs::write(&publication, serde_json::to_vec(&json).expect("encode")).expect("rewrite");
        std::fs::set_permissions(&publication, std::fs::Permissions::from_mode(0o600))
            .expect("mode");

        let observed = probe(root.path());
        assert_eq!(
            observed.state,
            LifecycleState::Starting,
            "crash residue must not wedge a healthy start: {}",
            observed.reason
        );

        guard
            .write_lifecycle_record(LifecyclePhase::Running)
            .expect("running");
        let observed = probe(root.path());
        assert_eq!(observed.state, LifecycleState::Wedged);
        assert_eq!(
            observed.reason,
            "publication daemon ID does not match the record"
        );
    }

    #[test]
    fn transaction_lock_is_exclusive_on_the_stable_coordination_file() {
        let root = temp_root();
        let first = LifecycleTransactionLock::acquire_exclusive(Some(root.path())).expect("first");
        assert!(matches!(
            LifecycleTransactionLock::acquire_exclusive(Some(root.path())),
            Err(InstanceError::AlreadyRunning)
        ));
        drop(first);
        let second =
            LifecycleTransactionLock::acquire_exclusive(Some(root.path())).expect("released");
        drop(second);
    }

    /// A transaction holder fails closed at `verify` when its managed namespace is replaced or renamed rather than reporting a commit against a tree it no longer owns.
    #[test]
    fn namespace_drift_fails_the_holder_before_a_named_commit() {
        for victim in ["lifecycle", "run", ""] {
            let root = temp_root();
            let cortexkit = root.path().join("cortexkit");
            std::fs::create_dir(&cortexkit).expect("cortexkit");
            std::fs::create_dir(cortexkit.join("lifecycle")).expect("lifecycle");
            std::fs::create_dir(cortexkit.join("run")).expect("run");
            for dir in [
                cortexkit.clone(),
                cortexkit.join("lifecycle"),
                cortexkit.join("run"),
            ] {
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                    .expect("owner-only");
            }

            let _holder =
                LifecycleTransactionLock::acquire_exclusive(Some(root.path())).expect("holder");
            let anchor = NamespaceAnchor::capture(Some(root.path())).expect("anchor");
            anchor.verify().expect("identity holds before replacement");

            let target = if victim.is_empty() {
                cortexkit.clone()
            } else {
                cortexkit.join(victim)
            };
            let moved = target.with_file_name("moved-away");
            std::fs::rename(&target, &moved).expect("replace namespace entry");
            std::fs::create_dir(&target).expect("plant a fresh inode at the name");
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700))
                .expect("owner-only");

            assert!(
                matches!(anchor.verify(), Err(InstanceError::NamespaceDrift { .. })),
                "replacing {victim:?} must abort the holder's named-namespace result"
            );
        }
    }

    #[test]
    fn shared_probe_lock_never_creates_and_yields_none_under_a_mutator() {
        let root = temp_root();
        assert!(LifecycleTransactionLock::acquire_shared(Some(root.path()))
            .expect("no root")
            .is_none());
        assert!(
            std::fs::read_dir(root.path())
                .expect("read root")
                .next()
                .is_none(),
            "a probe lock must not create the coordination root"
        );

        let mutator =
            LifecycleTransactionLock::acquire_exclusive(Some(root.path())).expect("mutator");
        assert!(
            LifecycleTransactionLock::acquire_shared(Some(root.path()))
                .expect("held root")
                .is_none(),
            "a held exclusive lock degrades the probe to evidence-only"
        );
        drop(mutator);
        assert!(LifecycleTransactionLock::acquire_shared(Some(root.path()))
            .expect("free root")
            .is_some());
    }

    /// Hostile shapes at coordination names fail closed without creating or chmodding attacker-selected paths.
    #[test]
    fn symlinked_coordination_root_fails_closed_for_probes() {
        let root = temp_root();
        let elsewhere = temp_root();
        let path = coordination_dir_path(Some(root.path())).expect("path");
        std::os::unix::fs::symlink(elsewhere.path(), &path).expect("symlink");
        assert!(LifecycleTransactionLock::acquire_shared(Some(root.path())).is_err());
        assert!(LifecycleTransactionLock::acquire_exclusive(Some(root.path())).is_err());
        assert!(
            std::fs::read_dir(elsewhere.path())
                .expect("read target")
                .next()
                .is_none(),
            "the symlink target must receive nothing"
        );
    }

    #[test]
    fn hostile_shapes_at_the_lock_names_fail_closed() {
        use std::os::unix::fs::PermissionsExt;

        for name in [TRANSACTION_LOCK_NAME, LIFETIME_LOCK_NAME] {
            let root = temp_root();
            let coordination = coordination_dir_path(Some(root.path())).expect("path");
            std::fs::create_dir_all(&coordination).expect("coordination root");
            let outside = temp_root();
            let victim = outside.path().join("victim");
            std::fs::write(&victim, b"untouched").expect("victim");
            std::os::unix::fs::symlink(&victim, coordination.join(name)).expect("plant symlink");

            let mutator_err = if name == TRANSACTION_LOCK_NAME {
                LifecycleTransactionLock::acquire_exclusive(Some(root.path())).err()
            } else {
                InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).err()
            };
            assert!(
                matches!(mutator_err, Some(InstanceError::Insecure { .. })),
                "a symlinked {name} must fail closed: {mutator_err:?}"
            );
            assert_eq!(
                std::fs::read(&victim).expect("read victim"),
                b"untouched",
                "the symlink target must be untouched"
            );

            // A FIFO at the lock name must classify without hanging. Linux-only: `rustix` exposes `mkfifoat` only off Apple, and `deny(unsafe_code)` prevents a portable in-process fixture.
            // Tests must not invoke `mkfifo(1)`: forked children inherit sibling tests' `flock` descriptors, delaying lock release and causing `EWOULDBLOCK`.
            #[cfg(target_os = "linux")]
            {
                let root = temp_root();
                let coordination = coordination_dir_path(Some(root.path())).expect("path");
                std::fs::create_dir_all(&coordination).expect("coordination root");
                rustix::fs::mkfifoat(
                    rustix::fs::CWD,
                    coordination.join(name).as_path(),
                    Mode::from_raw_mode(0o600),
                )
                .expect("plant fifo");
                let mutator_err = if name == TRANSACTION_LOCK_NAME {
                    LifecycleTransactionLock::acquire_exclusive(Some(root.path())).err()
                } else {
                    InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).err()
                };
                assert!(
                    matches!(mutator_err, Some(InstanceError::Insecure { .. })),
                    "a fifo at {name} must fail closed: {mutator_err:?}"
                );
            }

            // The lock-file validator rejects a hard-linked lock file because another directory entry can retain it after cleanup.
            let root = temp_root();
            let coordination = coordination_dir_path(Some(root.path())).expect("path");
            std::fs::create_dir_all(&coordination).expect("coordination root");
            std::fs::write(coordination.join(name), b"").expect("lock file");
            std::fs::set_permissions(
                coordination.join(name),
                std::fs::Permissions::from_mode(0o600),
            )
            .expect("mode");
            std::fs::hard_link(coordination.join(name), coordination.join("extra-link"))
                .expect("hard link");
            let mutator_err = if name == TRANSACTION_LOCK_NAME {
                LifecycleTransactionLock::acquire_exclusive(Some(root.path())).err()
            } else {
                InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).err()
            };
            assert!(
                matches!(mutator_err, Some(InstanceError::Insecure { .. })),
                "a multi-link {name} must fail closed: {mutator_err:?}"
            );
        }
    }

    #[tokio::test]
    async fn latch_transitions_open_inflight_committed_and_reopens() {
        let latch = std::sync::Arc::new(ShutdownLatch::new());
        assert_eq!(latch.try_own(), LatchDecision::Owner);
        assert_eq!(latch.try_own(), LatchDecision::Wait);

        // Pre-acknowledgement failure: the dropped guard reopens ownership.
        let shutdown = tokio_util::sync::CancellationToken::new();
        drop(CommitOnAck::new(
            std::sync::Arc::clone(&latch),
            shutdown.clone(),
        ));
        assert_eq!(latch.try_own(), LatchDecision::Owner);
        assert!(
            !shutdown.is_cancelled(),
            "a reopened attempt must not cancel"
        );

        // Acknowledgement commits ownership permanently and fires host cancellation.
        CommitOnAck::new(std::sync::Arc::clone(&latch), shutdown.clone()).acknowledge();
        assert!(shutdown.is_cancelled());
        assert_eq!(latch.try_own(), LatchDecision::Committed);

        // Reopen after commit is a no-op: commit is final.
        latch.reopen();
        assert_eq!(latch.try_own(), LatchDecision::Committed);
    }

    #[tokio::test]
    async fn a_discarded_writer_drops_the_hook_unrun_and_reopens_the_latch() {
        let latch = std::sync::Arc::new(ShutdownLatch::new());
        let shutdown = tokio_util::sync::CancellationToken::new();
        assert_eq!(latch.try_own(), LatchDecision::Owner);
        let commit = CommitOnAck::new(std::sync::Arc::clone(&latch), shutdown.clone());

        let (server, client) = tokio::io::duplex(64);
        let generation = tokio_util::sync::CancellationToken::new();
        let (handle, task) = crate::tcp_frame_channel::spawn_writer(
            server,
            2,
            generation.clone(),
            std::time::Duration::from_secs(5),
        );
        handle
            .send(crate::frame_channel::OutboundFrame {
                bytes: vec![0u8; 8],
                tail: Vec::new(),
                direct: None,
                charge: crate::wire::ByteCharge::none(),
                written: Some(Box::new(move |_at| commit.acknowledge())),
            })
            .await
            .expect("queued");
        // Discarding the writer before it writes a queued frame drops the frame's hook without running it.
        handle.discard();
        drop(handle);
        task.await.expect("writer task");
        drop(client);

        assert!(!shutdown.is_cancelled(), "an unwritten frame cannot commit");
        assert_eq!(
            latch.try_own(),
            LatchDecision::Owner,
            "ownership reopened for a later requester"
        );
        CommitOnAck::new(std::sync::Arc::clone(&latch), shutdown.clone()).acknowledge();
        assert!(shutdown.is_cancelled());
        assert_eq!(latch.try_own(), LatchDecision::Committed);
    }

    #[tokio::test]
    async fn latch_waiters_wake_on_reopen_and_commit() {
        for (finish, expected) in [("reopen", "owner"), ("commit", "committed")] {
            let latch = std::sync::Arc::new(ShutdownLatch::new());
            assert_eq!(latch.try_own(), LatchDecision::Owner);

            let waiter = {
                let latch = std::sync::Arc::clone(&latch);
                tokio::spawn(async move {
                    loop {
                        let changed = latch.changed();
                        tokio::pin!(changed);
                        changed.as_mut().enable();
                        match latch.try_own() {
                            LatchDecision::Owner => return "owner",
                            LatchDecision::Committed => return "committed",
                            LatchDecision::Wait => changed.await,
                        }
                    }
                })
            };
            tokio::task::yield_now().await;
            assert!(!waiter.is_finished());
            match finish {
                "reopen" => latch.reopen(),
                _ => latch.commit(),
            }
            assert_eq!(waiter.await.expect("waiter"), expected, "{finish}");
        }
    }

    /// `notify_waiters` wakes only enabled futures, so a notification between `try_own` and the first poll must remain observable.
    #[tokio::test]
    async fn an_enabled_change_future_survives_a_pre_poll_notification() {
        let latch = ShutdownLatch::new();
        assert_eq!(latch.try_own(), LatchDecision::Owner);
        let changed = latch.changed();
        tokio::pin!(changed);
        changed.as_mut().enable();
        assert_eq!(latch.try_own(), LatchDecision::Wait);
        latch.reopen();
        tokio::time::timeout(std::time::Duration::from_secs(1), changed)
            .await
            .expect("the pre-poll notification must not be lost");
    }

    ///
    /// A thread blocked in `openat` on a writer-less FIFO cannot be cancelled or joined.
    /// A timeout must terminate the process because a blocked FIFO-open thread cannot be joined.
    /// The timeout handler exits the process because a blocked FIFO-open thread cannot be joined.
    #[cfg(target_os = "linux")]
    fn within<T: Send + 'static>(
        budget: Duration,
        diagnosis: &str,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(work());
        });
        match rx.recv_timeout(budget) {
            Ok(value) => value,
            Err(_) => {
                eprintln!("FAILED: {diagnosis}");
                eprintln!(
                    "  a blocking open never returned within {budget:?}; \
                     O_NONBLOCK is missing from the evidence opener"
                );
                std::process::exit(1);
            }
        }
    }

    /// `O_NOFOLLOW` rejects symlinks but not FIFOs; opening a FIFO for reading blocks until a writer arrives.
    /// Without `O_NONBLOCK`, both evidence readers block forever on a writer-less FIFO.
    /// hostile shape.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_fifo_at_an_evidence_name_cannot_hang_the_probe() {
        for name in [LIFECYCLE_RECORD_NAME, CONNECTION_FILE_NAME] {
            let root = temp_root();
            let guard = acquire(root.path());
            guard
                .write_lifecycle_record(LifecyclePhase::Running)
                .expect("running");
            // The fixture never opens a FIFO writer, so a blocking open cannot complete.
            let path = guard.dir_path().join(name);
            let _ = std::fs::remove_file(&path);
            rustix::fs::mkfifoat(rustix::fs::CWD, path.as_path(), Mode::from_raw_mode(0o600))
                .expect("plant fifo");

            let root_path = root.path().to_path_buf();
            let state = within(
                Duration::from_secs(5),
                &format!("probe_lifecycle blocked on a fifo planted at {name}"),
                move || {
                    probe_lifecycle(Some(&root_path), &ProbeFreshness::default())
                        .expect("probe")
                        .state
                },
            );
            assert_eq!(
                state,
                LifecycleState::Wedged,
                "a fifo at {name} is a hostile shape, not liveness"
            );
            assert!(
                path.exists(),
                "a probe must never unlink the planted {name}"
            );
        }
    }

    /// Fenced removal must not block on a FIFO at the record name.
    /// Fenced removal runs from `Drop` while the instance lock is held.
    /// Blocking fenced removal retains the instance lock and prevents later starts.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_fifo_at_the_record_name_cannot_hang_fenced_removal() {
        let root = temp_root();
        let guard = acquire(root.path());
        let path = record_path(&guard);
        rustix::fs::mkfifoat(rustix::fs::CWD, path.as_path(), Mode::from_raw_mode(0o600))
            .expect("plant fifo");

        within(
            Duration::from_secs(5),
            "remove_lifecycle_record blocked on a fifo, retaining the instance lock",
            move || guard.remove_lifecycle_record(),
        );
        assert!(path.exists(), "a foreign shape must survive fenced removal");
    }

    /// A symlink is a hostile shape; mapping its `ELOOP` to `Absent` would downgrade a `wedged` verdict to `stopping`.
    #[test]
    fn a_symlinked_publication_is_insecure_not_absent() {
        let root = temp_root();
        let elsewhere = temp_root();
        let guard = acquire(root.path());
        guard
            .write_lifecycle_record(LifecyclePhase::Stopping)
            .expect("stopping");

        let target = elsewhere.path().join("decoy");
        std::fs::write(&target, b"{}").expect("write decoy");
        std::os::unix::fs::symlink(&target, guard.dir_path().join(CONNECTION_FILE_NAME))
            .expect("plant symlink");

        let observed = probe(root.path());
        assert_eq!(
            observed.state,
            LifecycleState::Wedged,
            "a symlinked publication must fail closed, not read as missing"
        );
        assert_eq!(
            std::fs::read(&target).expect("read decoy"),
            b"{}",
            "the outside target must be untouched"
        );
    }

    /// Shared locks prevent concurrent probes from reporting each other as holding the lock.
    /// An exclusive probe makes a concurrent probe read `WOULDBLOCK` and falsely report `Running`.
    /// The protocol defines a free lock as `stopped`.
    /// The fixture retains leftover evidence so the absent-record grace re-read cannot mask it.
    #[test]
    fn concurrent_probes_never_resurrect_stale_evidence_as_live() {
        let root = temp_root();
        let root_path = root.path().to_path_buf();

        // The fixture creates valid publication bytes, then strands them without a lock holder to simulate a crashed daemon.
        let (publication_bytes, daemon_hex) = {
            let mut guard = acquire(&root_path);
            guard.publish(43123, "mc-host/test").expect("publish");
            let bytes = std::fs::read(guard.dir_path().join(CONNECTION_FILE_NAME)).expect("read");
            (bytes, hex(guard.daemon_id()))
        };

        let run_dir = runtime_dir_path(Some(&root_path)).expect("runtime path");
        let publication = run_dir.join(CONNECTION_FILE_NAME);
        std::fs::write(&publication, &publication_bytes).expect("restore publication");
        std::fs::set_permissions(&publication, std::fs::Permissions::from_mode(0o600))
            .expect("mode");
        let record = serde_json::json!({
            "schema": 1,
            "phase": "running",
            "launch_id": "ab".repeat(16),
            "daemon_id": daemon_hex,
            "payload_manifest_digest": TEST_DIGEST,
            "pid": std::process::id(),
            "written_at_ms": now_ms(),
        });
        let record_path = run_dir.join(LIFECYCLE_RECORD_NAME);
        std::fs::write(&record_path, serde_json::to_vec(&record).expect("encode"))
            .expect("write record");
        std::fs::set_permissions(&record_path, std::fs::Permissions::from_mode(0o600))
            .expect("mode");

        assert_eq!(probe(root.path()).state, LifecycleState::Stopped);

        let workers: Vec<_> = (0..6)
            .map(|_| {
                let root_path = root_path.clone();
                std::thread::spawn(move || {
                    for _ in 0..40 {
                        let observed =
                            probe_lifecycle(Some(&root_path), &ProbeFreshness::default())
                                .expect("probe");
                        assert_eq!(
                            observed.state,
                            LifecycleState::Stopped,
                            "a concurrent probe aliased as a lock holder: {}",
                            observed.reason
                        );
                        assert!(observed.instance_lock_free);
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().expect("probe thread");
        }
    }

    #[test]
    fn a_shared_freedom_test_still_sees_a_live_holder() {
        let root = temp_root();
        let guard = acquire(root.path());
        guard
            .write_lifecycle_record(LifecyclePhase::Starting)
            .expect("starting");
        let observed = probe(root.path());
        assert!(
            !observed.instance_lock_free,
            "an exclusive incarnation lock must still read as held"
        );
        assert_eq!(observed.state, LifecycleState::Starting);
    }

    /// Replacing or renaming the managed `lifecycle` directory after transaction-lock acquisition must not create a second transaction owner.
    #[test]
    fn a_replaced_lifecycle_child_cannot_mint_a_second_transaction_owner() {
        let root = temp_root();
        let managed = lifecycle_dir_path(Some(root.path())).expect("path");
        std::fs::create_dir_all(&managed).expect("create managed lifecycle dir");

        let _holder = LifecycleTransactionLock::acquire_exclusive(Some(root.path()))
            .expect("first transaction owner");
        std::fs::rename(&managed, managed.with_file_name("lifecycle-moved"))
            .expect("replace the managed lifecycle dir");
        assert!(
            matches!(
                LifecycleTransactionLock::acquire_exclusive(Some(root.path())),
                Err(InstanceError::AlreadyRunning)
            ),
            "a replaced managed subtree must not split the transaction lock"
        );
    }

    /// Independent openers must resolve the same coordination inode identities after the managed subtree is replaced.
    #[test]
    fn independent_openers_see_one_stable_coordination_identity() {
        use std::os::unix::fs::MetadataExt;
        let root = temp_root();
        let lock_path = root
            .path()
            .join(".mc-host-coordination")
            .join("transaction.lock");

        let first =
            LifecycleTransactionLock::acquire_exclusive(Some(root.path())).expect("first opener");
        let meta = std::fs::symlink_metadata(&lock_path).expect("transaction.lock exists");
        assert!(meta.file_type().is_file(), "the lock is a regular file");
        let identity = (meta.dev(), meta.ino());
        drop(first);

        let cortexkit = root.path().join("cortexkit");
        std::fs::create_dir_all(cortexkit.join("run")).expect("managed subtree");
        std::fs::rename(&cortexkit, root.path().join("cortexkit-old")).expect("replace subtree");

        let _second =
            LifecycleTransactionLock::acquire_exclusive(Some(root.path())).expect("second opener");
        let meta = std::fs::symlink_metadata(&lock_path).expect("transaction.lock still exists");
        assert_eq!(
            (meta.dev(), meta.ino()),
            identity,
            "every opener must lock the same never-renamed coordination inode"
        );
    }

    /// Replacing the whole `cortexkit` subtree after publication isolates old descriptor-owned evidence, but the stable lifetime fence still names a live incarnation.
    #[test]
    fn a_replaced_cortexkit_subtree_is_not_reported_stopped_while_the_daemon_lives() {
        let root = temp_root();
        let mut guard = acquire(root.path());
        guard
            .write_lifecycle_record(LifecyclePhase::Running)
            .expect("running");
        guard.publish(43123, "mc-host/test").expect("publish");

        let cortexkit = root.path().join("cortexkit");
        std::fs::rename(&cortexkit, root.path().join("cortexkit-old"))
            .expect("replace the managed subtree");

        let observed = probe(root.path());
        assert_ne!(
            observed.state,
            LifecycleState::Stopped,
            "a live incarnation behind a replaced subtree must not read as stopped: {}",
            observed.reason
        );
        assert_eq!(observed.state, LifecycleState::Wedged);

        // The successor cannot start a second incarnation while the first holds the stable lifetime fence.
        assert!(
            matches!(
                InstanceGuard::acquire(Some(root.path()), TEST_DIGEST),
                Err(InstanceError::AlreadyRunning)
            ),
            "the lifetime fence must survive whole-subtree replacement"
        );

        drop(guard);
        let observed = probe(root.path());
        assert_eq!(
            observed.state,
            LifecycleState::Stopped,
            "teardown of the displaced incarnation frees both fences"
        );
    }

    /// A persisted record carrying an empty digest is never reported as a coherent running incarnation.
    #[test]
    fn an_empty_payload_digest_is_never_a_coherent_running_incarnation() {
        let root = temp_root();
        let mut guard = acquire(root.path());
        guard
            .write_lifecycle_record(LifecyclePhase::Running)
            .expect("running");
        guard.publish(43123, "mc-host/test").expect("publish");
        assert_eq!(probe(root.path()).state, LifecycleState::Running);

        let path = record_path(&guard);
        let bytes = std::fs::read(&path).expect("read record");
        let mut json: serde_json::Value = serde_json::from_slice(&bytes).expect("parse");
        json["payload_manifest_digest"] = serde_json::Value::String(String::new());
        std::fs::write(&path, serde_json::to_vec(&json).expect("encode")).expect("rewrite");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("mode");

        let observed = probe(root.path());
        assert_eq!(
            observed.state,
            LifecycleState::Wedged,
            "an empty payload digest must fail closed: {}",
            observed.reason
        );
    }

    /// An unknown lifecycle schema is preserved byte-for-byte and classified `unsupported_state_schema` under held and free fences.
    #[test]
    fn an_unknown_lifecycle_schema_is_quarantined_not_interpreted() {
        let root = temp_root();
        let future_record = serde_json::to_vec(&serde_json::json!({
            "schema": 7,
            "phase": "hibernating",
            "carried": {"unknown": ["fields"]},
        }))
        .expect("encode");

        let record_path = {
            let guard = acquire(root.path());
            let path = record_path(&guard);
            std::fs::write(&path, &future_record).expect("plant future record");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("mode");

            // The classifier never treats an unknown schema under a held fence as a coherent incarnation.
            let observed = probe(root.path());
            assert_eq!(observed.state, LifecycleState::Wedged);
            assert_eq!(observed.reason, "unsupported_state_schema");
            path
        };

        // With both fences free, an unknown schema yields `Stopped` and preserves the record.
        assert!(record_path.exists(), "drop must not remove foreign bytes");
        let observed = probe(root.path());
        assert_eq!(observed.state, LifecycleState::Stopped);
        assert_eq!(observed.reason, "unsupported_state_schema");

        // A start against an unknown-schema record must refuse rather than overwrite the record.
        assert!(
            matches!(
                InstanceGuard::acquire(Some(root.path()), TEST_DIGEST),
                Err(InstanceError::UnsupportedStateSchema { .. })
            ),
            "starting over an unknown schema must fail closed"
        );
        assert_eq!(
            std::fs::read(&record_path).expect("reread"),
            future_record,
            "the unknown schema bytes must be preserved byte-for-byte"
        );
    }

    /// A canonical-digest record with a held runtime lock and no lifetime fence yields `Wedged`.
    /// A held runtime lock without a lifetime fence makes a canonical-digest record incoherent.
    #[test]
    fn lifetime_and_runtime_lock_disagreement_is_wedged() {
        let root = temp_root();
        {
            let mut guard = acquire(root.path());
            guard
                .write_lifecycle_record(LifecyclePhase::Running)
                .expect("running");
            guard.publish(43123, "mc-host/test").expect("publish");
        }
        // release would.
        let dir_path = runtime_dir_path(Some(root.path())).expect("path");
        let dir = openat(
            rustix::fs::CWD,
            dir_path.as_path(),
            OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::RDONLY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .expect("open run dir");
        flock(&dir, FlockOperation::NonBlockingLockExclusive).expect("exclusive runtime lock");

        let observed = probe(root.path());
        assert_eq!(observed.state, LifecycleState::Wedged);
        assert_eq!(observed.reason, "lifetime and runtime locks disagree");
        assert!(!observed.instance_lock_free);
        assert!(observed.lifetime_lock_free);
    }

    /// The probe classifies a held runtime lock with a schema-1 empty-digest record and no lifetime fence as `Wedged`.
    #[test]
    fn a_pre_coordination_incumbent_classifies_by_its_record() {
        let root = temp_root();
        // Dropping `guard` removes both files and releases both fences.
        // both fences).
        let (record_file, record_bytes, publication_file, publication_bytes) = {
            let mut guard = acquire(root.path());
            guard
                .write_lifecycle_record(LifecyclePhase::Running)
                .expect("running");
            guard.publish(43123, "mc-host/test").expect("publish");
            let record_file = record_path(&guard);
            let publication_file = guard.dir_path().join(CONNECTION_FILE_NAME);
            let record_bytes = std::fs::read(&record_file).expect("read record");
            let publication_bytes = std::fs::read(&publication_file).expect("read publication");
            (
                record_file,
                record_bytes,
                publication_file,
                publication_bytes,
            )
        };
        let mut json: serde_json::Value = serde_json::from_slice(&record_bytes).expect("parse");
        json["payload_manifest_digest"] = serde_json::Value::String(String::new());
        for (path, bytes) in [
            (&record_file, serde_json::to_vec(&json).expect("encode")),
            (&publication_file, publication_bytes),
        ] {
            std::fs::write(path, bytes).expect("replant");
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).expect("mode");
        }

        // release does.
        let dir_path = runtime_dir_path(Some(root.path())).expect("path");
        let dir = openat(
            rustix::fs::CWD,
            dir_path.as_path(),
            OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::RDONLY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .expect("open run dir");
        flock(&dir, FlockOperation::NonBlockingLockExclusive).expect("exclusive runtime lock");

        let observed = probe(root.path());
        assert_eq!(
            observed.state,
            LifecycleState::Running,
            "a live pre-coordination incumbent must classify, not alarm: {}",
            observed.reason
        );
        assert!(!observed.instance_lock_free);
        assert!(
            observed.lifetime_lock_free,
            "the free lifetime fence is the incumbent signal for control paths"
        );
    }

    #[test]
    fn stale_lifecycle_temps_are_swept() {
        let root = temp_root();
        let dir_path = {
            let guard =
                InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("first acquire");
            guard.dir_path().to_path_buf()
        };
        let stale = dir_path.join(format!(".{LIFECYCLE_RECORD_NAME}.99999.deadbeef.tmp"));
        std::fs::write(&stale, b"orphaned mid-write").expect("plant temp");
        let long_ago = SystemTime::now() - Duration::from_secs(60 * 60 * 24);
        std::fs::File::open(&stale)
            .expect("open temp")
            .set_times(std::fs::FileTimes::new().set_modified(long_ago))
            .expect("age temp");

        let _guard =
            InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire sweeps");
        assert!(
            !stale.exists(),
            "a stale lifecycle temp must be swept like a publication temp"
        );
    }
}
