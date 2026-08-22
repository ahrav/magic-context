//! Secure instance lifecycle: runtime-directory validation, single-instance
//! lock, credential minting, and connection-file publication/cleanup.
//!
//! Every mutation is anchored to one validated directory descriptor opened
//! with `O_NOFOLLOW`; path-based operations never cross the security boundary,
//! so a concurrent path/symlink swap cannot redirect a create, rename, or
//! unlink outside that directory (plan KTD4, protocol §4.2).

use std::fmt;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use rustix::fd::OwnedFd;
use rustix::fs::{
    flock, fsync, mkdirat, openat, renameat, unlinkat, AtFlags, FlockOperation, Mode, OFlags, CWD,
};

use subc_transport::{ConnectionInfo, Endpoint, DAEMON_ID_LEN, KEY_LEN, SCHEMA_VERSION};

/// Canonical publication name inside the runtime directory (protocol §4.1).
pub const CONNECTION_FILE_NAME: &str = "subc-connection.json";

/// Stale-sweep age threshold for abandoned publication temp files
/// (protocol §4.2).
const STALE_TEMP_AFTER: Duration = Duration::from_secs(600);

/// Fresh per-incarnation bearer key. Its `Debug` implementation redacts the
/// bytes, and the type intentionally has no `Display` implementation
/// (protocol V24).
pub struct ConnectionKey(pub(crate) [u8; KEY_LEN]);

impl fmt::Debug for ConnectionKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ConnectionKey(<{KEY_LEN} bytes redacted>)")
    }
}

impl ConnectionKey {
    pub(crate) fn bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

/// Errors from the instance lifecycle. Variants carry paths and operation
/// names but never key bytes.
#[derive(Debug)]
pub enum InstanceError {
    UnsupportedPlatform,
    NoDataDir,
    Io {
        op: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    /// The runtime directory, lock, or publication failed a security check.
    Insecure {
        what: &'static str,
        path: PathBuf,
    },
    /// Another live host instance holds the lock.
    AlreadyRunning,
    Random,
}

impl fmt::Display for InstanceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedPlatform => write!(
                f,
                "mc-host only conforms on Unix numeric-IPv4-loopback profiles"
            ),
            Self::NoDataDir => write!(
                f,
                "no data directory: set XDG_DATA_HOME, HOME, or an explicit override"
            ),
            Self::Io { op, path, source } => {
                write!(f, "instance {op} failed for {}: {source}", path.display())
            }
            Self::Insecure { what, path } => write!(
                f,
                "refusing insecure {what} at {}: wrong type, owner, mode, or link count",
                path.display()
            ),
            Self::AlreadyRunning => write!(f, "another mc-host instance holds the lock"),
            Self::Random => write!(f, "OS CSPRNG failure while minting credentials"),
        }
    }
}

impl std::error::Error for InstanceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

pub(crate) fn io_err(op: &'static str, path: &Path, source: rustix::io::Errno) -> InstanceError {
    InstanceError::Io {
        op,
        path: path.to_path_buf(),
        source: io::Error::from(source),
    }
}

/// Resolves `${dataDir}/cortexkit/run`, where dataDir is the override, a
/// nonempty `$XDG_DATA_HOME`, or a nonempty `$HOME/.local/share`, in that
/// order.
pub fn runtime_dir_path(data_dir_override: Option<&Path>) -> Result<PathBuf, InstanceError> {
    let data_dir = match data_dir_override {
        Some(dir) => dir.to_path_buf(),
        None => match std::env::var_os("XDG_DATA_HOME") {
            Some(dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => match std::env::var_os("HOME") {
                Some(home) if !home.is_empty() => PathBuf::from(home).join(".local").join("share"),
                _ => return Err(InstanceError::NoDataDir),
            },
        },
    };
    Ok(data_dir.join("cortexkit").join("run"))
}

/// One secured host incarnation: validated directory descriptor, held lock,
/// fresh credentials, and (after `publish`) the retained publication identity.
///
/// Dropping the guard removes its own publication (best-effort, fenced) and
/// releases the lock; callers must keep it alive through handler drop
/// (protocol §12 step 8). The `Drop` cleanup covers abnormal exits — a
/// cancelled or aborted `run` future must not leave a stale connection file
/// advertising a listener that no longer exists.
pub struct InstanceGuard {
    dir: OwnedFd,
    dir_path: PathBuf,
    key: ConnectionKey,
    daemon_id: [u8; DAEMON_ID_LEN],
    launch_id: [u8; 16],
    publication: Option<PublicationIdentity>,
}

/// Identity retained at publish time for the best-effort check that the
/// canonical file still names our publication before cleanup unlinks it
/// (protocol §4.2, V7).
struct PublicationIdentity {
    dev: u64,
    ino: u64,
}

impl fmt::Debug for InstanceGuard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Key bytes stay out by construction; only the directory is named.
        f.debug_struct("InstanceGuard")
            .field("dir", &self.dir_path)
            .finish_non_exhaustive()
    }
}

impl InstanceGuard {
    /// Secures the runtime directory, acquires the single-instance lock, and
    /// mints fresh credentials — in that order, so credentials never exist for
    /// an incarnation that lost the lock race (protocol §8.1).
    pub fn acquire(data_dir_override: Option<&Path>) -> Result<Self, InstanceError> {
        if !cfg!(unix) {
            return Err(InstanceError::UnsupportedPlatform);
        }
        let dir_path = runtime_dir_path(data_dir_override)?;
        let dir = secure_runtime_dir(&dir_path)?;
        lock_instance(&dir, &dir_path)?;

        let mut key = [0u8; KEY_LEN];
        getrandom::getrandom(&mut key).map_err(|_| InstanceError::Random)?;
        let mut daemon_id = [0u8; DAEMON_ID_LEN];
        getrandom::getrandom(&mut daemon_id).map_err(|_| InstanceError::Random)?;
        let mut launch_id = [0u8; 16];
        getrandom::getrandom(&mut launch_id).map_err(|_| InstanceError::Random)?;

        Ok(Self {
            dir,
            dir_path,
            key: ConnectionKey(key),
            daemon_id,
            launch_id,
            publication: None,
        })
    }

    pub fn key(&self) -> &ConnectionKey {
        &self.key
    }

    pub fn daemon_id(&self) -> &[u8; DAEMON_ID_LEN] {
        &self.daemon_id
    }

    pub fn launch_id(&self) -> &[u8; 16] {
        &self.launch_id
    }

    pub(crate) fn dir(&self) -> &OwnedFd {
        &self.dir
    }

    pub(crate) fn dir_path(&self) -> &Path {
        &self.dir_path
    }

    /// Atomically publishes the schema-1 connection file for this incarnation
    /// (protocol §4.1, §4.2). The owner-only `O_EXCL` temp file and the rename
    /// over the canonical name both stay relative to the pinned directory
    /// descriptor, so the swap cannot cross filesystems or follow links.
    pub fn publish(&mut self, port: u16, daemon_ver: &str) -> Result<(), InstanceError> {
        sweep_stale_temps(&self.dir, &self.dir_path);

        let info = ConnectionInfo {
            schema: SCHEMA_VERSION,
            wire_version: Some(subc_protocol::PROTOCOL_VERSION),
            endpoints: vec![Endpoint {
                host: "127.0.0.1".to_owned(),
                port,
            }],
            key: self.key.0.to_vec(),
            daemon_id: self.daemon_id,
            pid: std::process::id(),
            daemon_ver: daemon_ver.to_owned(),
        };
        let json =
            serde_json::to_vec_pretty(&info).expect("connection info serialization cannot fail");

        let stat = write_atomic_owner_only(&self.dir, &self.dir_path, CONNECTION_FILE_NAME, &json)?;
        // `Stat` field types vary by platform (macOS `st_dev` is `i32`); the
        // casts are no-ops on Linux but load-bearing elsewhere.
        #[allow(clippy::unnecessary_cast)]
        let identity = PublicationIdentity {
            dev: stat.st_dev as u64,
            ino: stat.st_ino as u64,
        };
        self.publication = Some(identity);
        Ok(())
    }

    /// Best-effort identity fencing before removing the canonical publication:
    /// no-follow open, secure regular file, matching retained (dev, ino), and
    /// matching daemon ID (protocol §4.2, V7). A mismatch leaves the path
    /// alone. Verification and pathname unlink are separate operations, so
    /// replacement between the final check and unlink cannot be excluded.
    pub fn remove_publication(&mut self) {
        let Some(identity) = self.publication.take() else {
            return;
        };
        // Transient failures (EMFILE while connection descriptors are live)
        // must not consume the identity: `Drop` retries after those
        // descriptors close, or the file would keep advertising a dead
        // endpoint and its bearer key. Only success or a definitive identity
        // mismatch clears it.
        let Ok(fd) = openat(
            &self.dir,
            CONNECTION_FILE_NAME,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) else {
            self.publication = Some(identity);
            return;
        };
        let Ok(stat) = rustix::fs::fstat(&fd) else {
            self.publication = Some(identity);
            return;
        };
        if !is_secure_regular(&stat) {
            return;
        }
        // `Stat` field types vary by platform (macOS `st_dev` is `i32`); the
        // casts are no-ops on Linux but load-bearing elsewhere.
        #[allow(clippy::unnecessary_cast)]
        if stat.st_dev as u64 != identity.dev || stat.st_ino as u64 != identity.ino {
            return;
        }
        let Ok(bytes) = read_all_fd(&fd, 65_536) else {
            // Transient read failure: keep the identity for the Drop retry.
            self.publication = Some(identity);
            return;
        };
        let Ok(info) = serde_json::from_slice::<ConnectionInfo>(&bytes) else {
            return;
        };
        if info.daemon_id != self.daemon_id {
            return;
        }
        // A transient unlink failure must leave the identity retained so
        // `Drop` retries; otherwise the dead endpoint and its bearer key stay
        // published.
        if unlinkat(&self.dir, CONNECTION_FILE_NAME, AtFlags::empty()).is_err() {
            self.publication = Some(identity);
        }
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        // Idempotent: the graceful path already removed the publication and
        // took the retained identity, making this a no-op. The same
        // best-effort identity checks run before unlink on the drop path.
        self.remove_publication();
        self.remove_lifecycle_record();
    }
}

/// Traverses and validates the runtime path without following symlinks,
/// normalizing newly created components to 0700. Returns a pinned descriptor
/// for the final directory after validating its ownership and mode.
pub(crate) fn secure_runtime_dir(dir_path: &Path) -> Result<OwnedFd, InstanceError> {
    let flags = OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::RDONLY | OFlags::CLOEXEC;
    let mut current = openat(
        CWD,
        if dir_path.is_absolute() { "/" } else { "." },
        flags,
        Mode::empty(),
    )
    .map_err(|e| io_err("open_anchor", dir_path, e))?;
    // The anchor is part of the resolved path: for a relative root it is the
    // process working directory, which another principal may control and
    // could use to replace an otherwise secure first component.
    let anchor_stat =
        rustix::fs::fstat(&current).map_err(|e| io_err("fstat_anchor", dir_path, e))?;
    if !is_safe_ancestor(&anchor_stat) {
        return Err(InstanceError::Insecure {
            what: "runtime directory ancestor",
            path: dir_path.to_path_buf(),
        });
    }
    let mut walked = if dir_path.is_absolute() {
        PathBuf::from("/")
    } else {
        PathBuf::new()
    };
    // Collected first so the traversal knows which component is final: every
    // INTERMEDIATE must already be replacement-proof (we must not chmod
    // directories we do not own, such as /tmp or $HOME), while the final
    // directory is validated and then tightened to 0700 through its pinned
    // descriptor below.
    let mut names = Vec::new();
    for component in dir_path.components() {
        match component {
            Component::RootDir | Component::CurDir => continue,
            Component::Normal(name) => names.push(name),
            Component::ParentDir | Component::Prefix(_) => {
                return Err(InstanceError::Insecure {
                    what: "runtime directory path",
                    path: dir_path.to_path_buf(),
                });
            }
        }
    }
    let saw_component = !names.is_empty();

    let last = names.len().saturating_sub(1);
    for (index, name) in names.into_iter().enumerate() {
        walked.push(name);
        let next = match openat(&current, name, flags, Mode::empty()) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => {
                let created = match mkdirat(&current, name, Mode::from_raw_mode(0o700)) {
                    Ok(()) => true,
                    Err(rustix::io::Errno::EXIST) => false,
                    Err(e) => return Err(io_err("mkdir_component", &walked, e)),
                };
                // mkdir modes are filtered by umask. Restore owner access
                // before reopening a component that a restrictive umask may
                // have created as 0000; the subsequent no-follow open and
                // descriptor chmod validate and pin the actual directory.
                if created {
                    rustix::fs::chmodat(
                        &current,
                        name,
                        Mode::from_raw_mode(0o700),
                        AtFlags::empty(),
                    )
                    .map_err(|e| io_err("chmod_component", &walked, e))?;
                }
                let fd = openat(&current, name, flags, Mode::empty())
                    .map_err(|e| io_err("open_component", &walked, e))?;
                if created {
                    rustix::fs::fchmod(&fd, Mode::from_raw_mode(0o700))
                        .map_err(|e| io_err("fchmod_component", &walked, e))?;
                }
                fd
            }
            Err(e) => return Err(io_err("open_component", &walked, e)),
        };
        // Intermediates must be replacement-proof: a principal who can rename
        // or swap one can redirect the pathname to a tree of their choosing
        // after we pin ours, so clients and successors would resolve their
        // publication and lock inode while this host keeps using the hidden
        // original (protocol §4.1 threat model). The final component is
        // validated and tightened after the loop instead — we own it, so it
        // can be repaired rather than rejected.
        if index != last {
            let next_stat =
                rustix::fs::fstat(&next).map_err(|e| io_err("fstat_component", &walked, e))?;
            if !is_safe_ancestor(&next_stat) {
                return Err(InstanceError::Insecure {
                    what: "runtime directory ancestor",
                    path: walked.clone(),
                });
            }
        }
        current = next;
    }
    if !saw_component {
        return Err(InstanceError::Insecure {
            what: "runtime directory path",
            path: dir_path.to_path_buf(),
        });
    }

    let stat = rustix::fs::fstat(&current).map_err(|e| io_err("fstat_dir", dir_path, e))?;
    let is_dir = (stat.st_mode & S_IFMT) == S_IFDIR;
    let owner_ok = stat.st_uid == rustix::process::geteuid().as_raw();
    if !is_dir || !owner_ok {
        return Err(InstanceError::Insecure {
            what: "runtime directory",
            path: dir_path.to_path_buf(),
        });
    }
    rustix::fs::fchmod(&current, Mode::from_raw_mode(0o700))
        .map_err(|e| io_err("chmod_dir", dir_path, e))?;
    Ok(current)
}

/// Atomically installs `bytes` at `name` inside the pinned `dir` descriptor:
/// unique owner-only `O_EXCL` temp, exact-mode `fchmod`, full write, fsync,
/// then rename over the canonical name. Failure removes only this attempt's
/// temp file; a predecessor's or successor's canonical file is untouched.
/// Returns the installed file's stat, taken through the still-open temp
/// descriptor before the rename.
pub(crate) fn write_atomic_owner_only(
    dir: &OwnedFd,
    dir_path: &Path,
    name: &str,
    bytes: &[u8],
) -> Result<rustix::fs::Stat, InstanceError> {
    let mut suffix = [0u8; 16];
    getrandom::getrandom(&mut suffix).map_err(|_| InstanceError::Random)?;
    let temp_name = format!(".{name}.{}.{}.tmp", std::process::id(), hex(&suffix));
    // Errors carry the full path so a failure names which runtime directory
    // it happened in; the syscalls themselves stay anchored to `dir`.
    let temp_path = dir_path.join(&temp_name);

    let fd = openat(
        dir,
        temp_name.as_str(),
        OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )
    .map_err(|e| io_err("create_temp", &temp_path, e))?;

    let result = (|| -> Result<rustix::fs::Stat, InstanceError> {
        // The create mode is filtered by the process umask (a 0o777-style
        // umask can strip owner bits and leave the file 0o000); force the
        // exact owner-only mode so the installed bytes stay readable by the
        // owning principal and fenced cleanup can reopen the file.
        rustix::fs::fchmod(&fd, Mode::from_raw_mode(0o600))
            .map_err(|e| io_err("chmod_temp", &temp_path, e))?;
        write_all_fd(&fd, bytes).map_err(|source| InstanceError::Io {
            op: "write_temp",
            path: temp_path.clone(),
            source,
        })?;
        fsync(&fd).map_err(|e| io_err("fsync_temp", &temp_path, e))?;
        let stat = rustix::fs::fstat(&fd).map_err(|e| io_err("fstat_temp", &temp_path, e))?;
        renameat(dir, temp_name.as_str(), dir, name)
            .map_err(|e| io_err("rename", &temp_path, e))?;
        Ok(stat)
    })();

    if result.is_err() {
        let _ = unlinkat(dir, temp_name.as_str(), AtFlags::empty());
    }
    result
}

/// Takes the nonblocking exclusive advisory lock that makes this process the
/// single host for `dir`.
///
/// One attempt, no waiting: contention is reported as `AlreadyRunning` so the
/// caller decides how to wait. `run` retries on its own async timer rather
/// than sleeping an executor thread; synchronous callers use
/// [`flock_exclusive_bounded`].
///
/// The lock is held on the runtime-directory descriptor itself. Every instance
/// that serves this runtime directory must resolve this same inode to reach
/// the shared publication, so all of them contend for one lock. A lock file
/// addressed by name does not have that property: renaming it away lets the
/// next instance create a fresh inode under the same name and lock that one
/// instead, so both processes believe they hold it and publish over each
/// other. `lock_ownership_survives_renaming_the_runtime_dir` pins the
/// difference.
/// commentlint: allow(JUDGE)
fn lock_instance(dir: &OwnedFd, dir_path: &Path) -> Result<(), InstanceError> {
    match flock(dir, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => Ok(()),
        // WOULDBLOCK and AGAIN are one errno on Linux.
        Err(rustix::io::Errno::WOULDBLOCK) => Err(InstanceError::AlreadyRunning),
        Err(e) => Err(io_err("flock", dir_path, e)),
    }
}

/// How long a caller should tolerate transient exclusive-lock contention.
///
/// An observer holds a lifecycle lock only long enough to read it — a probe
/// tests instance-lock freedom with a shared lock, and holds the
/// lifecycle-root lock shared for one sample — but shared still blocks
/// exclusive, so an unlucky mutator can collide with one. Retrying briefly
/// keeps that from being reported as a live holder. These are the single
/// definition of that policy: [`flock_exclusive_bounded`] applies them
/// synchronously, and `run` applies them on an async timer.
pub(crate) const LOCK_RETRY_ATTEMPTS: u32 = 4;
pub(crate) const LOCK_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(25);

/// Takes a nonblocking exclusive advisory lock, tolerating the brief hold a
/// concurrent observer may take, per [`LOCK_RETRY_ATTEMPTS`]. A real holder
/// still yields `AlreadyRunning` after the last attempt.
///
/// Blocking: the retry sleeps the calling thread, so this is for synchronous
/// callers only. Async callers must not park an executor thread here.
pub(crate) fn flock_exclusive_bounded(
    dir: &OwnedFd,
    dir_path: &Path,
    op: &'static str,
) -> Result<(), InstanceError> {
    for attempt in 0..LOCK_RETRY_ATTEMPTS {
        match flock(dir, FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => return Ok(()),
            // WOULDBLOCK and AGAIN are one errno on Linux.
            Err(rustix::io::Errno::WOULDBLOCK) => {
                if attempt + 1 < LOCK_RETRY_ATTEMPTS {
                    std::thread::sleep(LOCK_RETRY_DELAY);
                }
            }
            Err(e) => return Err(io_err(op, dir_path, e)),
        }
    }
    // Every attempt observed the lock held.
    Err(InstanceError::AlreadyRunning)
}

pub(crate) const S_IFMT: u32 = 0o170000;
const S_ISVTX: u32 = 0o1000;
pub(crate) const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;

/// A directory no other principal can replace: owned by us or by root, and
/// not group/other-writable unless sticky (a sticky directory forbids
/// renaming entries you do not own, which is what `/tmp` relies on).
pub(crate) fn is_safe_ancestor(stat: &rustix::fs::Stat) -> bool {
    if (stat.st_mode & S_IFMT) != S_IFDIR {
        return false;
    }
    let ours = rustix::process::geteuid().as_raw();
    if stat.st_uid != ours && stat.st_uid != 0 {
        return false;
    }
    stat.st_mode & 0o022 == 0 || stat.st_mode & S_ISVTX != 0
}

/// Regular file, single hard link, owned by us, no group/other bits.
pub(crate) fn is_secure_regular(stat: &rustix::fs::Stat) -> bool {
    (stat.st_mode & S_IFMT) == S_IFREG
        && stat.st_nlink == 1
        && stat.st_uid == rustix::process::geteuid().as_raw()
        && stat.st_mode & 0o077 == 0
}

/// Best-effort removal of stale temp pathnames left by `write_atomic_owner_only`.
/// Candidates and metadata come from a path-based directory iterator with
/// metadata fetched per entry, while deletion is descriptor-relative; the
/// metadata check and unlink are not atomic. Age is the sole predicate,
/// failures do not prevent publication (protocol §4.2). The scan examines at
/// most 1024 successfully read entries.
///
/// Every canonical name written through that helper must be listed here. The
/// lifecycle record is rewritten several times per incarnation, so omitting it
/// would leak a temp file per crashed write with nothing to reclaim it.
fn sweep_stale_temps(dir: &OwnedFd, dir_path: &Path) {
    const MAX_SWEEP_ENTRIES: usize = 1024;
    let prefixes = [
        format!(".{CONNECTION_FILE_NAME}."),
        format!(".{}.", crate::lifecycle::LIFECYCLE_RECORD_NAME),
    ];
    let Ok(entries) = std::fs::read_dir(dir_path) else {
        return;
    };
    for entry in entries.flatten().take(MAX_SWEEP_ENTRIES) {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let matches_temp = name.ends_with(".tmp")
            && prefixes
                .iter()
                .any(|prefix| name.starts_with(prefix.as_str()));
        if !matches_temp {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .map(|modified| {
                SystemTime::now()
                    .duration_since(modified)
                    .is_ok_and(|age| age >= STALE_TEMP_AFTER)
            })
            .unwrap_or(false);
        if stale {
            let _ = unlinkat(dir, name, AtFlags::empty());
        }
    }
}

pub(crate) fn write_all_fd(fd: &OwnedFd, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        let written = rustix::io::write(fd, bytes).map_err(io::Error::from)?;
        if written == 0 {
            return Err(io::Error::new(io::ErrorKind::WriteZero, "write returned 0"));
        }
        bytes = &bytes[written..];
    }
    Ok(())
}

pub(crate) fn read_all_fd(fd: &OwnedFd, cap: usize) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let read = rustix::io::read(fd, &mut buf).map_err(io::Error::from)?;
        if read == 0 {
            return Ok(out);
        }
        out.extend_from_slice(&buf[..read]);
        if out.len() > cap {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "file too large"));
        }
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

    /// `runtime_dir_path` reads process-global environment, so the tests that
    /// mutate it cannot run concurrently with each other.
    static ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn temp_root() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp data root")
    }

    fn mode_of(path: &Path) -> u32 {
        std::fs::symlink_metadata(path)
            .expect("stat")
            .permissions()
            .mode()
            & 0o7777
    }

    fn published(guard: &InstanceGuard) -> PathBuf {
        guard.dir_path().join(CONNECTION_FILE_NAME)
    }

    #[test]
    fn explicit_override_resolves_canonical_layout() {
        let root = temp_root();
        let dir = runtime_dir_path(Some(root.path())).expect("resolve");
        assert_eq!(dir, root.path().join("cortexkit").join("run"));
    }

    #[test]
    fn default_root_follows_xdg_then_home() {
        let _serial = ENV_GUARD.lock().expect("env guard");
        let saved_xdg = std::env::var_os("XDG_DATA_HOME");
        let saved_home = std::env::var_os("HOME");

        std::env::set_var("XDG_DATA_HOME", "/xdg-root");
        assert_eq!(
            runtime_dir_path(None).expect("xdg"),
            PathBuf::from("/xdg-root/cortexkit/run")
        );

        std::env::remove_var("XDG_DATA_HOME");
        std::env::set_var("HOME", "/home-root");
        assert_eq!(
            runtime_dir_path(None).expect("home"),
            PathBuf::from("/home-root/.local/share/cortexkit/run")
        );

        std::env::remove_var("HOME");
        assert!(matches!(
            runtime_dir_path(None),
            Err(InstanceError::NoDataDir)
        ));

        match saved_xdg {
            Some(value) => std::env::set_var("XDG_DATA_HOME", value),
            None => std::env::remove_var("XDG_DATA_HOME"),
        }
        match saved_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn permissive_umask_still_yields_owner_only_dir_and_file() {
        let root = temp_root();
        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        guard.publish(43123, "mc-host/test").expect("publish");

        assert_eq!(mode_of(guard.dir_path()), 0o700);
        let file = published(&guard);
        assert_eq!(mode_of(&file), 0o600);
        let meta = std::fs::symlink_metadata(&file).expect("stat file");
        assert!(meta.file_type().is_file());
        assert_eq!(meta.uid(), rustix::process::geteuid().as_raw());
    }

    #[test]
    fn world_writable_intermediate_is_rejected() {
        let root = temp_root();
        // An intermediate another principal could rename cannot be repaired
        // by us the way the final directory can, so acquisition must refuse
        // rather than pin a tree whose pathname can be redirected.
        let loose = root.path().join("loose");
        std::fs::create_dir_all(&loose).expect("create intermediate");
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o777))
            .expect("loosen intermediate");

        let err = InstanceGuard::acquire(Some(&loose)).expect_err("must refuse");
        assert!(
            matches!(
                err,
                InstanceError::Insecure {
                    what: "runtime directory ancestor",
                    ..
                }
            ),
            "unexpected error: {err:?}"
        );
    }

    #[test]
    fn pre_existing_permissive_dir_is_tightened() {
        let root = temp_root();
        let dir = runtime_dir_path(Some(root.path())).expect("resolve");
        std::fs::create_dir_all(&dir).expect("create dir");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).expect("loosen dir");

        let guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        assert_eq!(mode_of(guard.dir_path()), 0o700);
    }

    #[test]
    fn publication_matches_schema_1_shape() {
        let root = temp_root();
        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        guard.publish(43123, "mc-host/test").expect("publish");

        let bytes = std::fs::read(published(&guard)).expect("read publication");
        let json: serde_json::Value = serde_json::from_slice(&bytes).expect("parse");
        assert_eq!(json["schema"], 1);
        assert_eq!(json["wire_version"], 2);
        assert_eq!(json["endpoints"].as_array().expect("endpoints").len(), 1);
        assert_eq!(json["endpoints"][0]["host"], "127.0.0.1");
        assert_eq!(json["endpoints"][0]["port"], 43123);
        assert_eq!(json["key"].as_array().expect("key").len(), 32);
        assert_eq!(json["daemon_id"].as_array().expect("daemon_id").len(), 16);
        assert_eq!(json["pid"], std::process::id());
        assert_eq!(json["daemon_ver"], "mc-host/test");
    }

    #[test]
    fn second_instance_fails_before_touching_the_first_publication() {
        let root = temp_root();
        let mut first = InstanceGuard::acquire(Some(root.path())).expect("first acquire");
        first.publish(1111, "mc-host/first").expect("publish");
        let before = std::fs::read(published(&first)).expect("read first");

        let err = InstanceGuard::acquire(Some(root.path())).expect_err("second must fail");
        assert!(matches!(err, InstanceError::AlreadyRunning));

        let after = std::fs::read(published(&first)).expect("read first again");
        assert_eq!(before, after, "loser must not disturb the holder's file");
    }

    #[test]
    fn lock_ownership_survives_renaming_the_runtime_dir() {
        let root = temp_root();
        let mut first = InstanceGuard::acquire(Some(root.path())).expect("first acquire");
        first.publish(1111, "mc-host/first").expect("publish");
        let before = std::fs::read(published(&first)).expect("read first");

        let moved = root.path().join("cortexkit").join("run-moved");
        std::fs::rename(first.dir_path(), &moved).expect("rename runtime dir");

        // Ownership belongs to the locked inode, not to the pathname: the
        // renamed directory is still locked by the holder.
        let reopened = openat(
            CWD,
            &moved,
            OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::RDONLY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .expect("reopen moved dir");
        assert!(
            matches!(
                flock(&reopened, FlockOperation::NonBlockingLockExclusive),
                Err(rustix::io::Errno::WOULDBLOCK)
            ),
            "the holder must still own the renamed directory's lock"
        );

        // A successor anchors to a different inode, so it cannot reach or
        // overwrite the holder's publication.
        let mut second = InstanceGuard::acquire(Some(root.path())).expect("successor acquires");
        second
            .publish(2222, "mc-host/second")
            .expect("successor publishes");
        assert_ne!(second.dir_path(), moved.as_path());
        assert_eq!(
            std::fs::read(moved.join(CONNECTION_FILE_NAME)).expect("read moved"),
            before,
            "the holder's publication must be untouched"
        );

        // The open directory handle lets `first` remove its publication after
        // the rename.
        first.remove_publication();
        assert!(!moved.join(CONNECTION_FILE_NAME).exists());
    }

    #[test]
    fn symlinked_runtime_dir_fails_closed() {
        let root = temp_root();
        let elsewhere = temp_root();
        let dir = runtime_dir_path(Some(root.path())).expect("resolve");
        std::fs::create_dir_all(dir.parent().expect("parent")).expect("create parents");
        symlink(elsewhere.path(), &dir).expect("symlink runtime dir");

        assert!(InstanceGuard::acquire(Some(root.path())).is_err());
    }

    #[test]
    fn symlinked_runtime_ancestor_fails_closed() {
        let root = temp_root();
        let elsewhere = temp_root();
        symlink(elsewhere.path(), root.path().join("cortexkit")).expect("symlink runtime ancestor");

        assert!(InstanceGuard::acquire(Some(root.path())).is_err());
        assert!(
            !elsewhere.path().join("run").exists(),
            "the symlink target must not receive host files"
        );
    }

    #[test]
    fn nonregular_publication_target_is_replaced_not_followed() {
        let root = temp_root();
        let dir = runtime_dir_path(Some(root.path())).expect("resolve");
        std::fs::create_dir_all(&dir).expect("create dir");
        // A directory sitting at the publication name cannot be renamed over,
        // so publication must fail closed rather than clobber it.
        std::fs::create_dir(dir.join(CONNECTION_FILE_NAME)).expect("plant directory");

        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        assert!(guard.publish(4321, "mc-host/test").is_err());
        assert!(
            std::fs::symlink_metadata(dir.join(CONNECTION_FILE_NAME))
                .expect("stat")
                .is_dir(),
            "the planted entry must be left alone"
        );
    }

    #[test]
    fn publication_replaces_a_planted_symlink_without_following_it() {
        let root = temp_root();
        let outside = temp_root();
        let victim = outside.path().join("victim");
        std::fs::write(&victim, b"untouched").expect("write victim");

        let dir = runtime_dir_path(Some(root.path())).expect("resolve");
        std::fs::create_dir_all(&dir).expect("create dir");
        symlink(&victim, dir.join(CONNECTION_FILE_NAME)).expect("plant symlink");

        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        guard.publish(2222, "mc-host/test").expect("publish");

        // rename(2) replaces the link itself, so the outside target is intact.
        assert_eq!(
            std::fs::read(&victim).expect("read victim"),
            b"untouched".to_vec()
        );
        let meta = std::fs::symlink_metadata(published(&guard)).expect("stat");
        assert!(
            meta.file_type().is_file(),
            "publication must be a real file"
        );
    }

    #[test]
    fn cleanup_removes_only_our_own_publication() {
        let root = temp_root();
        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        guard.publish(3333, "mc-host/test").expect("publish");
        let file = published(&guard);
        assert!(file.exists());
        guard.remove_publication();
        assert!(!file.exists(), "our own publication must be removed");
    }

    #[test]
    fn replaced_inode_prevents_unlink() {
        let root = temp_root();
        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        guard.publish(4444, "mc-host/test").expect("publish");
        let file = published(&guard);

        // A successor publishes over the path: same name, different inode.
        let successor = guard.dir_path().join("successor.tmp");
        std::fs::write(&successor, b"{\"schema\":1}").expect("write successor");
        std::fs::set_permissions(&successor, std::fs::Permissions::from_mode(0o600)).expect("mode");
        std::fs::rename(&successor, &file).expect("replace inode");

        guard.remove_publication();
        assert!(file.exists(), "a successor's publication must survive");
    }

    #[test]
    fn mismatched_daemon_id_prevents_unlink() {
        let root = temp_root();
        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        guard.publish(5555, "mc-host/test").expect("publish");
        let file = published(&guard);

        // Same inode, rewritten daemon ID: an old incarnation must not delete
        // a credential it no longer owns.
        let bytes = std::fs::read(&file).expect("read");
        let mut json: serde_json::Value = serde_json::from_slice(&bytes).expect("parse");
        json["daemon_id"] = serde_json::json!(vec![0u8; DAEMON_ID_LEN]);
        let fd = openat(CWD, &file, OFlags::WRONLY | OFlags::TRUNC, Mode::empty())
            .expect("reopen in place");
        write_all_fd(&fd, &serde_json::to_vec(&json).expect("serialize")).expect("rewrite");
        drop(fd);

        guard.remove_publication();
        assert!(file.exists(), "daemon-ID mismatch must prevent unlink");
    }

    #[test]
    fn hard_linked_publication_prevents_unlink() {
        let root = temp_root();
        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        guard.publish(6666, "mc-host/test").expect("publish");
        let file = published(&guard);
        std::fs::hard_link(&file, guard.dir_path().join("extra-link")).expect("hard link");

        guard.remove_publication();
        assert!(
            file.exists(),
            "an unexpected second link means the file is not solely ours"
        );
    }

    #[test]
    fn publication_survives_and_replaces_across_republish() {
        let root = temp_root();
        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        guard.publish(7777, "mc-host/test").expect("first publish");
        let first: serde_json::Value =
            serde_json::from_slice(&std::fs::read(published(&guard)).expect("read"))
                .expect("parse");
        guard.publish(8888, "mc-host/test").expect("second publish");
        let second: serde_json::Value =
            serde_json::from_slice(&std::fs::read(published(&guard)).expect("read"))
                .expect("parse");

        assert_eq!(first["endpoints"][0]["port"], 7777);
        assert_eq!(second["endpoints"][0]["port"], 8888);
        // Credentials belong to the incarnation, not the publish call.
        assert_eq!(first["key"], second["key"]);
        guard.remove_publication();
        assert!(!published(&guard).exists());
    }

    #[test]
    fn stale_temps_are_swept_and_fresh_ones_spared() {
        let root = temp_root();
        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        let dir = guard.dir_path().to_path_buf();

        let stale = dir.join(format!(".{CONNECTION_FILE_NAME}.99999.deadbeef.tmp"));
        std::fs::write(&stale, b"stranded").expect("write stale");
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .expect("open stale")
            .set_modified(SystemTime::now() - Duration::from_secs(3600))
            .expect("backdate");

        let fresh = dir.join(format!(".{CONNECTION_FILE_NAME}.99998.feedface.tmp"));
        std::fs::write(&fresh, b"in flight").expect("write fresh");

        let unrelated = dir.join("unrelated.txt");
        std::fs::write(&unrelated, b"not ours").expect("write unrelated");
        std::fs::File::options()
            .write(true)
            .open(&unrelated)
            .expect("open unrelated")
            .set_modified(SystemTime::now() - Duration::from_secs(3600))
            .expect("backdate");

        guard.publish(9999, "mc-host/test").expect("publish");

        assert!(!stale.exists(), "a stale temp must be swept");
        assert!(fresh.exists(), "an in-flight temp must be spared");
        assert!(unrelated.exists(), "age alone must not condemn other files");
        assert!(published(&guard).exists(), "publication must still land");
    }

    #[test]
    fn no_temp_files_remain_after_a_successful_publish() {
        let root = temp_root();
        let mut guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        guard.publish(1234, "mc-host/test").expect("publish");

        let prefix = format!(".{CONNECTION_FILE_NAME}.");
        let leftovers: Vec<_> = std::fs::read_dir(guard.dir_path())
            .expect("read dir")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(&prefix) && name.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "secret-bearing temps must not survive: {leftovers:?}"
        );
    }

    #[test]
    fn diagnostics_never_render_key_bytes() {
        let root = temp_root();
        let guard = InstanceGuard::acquire(Some(root.path())).expect("acquire");

        assert_eq!(
            format!("{:?}", guard.key()),
            format!("ConnectionKey(<{KEY_LEN} bytes redacted>)")
        );

        let key_hex: String = guard
            .key()
            .bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let key_decimals = format!("{:?}", guard.key().bytes().to_vec());
        for rendered in [format!("{:?}", guard.key()), format!("{guard:?}")] {
            assert!(!rendered.contains(&key_hex), "{rendered}");
            assert!(!rendered.contains(&key_decimals), "{rendered}");
            // Any 8-byte window of the key would already be a disclosure.
            for window in key_hex.as_bytes().windows(16) {
                let window = std::str::from_utf8(window).expect("hex is ASCII");
                assert!(!rendered.contains(window), "{rendered} leaked {window}");
            }
        }
    }

    #[test]
    fn error_display_carries_paths_but_no_secrets() {
        let root = temp_root();
        let _holder = InstanceGuard::acquire(Some(root.path())).expect("acquire");
        let err = InstanceGuard::acquire(Some(root.path())).expect_err("second fails");
        let rendered = format!("{err}");
        assert!(rendered.contains("holds the lock"), "{rendered}");
        assert!(!rendered.contains("key"), "{rendered}");
    }
}
