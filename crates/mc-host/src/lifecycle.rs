//! Native lifecycle evidence and control: the schema-1 lifecycle record, the
//! separate lifecycle-root transaction lock, the observational state probe,
//! and the `host.shutdown` commit latch (plan KTD2-KTD4).
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
    flock_bounded, flock_exclusive_bounded, hex, io_err, is_safe_ancestor, is_secure_regular,
    mode_bits, read_all_fd, runtime_dir_path, secure_runtime_dir, InstanceError, InstanceGuard,
    CONNECTION_FILE_NAME, S_IFDIR, S_IFMT,
};

/// Canonical lifecycle-record name inside the runtime directory.
pub const LIFECYCLE_RECORD_NAME: &str = "mc-host-lifecycle.json";

/// Snapshot cap shared with the publication reader.
const MAX_EVIDENCE_BYTES: usize = 65_536;

/// Resolves `${dataDir}/cortexkit/lifecycle`: the directory whose inode
/// carries the cross-process lifecycle transaction lock (plan KTD2). It is
/// deliberately distinct from the runtime directory so the daemon's
/// whole-incarnation instance lock and the launcher's short transaction lock
/// never contend on one inode.
pub fn lifecycle_dir_path(data_dir_override: Option<&Path>) -> Result<PathBuf, InstanceError> {
    let run = runtime_dir_path(data_dir_override)?;
    let base = run
        .parent()
        .expect("runtime dir always has a cortexkit parent")
        .to_path_buf();
    Ok(base.join("lifecycle"))
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
const MAX_DIGEST_LEN: usize = 128;

fn decode_record(bytes: &[u8]) -> Option<LifecycleRecord> {
    let wire: WireRecord = serde_json::from_slice(bytes).ok()?;
    if wire.schema != 1 {
        return None;
    }
    let phase = LifecyclePhase::parse(&wire.phase)?;
    let is_hex = |s: &str, len: usize| {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if !is_hex(&wire.launch_id, HEX_LAUNCH_LEN)
        || !is_hex(&wire.daemon_id, HEX_DAEMON_LEN)
        || wire.payload_manifest_digest.len() > MAX_DIGEST_LEN
    {
        return None;
    }
    Some(LifecycleRecord {
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
            // The launcher-staged generation identity arrives with the
            // packaged payload work (plan U2); an unstaged host records an
            // empty digest.
            payload_manifest_digest: String::new(),
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
        let Some(record) = decode_record(&bytes) else {
            return;
        };
        if record.launch_id != hex(self.launch_id()) || record.daemon_id != hex(self.daemon_id()) {
            return;
        }
        let _ = unlinkat(self.dir(), LIFECYCLE_RECORD_NAME, AtFlags::empty());
    }
}

/// Exclusive cross-process lifecycle transaction lock, held on the secured
/// lifecycle-root directory inode (plan KTD2).
///
/// The lock inode is a mutual-exclusion token, not an evidence anchor: the
/// runtime evidence lives in the sibling `run` directory, and this type
/// exposes no descriptor-relative evidence operations. If the lifecycle
/// path is replaced while a holder is live, a second caller can lock a
/// fresh inode and transactions overlap on the same evidence; the evidence
/// itself stays safe through its own fences (the instance lock plus
/// atomic, identity-fenced writes), which is why probes also tolerate
/// running without this lock at all. Serializing mutators across path
/// replacement requires anchoring mutations to a locked evidence
/// descriptor.
pub struct LifecycleRootLock {
    _dir: OwnedFd,
    dir_path: PathBuf,
}

impl std::fmt::Debug for LifecycleRootLock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LifecycleRootLock")
            .field("dir", &self.dir_path)
            .finish_non_exhaustive()
    }
}

impl LifecycleRootLock {
    /// Securely creates or opens the lifecycle root and takes the exclusive
    /// nonblocking transaction lock. `AlreadyRunning` means another lifecycle
    /// transaction holds it.
    ///
    /// Uses the same bounded retry as the instance lock: a probe's shared
    /// hold is transient, and reporting `AlreadyRunning` for it would name a
    /// mutator that does not exist.
    pub fn acquire_exclusive(data_dir_override: Option<&Path>) -> Result<Self, InstanceError> {
        let dir_path = lifecycle_dir_path(data_dir_override)?;
        let dir = secure_runtime_dir(&dir_path)?;
        flock_exclusive_bounded(&dir, &dir_path, "flock_lifecycle_root")?;
        Ok(Self {
            _dir: dir,
            dir_path,
        })
    }

    /// Validation-only shared lock for observational probes: never creates
    /// the root, never chmods it. `Ok(None)` means no lifecycle root exists
    /// or a mutator outlasted the bounded wait below; the probe proceeds on
    /// evidence alone and relies on its bounded reread loop.
    ///
    /// The wait mirrors the bounded retry mutators use against a probe's
    /// transient shared hold: a mutator's transaction is a few file writes,
    /// so retrying covers it and the probe samples with the transaction
    /// excluded instead of reading a stable-looking intermediate state the
    /// reread loop cannot detect. Blocking: the retry sleeps the calling
    /// thread, matching `probe_lifecycle`'s documented contract.
    pub fn acquire_shared(data_dir_override: Option<&Path>) -> Result<Option<Self>, InstanceError> {
        let dir_path = lifecycle_dir_path(data_dir_override)?;
        let Some(dir) = open_validated_dir(&dir_path)? else {
            return Ok(None);
        };
        if flock_bounded(
            &dir,
            &dir_path,
            "flock_lifecycle_root",
            FlockOperation::NonBlockingLockShared,
        )? {
            Ok(Some(Self {
                _dir: dir,
                dir_path,
            }))
        } else {
            Ok(None)
        }
    }
}

/// Opens an existing directory by walking each component with `O_NOFOLLOW`
/// — so no intermediate or final symlink is followed — without creating or
/// chmodding anything; validates replacement-proof intermediates and
/// owner-only final metadata. `None` means some component does not exist.
fn open_validated_dir(dir_path: &Path) -> Result<Option<OwnedFd>, InstanceError> {
    let flags = OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::RDONLY | OFlags::CLOEXEC;
    let insecure = || InstanceError::Insecure {
        what: "lifecycle evidence directory",
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
    // Shared transaction lock when the root exists: an in-flight mutator is
    // excluded for the duration of the sample. Absence (or a held exclusive
    // lock) degrades to evidence-only probing, made coherent by the bounded
    // reread loop below.
    let _root = LifecycleRootLock::acquire_shared(data_dir_override)?;

    let dir_path = runtime_dir_path(data_dir_override)?;
    let Some(dir) = open_validated_dir(&dir_path)? else {
        return Ok(LifecycleProbe {
            state: LifecycleState::Stopped,
            reason: "no runtime directory",
            record: None,
            publication: None,
            instance_lock_free: true,
        });
    };

    const MAX_REREADS: usize = 3;
    // A daemon must hold the instance lock before it can write its `starting`
    // record, so a probe landing in that window sees a held lock with no
    // evidence — by shape alone indistinguishable from a wedged host. The
    // record write includes an fsync, so the window is short but not
    // instantaneous; re-sample a bounded number of times before believing it.
    // A genuinely record-less holder still classifies `wedged` after the last
    // attempt.
    const ABSENT_RECORD_GRACE: usize = 2;
    const GRACE_DELAY: Duration = Duration::from_millis(25);

    let mut torn_rereads = 0;
    let mut grace_rereads = 0;
    loop {
        let before = sample_evidence(&dir);
        let lock_free = instance_lock_free(&dir, &dir_path)?;
        let after = sample_evidence(&dir);
        if before != after && torn_rereads + 1 < MAX_REREADS {
            torn_rereads += 1;
            continue;
        }
        if !lock_free && after.record == EvidenceFile::Absent && grace_rereads < ABSENT_RECORD_GRACE
        {
            grace_rereads += 1;
            std::thread::sleep(GRACE_DELAY);
            continue;
        }
        return Ok(classify(after, lock_free, freshness));
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

fn classify(sample: EvidenceSample, lock_free: bool, freshness: &ProbeFreshness) -> LifecycleProbe {
    let record = sample.record.bytes().and_then(decode_record);
    let publication = sample.publication.bytes().and_then(publication_summary);

    if lock_free {
        // No holder means no incarnation, whatever evidence remains: a
        // crashed daemon's leftovers are diagnostics, not liveness. Nothing
        // is unlinked (plan R5).
        let reason = if sample.record != EvidenceFile::Absent
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
        };
    }

    let wedged = |reason: &'static str, record: Option<LifecycleRecord>| LifecycleProbe {
        state: LifecycleState::Wedged,
        reason,
        record,
        publication: publication.clone(),
        instance_lock_free: false,
    };

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
        let guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        guard
            .write_lifecycle_record(LifecyclePhase::Starting)
            .expect("write starting");

        let bytes = std::fs::read(record_path(&guard)).expect("read record");
        let record = decode_record(&bytes).expect("strict decode");
        assert_eq!(record.phase, LifecyclePhase::Starting);
        assert_eq!(record.launch_id, hex(guard.launch_id()));
        assert_eq!(record.daemon_id, hex(guard.daemon_id()));
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
            let guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
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
            "payload_manifest_digest": "",
            "pid": 42,
            "written_at_ms": 1
        });
        assert!(decode_record(&serde_json::to_vec(&valid).unwrap()).is_some());

        let mutate = |f: &dyn Fn(&mut serde_json::Value)| {
            let mut v = valid.clone();
            f(&mut v);
            decode_record(&serde_json::to_vec(&v).unwrap())
        };
        assert!(mutate(&|v| v["schema"] = 2.into()).is_none());
        assert!(mutate(&|v| v["phase"] = "paused".into()).is_none());
        assert!(mutate(&|v| v["launch_id"] = "short".into()).is_none());
        assert!(mutate(&|v| v["daemon_id"] = "zz".repeat(16).into()).is_none());
        assert!(
            mutate(&|v| v["extra"] = 1.into()).is_none(),
            "unknown fields are rejected"
        );
        assert!(mutate(&|v| {
            v["payload_manifest_digest"] = "d".repeat(MAX_DIGEST_LEN + 1).into();
        })
        .is_none());
        assert!(decode_record(b"not json").is_none());
        assert!(decode_record(b"[1,2]").is_none());
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
        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");

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
        let guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
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
        let guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
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
        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");

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
            let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
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
        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
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
    fn lifecycle_root_lock_is_exclusive_and_inode_anchored() {
        let root = temp_root();
        let first = LifecycleRootLock::acquire_exclusive(Some(root.path())).expect("first");
        assert!(matches!(
            LifecycleRootLock::acquire_exclusive(Some(root.path())),
            Err(InstanceError::AlreadyRunning)
        ));

        // Rename the locked root away: the holder still owns the old inode,
        // and a successor anchors a fresh one — two namespaces, never two
        // owners of one.
        let old = lifecycle_dir_path(Some(root.path())).expect("path");
        let moved = old.with_file_name("lifecycle-moved");
        std::fs::rename(&old, &moved).expect("rename lifecycle root");
        let second = LifecycleRootLock::acquire_exclusive(Some(root.path())).expect("fresh inode");
        drop(second);
        drop(first);
    }

    #[test]
    fn shared_probe_lock_never_creates_and_yields_none_under_a_mutator() {
        let root = temp_root();
        assert!(LifecycleRootLock::acquire_shared(Some(root.path()))
            .expect("no root")
            .is_none());
        assert!(
            std::fs::read_dir(root.path())
                .expect("read root")
                .next()
                .is_none(),
            "a probe lock must not create the root"
        );

        let mutator = LifecycleRootLock::acquire_exclusive(Some(root.path())).expect("mutator");
        assert!(
            LifecycleRootLock::acquire_shared(Some(root.path()))
                .expect("held root")
                .is_none(),
            "a held exclusive lock degrades the probe to evidence-only"
        );
        drop(mutator);
        assert!(LifecycleRootLock::acquire_shared(Some(root.path()))
            .expect("free root")
            .is_some());
    }

    #[test]
    fn symlinked_lifecycle_root_fails_closed_for_probes() {
        let root = temp_root();
        let elsewhere = temp_root();
        let path = lifecycle_dir_path(Some(root.path())).expect("path");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("parents");
        std::os::unix::fs::symlink(elsewhere.path(), &path).expect("symlink");
        assert!(LifecycleRootLock::acquire_shared(Some(root.path())).is_err());
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
            let guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
            guard
                .write_lifecycle_record(LifecyclePhase::Running)
                .expect("running");
            // Replace the named evidence with a FIFO the test never opens for
            // writing, so a blocking open can never complete.
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

    /// A FIFO at the record name must not hang fenced removal either: that
    /// runs from `Drop` while the instance lock is held, so a hang would
    /// retain the lock and fail every later start.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_fifo_at_the_record_name_cannot_hang_fenced_removal() {
        let root = temp_root();
        let guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
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

    /// A symlink is a hostile shape, not absence. Collapsing its `ELOOP` to
    /// `Absent` would let it downgrade a `wedged` verdict to `stopping`.
    #[test]
    fn a_symlinked_publication_is_insecure_not_absent() {
        let root = temp_root();
        let elsewhere = temp_root();
        let guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
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
            let mut guard = InstanceGuard::acquire(Some(&root_path)).expect("acquire");
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
            "payload_manifest_digest": "",
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
        let guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
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

    /// Lifecycle temps must be reclaimable: they share the publication's temp
    /// shape, so the acquire-time stale sweep has to cover both canonical
    /// names — including for an incarnation that never reaches publish.
    #[test]
    fn stale_lifecycle_temps_are_swept() {
        let root = temp_root();
        let dir_path = {
            let guard = InstanceGuard::acquire(Some(root.path())).expect("first acquire");
            guard.dir_path().to_path_buf()
        };
        let stale = dir_path.join(format!(".{LIFECYCLE_RECORD_NAME}.99999.deadbeef.tmp"));
        std::fs::write(&stale, b"orphaned mid-write").expect("plant temp");
        let long_ago = SystemTime::now() - Duration::from_secs(60 * 60 * 24);
        std::fs::File::open(&stale)
            .expect("open temp")
            .set_times(std::fs::FileTimes::new().set_modified(long_ago))
            .expect("age temp");

        let _guard = InstanceGuard::acquire(Some(root.path())).expect("acquire sweeps");
        assert!(
            !stale.exists(),
            "a stale lifecycle temp must be swept like a publication temp"
        );
    }
}
