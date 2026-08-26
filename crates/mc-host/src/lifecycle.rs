//! Native lifecycle evidence and control: the schema-1 lifecycle record, the
//! stable coordination fences (`transaction.lock` and `lifetime.lock`), the
//! observational state probe, and the `host.shutdown` commit latch (plan
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

/// Canonical lifecycle-record name inside the runtime directory.
pub const LIFECYCLE_RECORD_NAME: &str = "mc-host-lifecycle.json";

/// Version-neutral coordination directory name directly under the data root.
/// Every release resolves this same owner-only directory; supported code
/// never renames, replaces, or unlinks it.
pub const COORDINATION_DIR_NAME: &str = ".mc-host-coordination";

/// Never-renamed regular file carrying the cross-process lifecycle
/// transaction flock inside the coordination directory.
pub const TRANSACTION_LOCK_NAME: &str = "transaction.lock";

/// Never-renamed regular file carrying the daemon's whole-incarnation
/// lifetime flock inside the coordination directory.
pub const LIFETIME_LOCK_NAME: &str = "lifetime.lock";

/// Byte length of the canonical payload-manifest digest: the lowercase hex
/// SHA-256 of the staged payload manifest.
pub const PAYLOAD_MANIFEST_DIGEST_LEN: usize = 64;

/// Accepts exactly the canonical release digest shape: 64 lowercase hex
/// characters, nothing else. Empty, oversized, uppercase, or otherwise
/// noncanonical digests are rejected (plan R36).
pub fn is_canonical_payload_digest(digest: &str) -> bool {
    digest.len() == PAYLOAD_MANIFEST_DIGEST_LEN
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Snapshot cap shared with the publication reader.
const MAX_EVIDENCE_BYTES: usize = 65_536;

/// Resolves `${dataDir}/.mc-host-coordination`: the fixed owner-only
/// directory whose never-renamed `transaction.lock` and `lifetime.lock`
/// regular files serialize lifecycle mutation and fence incarnation lifetime
/// across every release (plan KTD2). It sits outside the replaceable managed
/// `cortexkit` subtree, so replacing `lifecycle`, `run`, or the whole subtree
/// cannot split either lock.
pub fn coordination_dir_path(data_dir_override: Option<&Path>) -> Result<PathBuf, InstanceError> {
    Ok(data_dir_path(data_dir_override)?.join(COORDINATION_DIR_NAME))
}

/// Resolves `${dataDir}/cortexkit/lifecycle`: the managed lifecycle
/// namespace (staged generations and profiles land here in later units). It
/// is replaceable and therefore carries no lock; serialization lives on the
/// stable coordination files instead.
pub fn lifecycle_dir_path(data_dir_override: Option<&Path>) -> Result<PathBuf, InstanceError> {
    let run = runtime_dir_path(data_dir_override)?;
    let base = run
        .parent()
        .expect("runtime dir always has a cortexkit parent")
        .to_path_buf();
    Ok(base.join("lifecycle"))
}

/// Opens (creating if absent) the named coordination lock file inside the
/// secured coordination directory and validates it is an owner-only,
/// single-link regular file. `O_NONBLOCK` keeps a planted FIFO from hanging
/// the open; the fstat check still rejects it. The mode is normalized to
/// 0600 through the descriptor we validated as our own — never through an
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

/// `O_NONBLOCK` keeps a planted FIFO from hanging the open; the fstat check
/// still rejects it. The mode is normalized to 0600 through the descriptor
/// we validated as our own — never through an attacker-selected path.
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

/// No-create opener for observational probes: `Ok(None)` when the
/// coordination directory or the named lock file does not exist. A hostile
/// shape — symlink, FIFO, wrong owner, loose mode, extra links — fails
/// closed instead of reading as absence.
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

/// The daemon's whole-incarnation lifetime fence: an exclusive flock on the
/// stable `lifetime.lock` coordination file, taken before the runtime
/// directory is secured and held through publication cleanup, component
/// shutdown, and callback reaping (it is dropped with [`InstanceGuard`],
/// after the runtime-directory lock). Because the file is never renamed and
/// sits outside `cortexkit`, replacing the managed subtree cannot free it,
/// so a successor cannot overlap a displaced incarnation.
pub(crate) struct LifetimeLock {
    _file: OwnedFd,
}

impl LifetimeLock {
    pub(crate) fn acquire(data_dir_override: Option<&Path>) -> Result<Self, InstanceError> {
        let (file, path) = open_coordination_lock_create(data_dir_override, LIFETIME_LOCK_NAME)?;
        flock_exclusive_bounded(&file, &path, "flock_lifetime")?;
        Ok(Self { _file: file })
    }
}

/// Nonblocking observational test of the lifetime fence. `Ok(true)` means no
/// incarnation holds it (an absent coordination root or lock file also has
/// no possible holder). The momentary shared hold is released when the
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

/// Returns whether the lifecycle-record name holds quarantined bytes: a
/// readable regular file whose JSON carries an unknown schema. Such bytes
/// are preserved byte-for-byte — supported code must not interpret,
/// migrate, overwrite, or remove them (plan R22).
pub(crate) fn quarantined_record_present(dir: &OwnedFd) -> bool {
    let Ok(fd) = openat(
        dir,
        LIFECYCLE_RECORD_NAME,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    ) else {
        return false;
    };
    let Ok(stat) = rustix::fs::fstat(&fd) else {
        return false;
    };
    if (mode_bits(&stat) & S_IFMT) != S_IFREG {
        return false;
    }
    let Ok(bytes) = read_all_fd(&fd, MAX_EVIDENCE_BYTES) else {
        return false;
    };
    matches!(decode_record(&bytes), RecordDecode::UnknownSchema)
}

/// Where in an incarnation the daemon reported itself.
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

/// Strict schema-1 lifecycle record. PID is optional display metadata only:
/// no decision may be made from it (plan KTD3).
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

/// Outcome of strictly decoding lifecycle-record bytes. Unknown schemas are
/// distinguished from corruption because they are quarantined, not repaired:
/// the bytes stay untouched and classification reports
/// `unsupported_state_schema` instead of a corrupt record.
#[derive(Debug, PartialEq, Eq)]
enum RecordDecode {
    Valid(LifecycleRecord),
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
    if !is_hex(&wire.launch_id, HEX_LAUNCH_LEN)
        || !is_hex(&wire.daemon_id, HEX_DAEMON_LEN)
        || !is_canonical_payload_digest(&wire.payload_manifest_digest)
    {
        return RecordDecode::Malformed;
    }
    RecordDecode::Valid(LifecycleRecord {
        phase,
        launch_id: wire.launch_id,
        daemon_id: wire.daemon_id,
        payload_manifest_digest: wire.payload_manifest_digest,
        pid: wire.pid,
        written_at_ms: wire.written_at_ms,
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

impl InstanceGuard {
    /// A path or symlink swap cannot redirect the write outside the locked
    /// directory inode.
    ///
    /// Blocking-synchronous: one small-file open/write/fsync/rename, the same
    /// exposure `publish` and `remove_publication` already have. Callers run
    /// it directly on startup and teardown paths — once per incarnation, not
    /// per request — accepting a single fsync's latency there rather than
    /// restructuring guard ownership around `spawn_blocking`.
    pub fn write_lifecycle_record(&self, phase: LifecyclePhase) -> Result<(), InstanceError> {
        let record = WireRecord {
            schema: 1,
            phase: phase.as_str().to_owned(),
            launch_id: hex(self.launch_id()),
            daemon_id: hex(self.daemon_id()),
            // The same validated digest is written for every phase of one
            // incarnation, so `starting`, `running`, and `stopping` carry a
            // byte-identical nonempty payload identity (plan R36).
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

    /// Marks this incarnation `stopping` and then retires its publication.
    ///
    /// The order matters: `classify` maps a held lock plus a `running` record
    /// with no publication to `wedged`, so unpublishing without first
    /// demoting the phase reports an operator-visible fault for an orderly
    /// stop. Every teardown path — graceful shutdown and the abandoned-`run`
    /// guard — goes through here so the two cannot report different states
    /// for the same situation.
    ///
    /// The phase write is best effort: teardown proceeds regardless, and a
    /// stale phase ages to `wedged` honestly.
    pub fn begin_stopping(&mut self) {
        let _ = self.write_lifecycle_record(LifecyclePhase::Stopping);
        self.remove_publication();
    }

    /// Best-effort fenced removal of this incarnation's lifecycle record:
    /// no-follow open, secure regular file, matching launch and daemon
    /// identity. A mismatch leaves the file alone — an old incarnation must
    /// never delete a successor's evidence.
    ///
    /// `O_NONBLOCK` is load-bearing, not an optimization: `O_NOFOLLOW`
    /// rejects a symlink but not a FIFO, and opening a FIFO for reading
    /// blocks until a writer arrives. Without it a planted FIFO at this name
    /// would hang this call forever — and this runs from `Drop` while the
    /// instance lock is still held, so the lock would never be released and
    /// every later start would fail `AlreadyRunning`. The flag is a no-op on
    /// regular files, and `is_secure_regular` below still rejects the FIFO.
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

/// Exclusive cross-process lifecycle transaction lock, held as a flock on
/// the never-renamed `${dataDir}/.mc-host-coordination/transaction.lock`
/// regular file (plan KTD2).
///
/// The lock file is a mutual-exclusion token, not an evidence anchor: the
/// runtime evidence lives in the managed `cortexkit/run` directory. Because
/// the token sits outside the replaceable managed subtree and is never
/// renamed or unlinked by supported code, renaming or replacing `lifecycle`,
/// `run`, or the whole `cortexkit` tree cannot mint a second transaction
/// owner. A holder that mutates named entries must still anchor those
/// mutations to retained descriptors and abort on identity drift
/// ([`NamespaceAnchor`]); the lock alone serializes mutators, it does not
/// prove the names still resolve to the tree the holder opened.
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
    /// Securely creates or opens the coordination root and takes the
    /// exclusive nonblocking transaction flock on `transaction.lock`.
    /// `AlreadyRunning` means another lifecycle transaction holds it.
    ///
    /// Uses the same bounded retry as the instance lock: a probe's shared
    /// hold is transient, and reporting `AlreadyRunning` for it would name a
    /// mutator that does not exist.
    pub fn acquire_exclusive(data_dir_override: Option<&Path>) -> Result<Self, InstanceError> {
        let (file, path) = open_coordination_lock_create(data_dir_override, TRANSACTION_LOCK_NAME)?;
        flock_exclusive_bounded(&file, &path, "flock_transaction")?;
        Ok(Self { _file: file, path })
    }

    /// Validation-only shared lock for observational probes: never creates
    /// the coordination root or the lock file. `Ok(None)` means no
    /// coordination root exists or a mutator outlasted the bounded wait
    /// below; the probe proceeds on evidence alone and relies on its bounded
    /// reread loop.
    ///
    /// The wait mirrors the bounded retry mutators use against a probe's
    /// transient shared hold: a mutator's transaction is a few file writes,
    /// so retrying covers it and the probe samples with the transaction
    /// excluded instead of reading a stable-looking intermediate state the
    /// reread loop cannot detect. Blocking: the retry sleeps the calling
    /// thread, matching `probe_lifecycle`'s documented contract.
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

/// Retained managed-namespace descriptors for a lifecycle mutator:
/// `cortexkit` plus whichever of its `lifecycle` and `run` children exist at
/// capture. A holder of the transaction lock captures the anchor, performs
/// mutations relative to the retained descriptors, and calls [`verify`]
/// before reporting any named-namespace result: if a captured name no longer
/// resolves to the same identity — the tree was renamed or replaced — the
/// holder must abort rather than claim a commit under the canonical names.
///
/// [`verify`]: NamespaceAnchor::verify
pub struct NamespaceAnchor {
    entries: Vec<AnchorEntry>,
}

struct AnchorEntry {
    path: PathBuf,
    /// Retained so mutations stay descriptor-relative for the anchor's
    /// lifetime; identity comparison uses the recorded (dev, ino).
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

// `Stat` field types vary by platform (macOS `st_dev` is `i32`); the casts
// are no-ops on Linux but load-bearing elsewhere.
#[allow(clippy::unnecessary_cast)]
fn stat_identity(stat: &rustix::fs::Stat) -> (u64, u64) {
    (stat.st_dev as u64, stat.st_ino as u64)
}

impl NamespaceAnchor {
    /// Opens `cortexkit` and its existing `lifecycle` and `run` children
    /// through validated no-follow descriptors and records their identities.
    /// Absent entries are simply not captured: creating them later is the
    /// mutator's own work, not drift.
    pub fn capture(data_dir_override: Option<&Path>) -> Result<Self, InstanceError> {
        let base = data_dir_path(data_dir_override)?.join("cortexkit");
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

    /// Re-resolves every captured name and fails with
    /// [`InstanceError::NamespaceDrift`] when a name is gone or resolves to a
    /// different identity. Callers abort their named-namespace result on
    /// error; the retained descriptors and stable locks are unaffected.
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

/// Opens an existing directory by walking each component with `O_NOFOLLOW`
/// — so no intermediate or final symlink is followed — without creating or
/// chmodding anything; validates replacement-proof intermediates and
/// owner-only final metadata. `None` means some component does not exist.
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
            // O_NOFOLLOW on a symlink component reports ELOOP; a directory
            // opener hitting a non-directory reports ENOTDIR. Both are
            // hostile shapes, not absence.
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

/// Observed lifecycle state (plan R6). `Wedged` is observational only:
/// nothing in this crate kills processes or breaks locks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Wedged,
}

/// Untrusted diagnostic summary of a publication. Never carries key bytes
/// and never authorizes anything (plan R16).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicationSummary {
    pub daemon_id: String,
    pub daemon_ver: String,
    pub pid: u32,
    pub port: u16,
}

/// How long `starting` and `stopping` evidence stays credible before a held
/// lock with that evidence classifies `wedged`.
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

/// One coherent lifecycle observation.
#[derive(Debug)]
pub struct LifecycleProbe {
    pub state: LifecycleState,
    /// Bounded static classification detail; never tainted file content.
    pub reason: &'static str,
    pub record: Option<LifecycleRecord>,
    pub publication: Option<PublicationSummary>,
    pub instance_lock_free: bool,
    /// Whether the stable `lifetime.lock` fence had no holder at sample time.
    pub lifetime_lock_free: bool,
}

#[derive(PartialEq, Eq)]
struct EvidenceSample {
    record: EvidenceFile,
    publication: EvidenceFile,
}

/// Reads one evidence file, distinguishing genuine absence from a hostile
/// shape. `O_NONBLOCK` is required for correctness: `O_NOFOLLOW` rejects a
/// symlink but not a FIFO, and a FIFO opened for reading blocks until a
/// writer arrives, which would hang every probe uncancellably (a blocking
/// syscall outruns any `spawn_blocking` timeout). The flag is a no-op on
/// regular files and `is_secure_regular` still rejects the FIFO.
fn read_evidence_file(dir: &OwnedFd, name: &str) -> EvidenceFile {
    let fd = match openat(
        dir,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        // Only "the name is not there" is absence. Every other failure is a
        // shape this probe must fail closed on: `ELOOP` from a planted
        // symlink, `ENOTDIR`/`ENXIO` from a hostile type, `EACCES` from a
        // mode we cannot vouch for, `EMFILE`/`ENFILE` from exhaustion.
        // Collapsing those to `Absent` would let a symlink downgrade a
        // `wedged` verdict to `starting`/`stopping` (protocol §4.3).
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
    /// Wrong type, owner, mode, link count, or oversize: hostile shape.
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

/// Nonblocking probe of instance-lock ownership on the same open file
/// description the evidence was sampled through, so a directory swapped
/// between opens cannot pair one inode's evidence with another's lock.
/// flock ownership is per open file description, so this works even when the
/// holding daemon lives in the same process.
///
/// The test takes a *shared* lock, not an exclusive one. A daemon holds this
/// inode exclusively for its whole incarnation, and shared conflicts with
/// exclusive, so a live host is still detected. Testing with an exclusive
/// lock would instead make probes conflict with each other: the loser would
/// read `WOULDBLOCK`, report the lock held, and misclassify a stopped host as
/// `wedged` (or resurrect a crashed daemon's stale evidence as `running`),
/// inverting the protocol §4.3 rule that a free lock always means `stopped`.
/// The probe unlocks immediately either way.
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

/// Decodes a publication and enforces the same contract discovery applies
/// (protocol §4.1): schema, key length, declared wire version, loopback
/// host, nonzero port, nonempty daemon version. A publication no conforming
/// client would accept must not count as evidence of a running host, so
/// `None` here sends a held lock with a `running` record to `wedged` rather
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

/// Classifies host lifecycle state from lock ownership plus fenced evidence
/// (plan KTD3). Blocking-synchronous and observational: it creates nothing,
/// chmods nothing, unlinks nothing, and never signals a PID. It may sleep its
/// thread briefly while re-sampling, so async callers must wrap it in
/// `spawn_blocking`.
pub fn probe_lifecycle(
    data_dir_override: Option<&Path>,
    freshness: &ProbeFreshness,
) -> Result<LifecycleProbe, InstanceError> {
    // Shared transaction lock when the coordination root exists: an
    // in-flight mutator is excluded for the duration of the sample. Absence
    // (or a held exclusive lock) degrades to evidence-only probing, made
    // coherent by the bounded reread loop below.
    let _root = LifecycleTransactionLock::acquire_shared(data_dir_override)?;

    const MAX_REREADS: usize = 3;
    // A daemon must hold the instance lock before it can write its `starting`
    // record, so a probe landing in that window sees a held lock with no
    // evidence — by shape alone indistinguishable from a wedged host. The
    // record write includes an fsync, so the window is short but not
    // instantaneous; re-sample a bounded number of times before believing it.
    // A genuinely record-less holder still classifies `wedged` after the last
    // attempt.
    const ABSENT_RECORD_GRACE: usize = 2;
    // The lifetime fence is taken before the runtime lock at start and
    // released after it at teardown, so a probe can land in a window where
    // exactly one is held. The window is a few syscalls wide; re-sample a
    // bounded number of times before treating disagreement as a fault.
    const LOCK_DISAGREEMENT_GRACE: usize = 2;
    const GRACE_DELAY: Duration = Duration::from_millis(25);

    let dir_path = runtime_dir_path(data_dir_override)?;
    // A missing runtime directory is `stopped` only when the stable lifetime
    // fence is also free. A held fence names a live incarnation whose
    // namespace was replaced (or one still creating its runtime directory:
    // the same bounded grace covers that startup window). A free replacement
    // runtime lock is never proof that the first daemon ended.
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
        let lifetime_before = lifetime_lock_free(data_dir_override)?;
        let before = sample_evidence(&dir);
        let lock_free = instance_lock_free(&dir, &dir_path)?;
        let after = sample_evidence(&dir);
        let lifetime_free = lifetime_lock_free(data_dir_override)?;
        if (before != after || lifetime_before != lifetime_free) && torn_rereads + 1 < MAX_REREADS {
            torn_rereads += 1;
            continue;
        }
        if lock_free != lifetime_free && disagreement_rereads < LOCK_DISAGREEMENT_GRACE {
            disagreement_rereads += 1;
            std::thread::sleep(GRACE_DELAY);
            continue;
        }
        if !lock_free && after.record == EvidenceFile::Absent && grace_rereads < ABSENT_RECORD_GRACE
        {
            grace_rereads += 1;
            std::thread::sleep(GRACE_DELAY);
            continue;
        }
        return Ok(classify(after, lock_free, lifetime_free, freshness));
    }
}

/// A credible timestamp lies within `window` of now, in either direction:
/// older has expired, and further in the future than the window exceeds any
/// plausible clock skew.
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
    let record = match decoded {
        Some(RecordDecode::Valid(record)) => Some(record),
        _ => None,
    };
    let publication = sample.publication.bytes().and_then(publication_summary);

    if lock_free && lifetime_free {
        // No holder of either fence means no incarnation, whatever evidence
        // remains: a crashed daemon's leftovers are diagnostics, not
        // liveness. Nothing is unlinked (plan R5). Quarantined unknown-schema
        // bytes are still surfaced so callers report them instead of
        // treating the root as cleanly reusable.
        let reason = if unknown_schema {
            "unsupported_state_schema"
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

    // Exactly one fence held after the bounded rereads: a replaced runtime
    // directory, a mixed-release holder, or a genuinely stuck teardown. No
    // combination of evidence can make that a coherent running incarnation.
    if lock_free != lifetime_free {
        return wedged("lifetime and runtime locks disagree", record);
    }

    if unknown_schema {
        return wedged("unsupported_state_schema", record);
    }
    if sample.record == EvidenceFile::Insecure {
        return wedged("lifecycle record failed security checks", record);
    }
    if sample.publication == EvidenceFile::Insecure {
        return wedged("publication failed security checks", record);
    }
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
            // A publication under a foreign daemon ID is expected crash
            // residue here: a SIGKILLed predecessor leaves its publication
            // behind, and the successor writes its `starting` record before
            // its own `publish` overwrites the file. Only a `running` claim
            // requires the publication to match.
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
            // Same crash-residue rule as `starting`: an incarnation that
            // failed before publishing tears down past a predecessor's
            // fenced-off publication without ever owning it.
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
        instance_lock_free: false,
        lifetime_lock_free: false,
    }
}

/// Host-owned `host.shutdown` commit latch: `open -> response_in_flight ->
/// committed` (plan KTD4). Full-frame write acknowledgement of the winning
/// correlated success response is the stop linearization point; every
/// pre-acknowledgement failure reopens ownership for a later authenticated
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

/// What a shutdown requester holds after asking the latch for ownership.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LatchDecision {
    /// This requester owns the attempt and must enqueue the committing
    /// response.
    Owner,
    /// Another attempt is in flight; wait for `changed` and ask again.
    Wait,
    /// A prior attempt committed; respond success without a second commit.
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

    /// A pre-acknowledgement failure returns ownership to `open` so a later
    /// requester can commit. Idempotent against an already-committed latch:
    /// commit is final.
    pub fn reopen(&self) {
        let mut phase = self.phase.lock().expect("latch lock");
        if *phase == LatchPhase::ResponseInFlight {
            *phase = LatchPhase::Open;
        }
        drop(phase);
        self.changed.notify_waiters();
    }

    /// Full-frame acknowledgement observed: the latch is committed forever.
    pub fn commit(&self) {
        *self.phase.lock().expect("latch lock") = LatchPhase::Committed;
        self.changed.notify_waiters();
    }

    /// Registers interest in the next phase change. Callers must pin the
    /// returned future and call `enable()` on it BEFORE re-checking
    /// `try_own`: `notify_waiters` only wakes futures that are already
    /// enabled or polled, so a change between check and first poll would
    /// otherwise be missed forever.
    pub fn changed(&self) -> tokio::sync::futures::Notified<'_> {
        self.changed.notified()
    }
}

impl Default for ShutdownLatch {
    fn default() -> Self {
        Self::new()
    }
}

/// Commits the latch and cancels host admission when the winning response's
/// bytes fully reach the socket; reopens ownership when dropped unrun (the
/// writer retired, the write failed or timed out, or the frame was never
/// enqueued). Runs inside retained host work — the connection writer task —
/// so requester-task cancellation after enqueue cannot lose the shutdown.
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

    /// Plants a FIFO where a coordination path expects a regular file, so the
    /// mutators and probes can prove they classify a hostile shape as such.
    ///
    /// The POSIX `mkfifo` utility, not rustix: rustix gates `mkfifoat` away from
    /// Apple targets, and this crate is `deny(unsafe_code)`, so calling
    /// `mkfifo(2)` directly is not available either. A lock name must classify as
    /// a hostile shape on every platform, so this stays compiled everywhere
    /// rather than being cfg'd out on the one whose absence let a build break
    /// reach CI unnoticed. `mkfifo` honours the umask, so the mode is set
    /// explicitly afterwards.
    fn plant_fifo(path: &Path) {
        let status = std::process::Command::new("mkfifo")
            .arg(path)
            .status()
            .expect("mkfifo is a POSIX utility present on every supported platform");
        assert!(status.success(), "mkfifo failed for {}", path.display());
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .expect("owner-only fifo");
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

            // An old incarnation must not delete a successor's record when
            // either fence member differs.
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
            String::new(),
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

    /// One incarnation writes a byte-identical nonempty digest into
    /// `starting`, `running`, and `stopping`.
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
            // The record was written milliseconds ago; a zero window has
            // already expired it.
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

        // Held lock, no record at all.
        let observed = probe(root.path());
        assert_eq!(observed.state, LifecycleState::Wedged);
        assert!(!observed.instance_lock_free);

        // Corrupt record.
        let path = record_path(&guard);
        std::fs::write(&path, b"{\"schema\":").expect("corrupt");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("mode");
        assert_eq!(probe(root.path()).state, LifecycleState::Wedged);

        // Running record whose publication names a different daemon.
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

        // Running record with no publication.
        std::fs::remove_file(&publication).expect("remove publication");
        assert_eq!(probe(root.path()).state, LifecycleState::Wedged);

        // Insecure record mode.
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
            // Simulate a crash: prevent the fenced Drop cleanup by rewriting
            // the publication under a foreign daemon ID first.
            let bytes = std::fs::read(&publication).expect("read");
            let mut json: serde_json::Value = serde_json::from_slice(&bytes).expect("parse");
            json["daemon_id"] = serde_json::json!(vec![7u8; 16]);
            // The stale PID belongs to this very-much-alive test process: a
            // live PID must not change classification (plan R5).
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
        // Plant a crashed predecessor's leftover: a well-formed publication
        // under a foreign daemon ID, exactly what a SIGKILLed incarnation
        // leaves behind for its successor to overwrite at `publish`.
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

        // The same residue under a `running` claim is a real fault.
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

    /// Scenario 1 (plan U1): a transaction holder whose managed namespace is
    /// replaced or renamed fails closed at `verify` instead of reporting a
    /// named-namespace commit against a tree it no longer owns.
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

            // Replace a child, or the whole managed subtree.
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

    /// Scenario 3 (plan U1): hostile shapes at the coordination names fail
    /// closed without creating or chmodding attacker-selected paths.
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
            // A symlink at the lock name.
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

            // A FIFO at the lock name must classify, not hang.
            let root = temp_root();
            let coordination = coordination_dir_path(Some(root.path())).expect("path");
            std::fs::create_dir_all(&coordination).expect("coordination root");
            plant_fifo(&coordination.join(name));
            let mutator_err = if name == TRANSACTION_LOCK_NAME {
                LifecycleTransactionLock::acquire_exclusive(Some(root.path())).err()
            } else {
                InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).err()
            };
            assert!(
                matches!(mutator_err, Some(InstanceError::Insecure { .. })),
                "a fifo at {name} must fail closed: {mutator_err:?}"
            );

            // A hard-linked lock file has an owner besides us.
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

        // Acknowledged: committed forever, host cancellation fired.
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
        // Discarding the writer before it writes a queued frame drops that
        // frame's hook unrun.
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

    /// `notify_waiters` wakes only enabled futures: a notification landing
    /// between `try_own` and the first poll must still be observed.
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

    // --- hostile evidence shapes and probe non-interference ---

    /// Runs `work` on a scratch thread and refuses to wait past `budget`.
    ///
    /// A thread parked in a blocking `openat` on a writer-less FIFO cannot be
    /// cancelled or joined, so a regression here would hang the whole test
    /// binary instead of failing it. Exiting the process on timeout keeps the
    /// signal unambiguous and bounded: the harness reports a failure, and no
    /// wedged thread outlives it. The fixed build returns in microseconds and
    /// never reaches the deadline.
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

    /// `O_NOFOLLOW` rejects a symlink but not a FIFO, and a FIFO opened for
    /// reading blocks until a writer arrives. Without `O_NONBLOCK` both
    /// evidence readers hang forever; the probe must instead classify the
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
            // Replace the named evidence with a FIFO the test never opens for
            // writing, so a blocking open can never complete.
            let path = guard.dir_path().join(name);
            let _ = std::fs::remove_file(&path);
            plant_fifo(&path);

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

    /// A FIFO at the record name must not hang fenced removal either: that
    /// runs from `Drop` while the instance lock is held, so a hang would
    /// retain the lock and fail every later start.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_fifo_at_the_record_name_cannot_hang_fenced_removal() {
        let root = temp_root();
        let guard = acquire(root.path());
        let path = record_path(&guard);
        plant_fifo(&path);

        within(
            Duration::from_secs(5),
            "remove_lifecycle_record blocked on a fifo, retaining the instance lock",
            move || guard.remove_lifecycle_record(),
        );
        assert!(path.exists(), "a foreign shape must survive fenced removal");
    }

    /// A symlink is a hostile shape, not absence. Collapsing its `ELOOP` to
    /// `Absent` would let it downgrade a `wedged` verdict to `stopping`.
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

    /// The probe tests lock freedom with a shared lock, so concurrent probes
    /// do not alias each other into a false "lock held" reading. An exclusive
    /// test made the loser read `WOULDBLOCK` and resurrect a crashed daemon's
    /// leftover evidence as `Running` — a false liveness claim that inverts
    /// the protocol §4.3 rule that a free lock always means `stopped`
    /// (plan R5). Leftover evidence is deliberate: it is the shape the
    /// absent-record grace re-read cannot mask.
    #[test]
    fn concurrent_probes_never_resurrect_stale_evidence_as_live() {
        let root = temp_root();
        let root_path = root.path().to_path_buf();

        // Produce genuinely valid publication bytes, then strand them with no
        // holder — exactly what a crashed daemon leaves behind.
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

        // A single, uncontended probe must already call this stopped.
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

    /// A probe still detects a real incarnation's exclusive hold.
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

    // --- U1: stable coordination fences and payload identity ---

    /// Scenario 1 (plan U1): replacing or renaming the managed `lifecycle`
    /// directory after transaction-lock acquisition must not create a second
    /// transaction owner. The lock lives on the stable coordination file, not
    /// on the replaceable managed subtree.
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

    /// Scenario 1 (plan U1): independent openers — a stand-in for N and N-1
    /// releases — must resolve the same coordination inode identities, and
    /// replacing the whole managed subtree must not move them.
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

        // Replace the entire managed subtree between openers.
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

    /// Scenario 2 (plan U1): replacing the whole `cortexkit` subtree after
    /// publication isolates the old descriptor-owned evidence, but the stable
    /// lifetime fence still names a live incarnation — a probe must not call
    /// that `stopped`, and a successor must not acquire.
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

        // The successor cannot start a second incarnation while the first
        // holds the stable lifetime fence.
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

    /// Scenario 4 (plan U1): a persisted record carrying an empty digest must
    /// never be reported as a coherent running incarnation.
    #[test]
    fn an_empty_payload_digest_is_never_a_coherent_running_incarnation() {
        let root = temp_root();
        let mut guard = acquire(root.path());
        guard
            .write_lifecycle_record(LifecyclePhase::Running)
            .expect("running");
        guard.publish(43123, "mc-host/test").expect("publish");
        assert_eq!(probe(root.path()).state, LifecycleState::Running);

        // Rewrite the record with an empty digest, keeping everything else
        // valid — the shape the pre-U1 baseline persisted.
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

    /// Scenario 5 (plan U1): an unknown lifecycle schema is preserved
    /// byte-for-byte and classified `unsupported_state_schema` — under a held
    /// fence and under free fences — and a start against it refuses rather
    /// than overwriting the quarantined bytes.
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

            // Held fences + unknown schema: never a coherent incarnation.
            let observed = probe(root.path());
            assert_eq!(observed.state, LifecycleState::Wedged);
            assert_eq!(observed.reason, "unsupported_state_schema");
            path
        };

        // Free fences + unknown schema: stopped, but the classification still
        // names the quarantined bytes and fenced removal spared them.
        assert!(record_path.exists(), "drop must not remove foreign bytes");
        let observed = probe(root.path());
        assert_eq!(observed.state, LifecycleState::Stopped);
        assert_eq!(observed.reason, "unsupported_state_schema");

        // A start must refuse rather than overwrite.
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

    /// A runtime-lock holder without the lifetime fence (the pre-coordination
    /// baseline, or a replaced-directory squatter) is a fault, never a
    /// coherent running incarnation.
    #[test]
    fn lifetime_and_runtime_lock_disagreement_is_wedged() {
        let root = temp_root();
        // Create the namespace and evidence, then release both fences.
        {
            let mut guard = acquire(root.path());
            guard
                .write_lifecycle_record(LifecyclePhase::Running)
                .expect("running");
            guard.publish(43123, "mc-host/test").expect("publish");
        }
        // Hold only the runtime-directory lock, the way a pre-coordination
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

    /// Lifecycle temps must be reclaimable: they share the publication's temp
    /// shape, so the acquire-time stale sweep has to cover both canonical
    /// names — including for an incarnation that never reaches publish.
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
