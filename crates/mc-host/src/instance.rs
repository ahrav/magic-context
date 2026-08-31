//!
//! All mutations use one validated directory descriptor opened with `O_NOFOLLOW`.
//! Path-based operations remain inside the validated directory.
//! A concurrent path or symlink swap cannot redirect create, rename, or unlink outside the validated directory.

use std::fmt;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use rustix::fd::OwnedFd;
use rustix::fs::{
    flock, fsync, mkdirat, openat, renameat, unlinkat, AtFlags, FlockOperation, Mode, OFlags, CWD,
};

use crate::connection_file::{ConnectionInfo, Endpoint, DAEMON_ID_LEN, KEY_LEN, SCHEMA_VERSION};

/// `CONNECTION_FILE_NAME` names the canonical publication file inside the runtime directory.
pub const CONNECTION_FILE_NAME: &str = "subc-connection.json";

/// `STALE_TEMP_AFTER` removes abandoned publication files after 600 seconds.
/// (protocol §4.2).
const STALE_TEMP_AFTER: Duration = Duration::from_secs(600);

/// `ConnectionKey` redacts diagnostic output to prevent credential disclosure.
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

/// `InstanceError` never stores key bytes.
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
    /// The supplied payload-manifest digest must contain 64 lowercase hexadecimal characters.
    InvalidPayloadDigest,
    /// Unknown-schema lifecycle-state bytes are never interpreted, migrated, overwritten, or removed.
    UnsupportedStateSchema {
        path: PathBuf,
    },
    /// `NamespaceDrift` requires the holder to abort its named-namespace result when a retained descriptor no longer matches the identity resolved by its name.
    NamespaceDrift {
        path: PathBuf,
    },
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
            Self::InvalidPayloadDigest => write!(
                f,
                "payload-manifest digest must be {} lowercase hex characters",
                crate::lifecycle::PAYLOAD_MANIFEST_DIGEST_LEN
            ),
            Self::UnsupportedStateSchema { path } => write!(
                f,
                "refusing to touch an unknown lifecycle state schema at {}",
                path.display()
            ),
            Self::NamespaceDrift { path } => write!(
                f,
                "managed namespace identity drifted at {}",
                path.display()
            ),
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

///
/// The resolver ignores relative or empty `XDG_DATA_HOME` and `HOME` values to prevent cwd-dependent data roots.
/// lifecycle root.
///
/// a level.
pub fn data_dir_path(data_dir_override: Option<&Path>) -> Result<PathBuf, InstanceError> {
    fn absolute(value: std::ffi::OsString) -> Option<PathBuf> {
        let path = PathBuf::from(value);
        path.is_absolute().then_some(path)
    }
    match data_dir_override {
        Some(dir) => Ok(dir.to_path_buf()),
        None => match std::env::var_os("XDG_DATA_HOME").and_then(absolute) {
            Some(dir) => Ok(dir),
            None => match std::env::var_os("HOME").and_then(absolute) {
                Some(home) => Ok(home.join(".local").join("share")),
                None => Err(InstanceError::NoDataDir),
            },
        },
    }
}

/// The managed-subtree constant defines the only managed segment; every managed path derives from it so a rename cannot leave part of the tree behind.
pub const MANAGED_DIR_NAME: &str = "cortexkit";

/// The managed subtree at `${dataDir}/cortexkit` holds the runtime directory, lifecycle root, and module storage.
pub fn managed_dir_path(data_dir_override: Option<&Path>) -> Result<PathBuf, InstanceError> {
    Ok(data_dir_path(data_dir_override)?.join(MANAGED_DIR_NAME))
}

/// order.
pub fn runtime_dir_path(data_dir_override: Option<&Path>) -> Result<PathBuf, InstanceError> {
    Ok(managed_dir_path(data_dir_override)?.join("run"))
}

/// An `InstanceGuard` represents one secured host incarnation.
/// An `InstanceGuard` retains validated directory, lock, credentials, and publication identity after `publish`.
///
/// Dropping the guard best-effort removes its fenced publication.
/// Dropping the guard releases the lock; callers must retain it until handlers drop.
/// `Drop` best-effort removes this guard's publication when a `run` future is cancelled or aborted.
/// `Drop` best-effort removes this guard's publication when `run` is cancelled or aborted.
/// `Drop` best-effort removes the canonical file only when it still names this guard's publication.
pub struct InstanceGuard {
    dir: OwnedFd,
    dir_path: PathBuf,
    key: ConnectionKey,
    daemon_id: [u8; DAEMON_ID_LEN],
    launch_id: [u8; 16],
    payload_manifest_digest: String,
    publication: Option<PublicationIdentity>,
    /// Declare the stable incarnation fence after `dir` so `dir` closes before the fence.
    /// The lifetime fence outlives descriptor-relative cleanup.
    _lifetime: crate::lifecycle::LifetimeLock,
}

/// Cleanup checks that the canonical file still names this publication before unlinking it.
struct PublicationIdentity {
    dev: u64,
    ino: u64,
}

impl fmt::Debug for InstanceGuard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Errors name only the directory, never key bytes.
        f.debug_struct("InstanceGuard")
            .field("dir", &self.dir_path)
            .finish_non_exhaustive()
    }
}

impl InstanceGuard {
    /// Credentials are minted only after the runtime-directory lock is acquired, so a lost lock race cannot create credentials.
    /// The lifetime fence prevents managed-subtree replacement from admitting an overlapping incarnation while this guard lives.
    ///
    /// `payload_manifest_digest` must contain exactly 64 lowercase hexadecimal characters.
    /// `payload_manifest_digest` must contain exactly 64 lowercase hexadecimal characters.
    pub fn acquire(
        data_dir_override: Option<&Path>,
        payload_manifest_digest: &str,
    ) -> Result<Self, InstanceError> {
        if !cfg!(unix) {
            return Err(InstanceError::UnsupportedPlatform);
        }
        if !crate::lifecycle::is_canonical_payload_digest(payload_manifest_digest) {
            return Err(InstanceError::InvalidPayloadDigest);
        }
        // The lifetime fence survives replacement of the `cortexkit` subtree.
        // The lifetime fence is the authority that survives replacement of the `run` directory or the managed subtree.
        // The runtime-directory lock fences descriptor-relative publication and cleanup.
        let lifetime = crate::lifecycle::LifetimeLock::acquire(data_dir_override)?;
        let dir_path = runtime_dir_path(data_dir_override)?;
        let dir = secure_runtime_dir(&dir_path)?;
        lock_instance(&dir, &dir_path)?;
        // An unknown lifecycle schema at the record name blocks startup to prevent overwrite.
        if crate::lifecycle::quarantined_record_present(&dir, &dir_path)? {
            return Err(InstanceError::UnsupportedStateSchema {
                path: dir_path.join(crate::lifecycle::LIFECYCLE_RECORD_NAME),
            });
        }
        // Startup removes stale predecessor files left by incarnations that crashed before publication.
        sweep_stale_temps(&dir, &dir_path);

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
            payload_manifest_digest: payload_manifest_digest.to_owned(),
            publication: None,
            _lifetime: lifetime,
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

    pub(crate) fn payload_manifest_digest(&self) -> &str {
        &self.payload_manifest_digest
    }

    pub(crate) fn dir(&self) -> &OwnedFd {
        &self.dir
    }

    pub(crate) fn dir_path(&self) -> &Path {
        &self.dir_path
    }

    /// `publish` atomically publishes the schema-1 connection file for this incarnation.
    /// The owner-only `O_EXCL` temporary file and rename over the canonical name use the pinned directory descriptor.
    /// Using the pinned directory descriptor keeps the rename on one filesystem and prevents link traversal.
    pub fn publish(&mut self, port: u16, daemon_ver: &str) -> Result<(), InstanceError> {
        let info = ConnectionInfo {
            schema: SCHEMA_VERSION,
            wire_version: crate::wire::PROTOCOL_VERSION,
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
        // `Stat` field types vary by platform; macOS defines `st_dev` as `i32`, so the casts are required there and are no-ops on Linux.
        #[allow(clippy::unnecessary_cast)]
        let identity = PublicationIdentity {
            dev: stat.st_dev as u64,
            ino: stat.st_ino as u64,
        };
        self.publication = Some(identity);
        Ok(())
    }

    /// Cleanup verifies the canonical publication's retained identity before attempting removal.
    /// Cleanup requires a no-follow open of a secure regular file whose retained `(dev, ino)` matches.
    /// Cleanup also requires the daemon ID to match; a mismatch leaves the path unchanged.
    /// Cleanup cannot exclude replacement between the final identity check and unlink.
    pub fn remove_publication(&mut self) {
        let Some(identity) = self.publication.take() else {
            return;
        };
        // Transient failures must retain `identity` so `Drop` can retry.
        // Drop retries after connection descriptors close.
        // Only successful unlink or a definitive identity mismatch clears `self.publication`.
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
        // `Stat` field types vary by platform; macOS defines `st_dev` as `i32`.
        #[allow(clippy::unnecessary_cast)]
        if stat.st_dev as u64 != identity.dev || stat.st_ino as u64 != identity.ino {
            return;
        }
        let Ok(bytes) = read_all_fd(&fd, 65_536) else {
            // A transient read failure retains `identity` for `Drop` retry.
            self.publication = Some(identity);
            return;
        };
        let Ok(info) = serde_json::from_slice::<ConnectionInfo>(&bytes) else {
            return;
        };
        if info.daemon_id != self.daemon_id {
            return;
        }
        // A transient unlink failure retains `identity` so `Drop` can retry removal.
        // published.
        if unlinkat(&self.dir, CONNECTION_FILE_NAME, AtFlags::empty()).is_err() {
            self.publication = Some(identity);
        }
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        // best-effort identity checks run before unlink on the drop path.
        self.remove_publication();
        self.remove_lifecycle_record();
    }
}

/// `open_secure_dir_existing` traverses an existing managed directory path without following symlinks.
/// `Ok(None)` means a component is absent and the subtree does not yet exist.
/// `Err` means a component is insecure, unreadable, or does not belong to this instance.
///
/// Observational callers must distinguish absent components from insecure or unreadable components.
/// Mapping an insecure component to absence would report hostile persisted state as "nothing installed yet".
/// Resolving each component through the previous pinned descriptor prevents intermediate symlinks from redirecting traversal.
pub(crate) fn open_secure_dir_existing(dir_path: &Path) -> Result<Option<OwnedFd>, InstanceError> {
    let mut current = open_safe_anchor(dir_path)
        .map_err(|e| io_err("open_anchor", dir_path, e))?
        .ok_or_else(|| InstanceError::Insecure {
            what: "managed directory ancestor",
            path: dir_path.to_path_buf(),
        })?;
    let mut walked = if dir_path.is_absolute() {
        PathBuf::from("/")
    } else {
        PathBuf::new()
    };
    let names = normal_components(dir_path).ok_or_else(|| InstanceError::Insecure {
        what: "managed directory path",
        path: dir_path.to_path_buf(),
    })?;
    if names.is_empty() {
        return Err(InstanceError::Insecure {
            what: "managed directory path",
            path: dir_path.to_path_buf(),
        });
    }
    let last = names.len() - 1;
    for (index, name) in names.into_iter().enumerate() {
        walked.push(name);
        let next = match openat(&current, name, HARDENED_DIR_FLAGS, Mode::empty()) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(e) => return Err(io_err("open_component", &walked, e)),
        };
        // Traversal must not resolve later components through a replaceable pathname.
        // A principal that can rename or swap an intermediate component can redirect later pathname resolution.
        // The caller validates the final component.
        if index != last {
            let stat =
                rustix::fs::fstat(&next).map_err(|e| io_err("fstat_component", &walked, e))?;
            if !is_safe_ancestor(&stat) {
                return Err(InstanceError::Insecure {
                    what: "managed directory ancestor",
                    path: walked.clone(),
                });
            }
        }
        current = next;
    }
    Ok(Some(current))
}

/// `secure_runtime_dir` traverses and validates `dir_path` without following symlinks.
/// `secure_runtime_dir` normalizes newly created components to mode 0700.
/// `secure_runtime_dir` returns a pinned descriptor for the final directory after validating its ownership and mode.
pub(crate) fn secure_runtime_dir(dir_path: &Path) -> Result<OwnedFd, InstanceError> {
    let flags = HARDENED_DIR_FLAGS;
    let mut current = open_safe_anchor(dir_path)
        .map_err(|e| io_err("open_anchor", dir_path, e))?
        .ok_or_else(|| InstanceError::Insecure {
            what: "runtime directory ancestor",
            path: dir_path.to_path_buf(),
        })?;
    let mut walked = if dir_path.is_absolute() {
        PathBuf::from("/")
    } else {
        PathBuf::new()
    };
    // `secure_runtime_dir` must not chmod ancestor directories such as `/tmp` or `$HOME`.
    // `secure_runtime_dir` validates and tightens the final directory to mode 0700 through its pinned descriptor.
    // descriptor below.
    let names = normal_components(dir_path).ok_or_else(|| InstanceError::Insecure {
        what: "runtime directory path",
        path: dir_path.to_path_buf(),
    })?;
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
                // umask filters `mkdirat` modes; `chmodat` restores owner access before reopening.
                // The traversal restores owner access before reopening a component created with mode 0000 by a restrictive umask.
                // The subsequent no-follow open pins the reopened directory.
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
        // Replacing an intermediate component can make clients and successors resolve different inodes.
        // The final component is validated and tightened after the loop because ownership validation permits repair.
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
    let mode = mode_bits(&stat);
    let is_dir = (mode & S_IFMT) == S_IFDIR;
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

/// The function atomically installs `bytes` at `name` through the pinned `dir` descriptor.
/// Rename publishes only a fully written and synced file.
/// On failure, cleanup removes only this attempt's temp file; canonical files remain untouched.
pub(crate) fn write_atomic_owner_only(
    dir: &OwnedFd,
    dir_path: &Path,
    name: &str,
    bytes: &[u8],
) -> Result<rustix::fs::Stat, InstanceError> {
    // The stale-temp sweep reclaims temp files from crashed writes for this name.
    // `ATOMIC_WRITE_NAMES` must include every `name` used here so stale-temp sweeping reclaims crashed writes.
    debug_assert!(
        ATOMIC_WRITE_NAMES.contains(&name),
        "{name} is not registered in ATOMIC_WRITE_NAMES; its crashed temps would never be swept"
    );
    let mut suffix = [0u8; 16];
    getrandom::getrandom(&mut suffix).map_err(|_| InstanceError::Random)?;
    let temp_name = format!(".{name}.{}.{}.tmp", std::process::id(), hex(&suffix));
    // Directory-relative operations remain anchored to `dir`.
    let temp_path = dir_path.join(&temp_name);

    let fd = openat(
        dir,
        temp_name.as_str(),
        OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )
    .map_err(|e| io_err("create_temp", &temp_path, e))?;

    let result = (|| -> Result<rustix::fs::Stat, InstanceError> {
        // umask can reduce the requested `0o600` mode to `0o000`; `fchmod` restores `0o600`.
        // Under Unix mode-bit checks, `0o600` grants read access only to the file owner.
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

/// The nonblocking exclusive advisory lock makes this process the publication owner for `dir`.
///
/// `run` retries on an async timer; synchronous callers use `flock_exclusive_bounded`.
/// [`flock_exclusive_bounded`].
///
/// The lock on `dir` fences only descriptor-relative publication and evidence cleanup.
/// Replacing the runtime directory can bypass this lock and allow overlap.
/// Renaming `run` or `cortexkit` away lets a successor lock a new inode at the same path.
/// `crate::lifecycle::LifetimeLock` fences coordination-aware processes against directory-replacement overlap.
/// `crate::lifecycle::LifetimeLock` is acquired before this lock on `.mc-host-coordination`.
/// The lifetime fence works only between coordination-aware releases.
/// A release without the lifetime fence can overlap after directory replacement.
/// Do not run a release without the lifetime fence while another release may hold the coordination lock.
/// Renaming `.mc-host-coordination` externally splits the lifetime fence.
/// `.mc-host-coordination` must not be renamed externally.
fn lock_instance(dir: &OwnedFd, dir_path: &Path) -> Result<(), InstanceError> {
    match flock(dir, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => Ok(()),
        // WOULDBLOCK and AGAIN are one errno on Linux.
        Err(rustix::io::Errno::WOULDBLOCK) => Err(InstanceError::AlreadyRunning),
        Err(e) => Err(io_err("flock", dir_path, e)),
    }
}

/// Callers should tolerate exclusive-lock contention until the bounded lock timeout expires.
///
/// An observer holds the lifecycle lock only while reading it.
/// A probe tests instance-lock freedom with a shared lock.
/// A probe holds the coordination transaction lock shared for one sample; that shared lock blocks exclusive acquisition.
/// A mutator's exclusive lock acquisition can contend with a probe's shared lock.
/// Brief retries prevent probe contention from being reported as a live holder.
pub(crate) const LOCK_RETRY_ATTEMPTS: u32 = 4;
pub(crate) const LOCK_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(25);

/// `Ok(true)` means the lock was acquired; `Ok(false)` means every attempt returned `WOULDBLOCK`.
/// The caller defines the consequence of exhausted retries.
/// evidence-only).
///
/// `flock_bounded` sleeps the calling thread between retries; async callers must not use it.
pub(crate) fn flock_bounded(
    dir: &OwnedFd,
    dir_path: &Path,
    op: &'static str,
    operation: FlockOperation,
) -> Result<bool, InstanceError> {
    for attempt in 0..LOCK_RETRY_ATTEMPTS {
        match flock(dir, operation) {
            Ok(()) => return Ok(true),
            // WOULDBLOCK and AGAIN are one errno on Linux.
            Err(rustix::io::Errno::WOULDBLOCK) => {
                if attempt + 1 < LOCK_RETRY_ATTEMPTS {
                    std::thread::sleep(LOCK_RETRY_DELAY);
                }
            }
            Err(e) => return Err(io_err(op, dir_path, e)),
        }
    }
    Ok(false)
}

pub(crate) fn flock_exclusive_bounded(
    dir: &OwnedFd,
    dir_path: &Path,
    op: &'static str,
) -> Result<(), InstanceError> {
    if flock_bounded(dir, dir_path, op, FlockOperation::NonBlockingLockExclusive)? {
        Ok(())
    } else {
        Err(InstanceError::AlreadyRunning)
    }
}

pub(crate) const S_IFMT: u32 = 0o170000;
const S_ISVTX: u32 = 0o1000;
pub(crate) const S_IFDIR: u32 = 0o040000;
pub(crate) const S_IFREG: u32 = 0o100000;
pub(crate) const S_IFLNK: u32 = 0o120000;

#[cfg(target_os = "macos")]
pub(crate) fn mode_bits(stat: &rustix::fs::Stat) -> u32 {
    u32::from(stat.st_mode)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn mode_bits(stat: &rustix::fs::Stat) -> u32 {
    stat.st_mode
}

///
/// All anchor opens must use `HARDENED_DIR_FLAGS` to prevent symlink traversal.
pub(crate) const HARDENED_DIR_FLAGS: OFlags = OFlags::DIRECTORY
    .union(OFlags::NOFOLLOW)
    .union(OFlags::RDONLY)
    .union(OFlags::CLOEXEC);

///
/// walking `..` would let a pathname climb out of the tree the anchor pinned.
/// Rejecting `ParentDir` and `Prefix` prevents traversal outside the anchored tree.
pub(crate) fn normal_components(path: &Path) -> Option<Vec<&std::ffi::OsStr>> {
    let mut names = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => continue,
            Component::Normal(name) => names.push(name),
            Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    Some(names)
}

/// The function rejects anchors that another principal can replace.
/// replaceable.
///
/// For relative paths, `open_safe_anchor` validates the process working directory before resolving path components.
/// `open_safe_anchor` returns `Ok(None)` when the opened anchor fails `is_safe_ancestor`.
pub(crate) fn open_safe_anchor(path: &Path) -> Result<Option<OwnedFd>, rustix::io::Errno> {
    let anchor = openat(
        CWD,
        if path.is_absolute() { "/" } else { "." },
        HARDENED_DIR_FLAGS,
        Mode::empty(),
    )?;
    let stat = rustix::fs::fstat(&anchor)?;
    Ok(is_safe_ancestor(&stat).then_some(anchor))
}

/// A safe directory is owned by us or root and is not group- or other-writable unless sticky.
/// A sticky directory restricts who may rename or remove its entries.
/// A sticky directory allows only the entry owner, directory owner, or root to rename an entry.
pub(crate) fn is_safe_ancestor(stat: &rustix::fs::Stat) -> bool {
    let mode = mode_bits(stat);
    if (mode & S_IFMT) != S_IFDIR {
        return false;
    }
    let ours = rustix::process::geteuid().as_raw();
    if stat.st_uid != ours && stat.st_uid != 0 {
        return false;
    }
    mode & 0o022 == 0 || mode & S_ISVTX != 0
}

pub(crate) fn is_secure_regular(stat: &rustix::fs::Stat) -> bool {
    let mode = mode_bits(stat);
    (mode & S_IFMT) == S_IFREG
        && stat.st_nlink == 1
        && stat.st_uid == rustix::process::geteuid().as_raw()
        && mode & 0o077 == 0
}

/// `ATOMIC_WRITE_NAMES` lists the names accepted by `write_atomic_owner_only`.
/// The writer asserts membership, so every newly atomically written file is sweepable.
pub(crate) const ATOMIC_WRITE_NAMES: [&str; 2] = [
    CONNECTION_FILE_NAME,
    crate::lifecycle::LIFECYCLE_RECORD_NAME,
];

/// The sweep ignores removal failures so startup can continue.
/// The sweep unlinks descriptor-relatively, but metadata checks and unlinking are not atomic.
/// The sweep ignores failures and examines at most 1024 successfully read entries.
fn sweep_stale_temps(dir: &OwnedFd, dir_path: &Path) {
    const MAX_SWEEP_ENTRIES: usize = 1024;
    let prefixes = ATOMIC_WRITE_NAMES.map(|name| format!(".{name}."));
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

    const TEST_DIGEST: &str = "3d7f9a1c5b2e8f0a6d4c7b9e1f3a5c8d2b4e6f0a1c3d5e7f9b0d2f4a6c8e0b1d";

    /// Tests that mutate `runtime_dir_path`'s process-global environment cannot run concurrently.
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

        // A relative or empty XDG_DATA_HOME must never be joined to cwd.
        std::env::set_var("HOME", "/home-root");
        for ignored in ["relative/xdg", "./xdg", ""] {
            std::env::set_var("XDG_DATA_HOME", ignored);
            assert_eq!(
                runtime_dir_path(None).expect("relative xdg falls back to home"),
                PathBuf::from("/home-root/.local/share/cortexkit/run"),
                "XDG_DATA_HOME={ignored:?}"
            );
        }

        std::env::remove_var("XDG_DATA_HOME");
        assert_eq!(
            runtime_dir_path(None).expect("home"),
            PathBuf::from("/home-root/.local/share/cortexkit/run")
        );

        // A relative `HOME` is ignored; without an absolute root, the result is exactly `NoDataDir`.
        std::env::set_var("HOME", "relative-home");
        assert!(matches!(
            runtime_dir_path(None),
            Err(InstanceError::NoDataDir)
        ));

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
        let mut guard = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");
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
        // Acquisition refuses an intermediate directory another principal can rename because we cannot repair it like the final directory.
        let loose = root.path().join("loose");
        std::fs::create_dir_all(&loose).expect("create intermediate");
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o777))
            .expect("loosen intermediate");

        let err = InstanceGuard::acquire(Some(&loose), TEST_DIGEST).expect_err("must refuse");
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

        let guard = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");
        assert_eq!(mode_of(guard.dir_path()), 0o700);
    }

    #[test]
    fn publication_matches_schema_1_shape() {
        let root = temp_root();
        let mut guard = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");
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
        let mut first =
            InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("first acquire");
        first.publish(1111, "mc-host/first").expect("publish");
        let before = std::fs::read(published(&first)).expect("read first");

        let err =
            InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect_err("second must fail");
        assert!(matches!(err, InstanceError::AlreadyRunning));

        let after = std::fs::read(published(&first)).expect("read first again");
        assert_eq!(before, after, "loser must not disturb the holder's file");
    }

    #[test]
    fn lock_ownership_survives_renaming_the_runtime_dir() {
        let root = temp_root();
        let mut first =
            InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("first acquire");
        first.publish(1111, "mc-host/first").expect("publish");
        let before = std::fs::read(published(&first)).expect("read first");

        let moved = root.path().join("cortexkit").join("run-moved");
        std::fs::rename(first.dir_path(), &moved).expect("rename runtime dir");

        // Lock ownership belongs to the inode rather than its pathname; renaming the directory does not release the holder's lock.
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

        // A successor anchors a fresh runtime inode, but the lifetime fence outside the replaceable subtree rejects a second incarnation.
        // The lifetime fence is held for the incarnation outside the replaceable subtree.
        let successor = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST);
        assert!(
            matches!(successor, Err(InstanceError::AlreadyRunning)),
            "a renamed runtime directory must not admit an overlapping incarnation"
        );
        assert_eq!(
            std::fs::read(moved.join(CONNECTION_FILE_NAME)).expect("read moved"),
            before,
            "the holder's publication must be untouched"
        );

        // The open directory handle lets `first` remove its publication after the runtime directory is renamed.
        // the rename.
        first.remove_publication();
        assert!(!moved.join(CONNECTION_FILE_NAME).exists());

        // Tearing down the displaced holder releases the runtime and lifetime fences, allowing a successor.
        drop(first);
        let second =
            InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("successor acquires");
        drop(second);
    }

    #[test]
    fn symlinked_runtime_dir_fails_closed() {
        let root = temp_root();
        let elsewhere = temp_root();
        let dir = runtime_dir_path(Some(root.path())).expect("resolve");
        std::fs::create_dir_all(dir.parent().expect("parent")).expect("create parents");
        symlink(elsewhere.path(), &dir).expect("symlink runtime dir");

        assert!(InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).is_err());
    }

    #[test]
    fn symlinked_runtime_ancestor_fails_closed() {
        let root = temp_root();
        let elsewhere = temp_root();
        symlink(elsewhere.path(), root.path().join("cortexkit")).expect("symlink runtime ancestor");

        assert!(InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).is_err());
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
        // A directory at the publication name prevents rename(2) from replacing it.
        // Publication must fail closed rather than clobber a directory at the publication name.
        std::fs::create_dir(dir.join(CONNECTION_FILE_NAME)).expect("plant directory");

        let mut guard = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");
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

        let mut guard = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");
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
        let mut guard = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");
        guard.publish(3333, "mc-host/test").expect("publish");
        let file = published(&guard);
        assert!(file.exists());
        guard.remove_publication();
        assert!(!file.exists(), "our own publication must be removed");
    }

    #[test]
    fn replaced_inode_prevents_unlink() {
        let root = temp_root();
        let mut guard = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");
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
        let mut guard = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");
        guard.publish(5555, "mc-host/test").expect("publish");
        let file = published(&guard);

        // Same inode, rewritten daemon ID: an old incarnation must not delete a credential it no longer owns.
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
        let mut guard = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");
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
        let mut guard = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");
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
        // Dropping the first guard releases the lock so its successor can acquire the directory.
        let dir = {
            let guard =
                InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("first acquire");
            guard.dir_path().to_path_buf()
        };

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

        // The successor sweeps staged files at lock acquisition, before publishing, so a crash loop that never reaches publish still reclaims temps.
        let mut guard = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");

        assert!(!stale.exists(), "a stale temp must be swept");
        assert!(fresh.exists(), "an in-flight temp must be spared");
        assert!(unrelated.exists(), "age alone must not condemn other files");
        guard.publish(9999, "mc-host/test").expect("publish");
        assert!(published(&guard).exists(), "publication must still land");
    }

    #[test]
    fn no_temp_files_remain_after_a_successful_publish() {
        let root = temp_root();
        let mut guard = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");
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
        let guard = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");

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
            for window in key_hex.as_bytes().windows(16) {
                let window = std::str::from_utf8(window).expect("hex is ASCII");
                assert!(!rendered.contains(window), "{rendered} leaked {window}");
            }
        }
    }

    #[test]
    fn error_display_carries_paths_but_no_secrets() {
        let root = temp_root();
        let _holder = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect("acquire");
        let err = InstanceGuard::acquire(Some(root.path()), TEST_DIGEST).expect_err("second fails");
        let rendered = format!("{err}");
        assert!(rendered.contains("holds the lock"), "{rendered}");
        assert!(!rendered.contains("key"), "{rendered}");
    }
}
