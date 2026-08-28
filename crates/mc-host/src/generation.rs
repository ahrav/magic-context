//! Content-addressed generation store with one atomic current profile
//! (plan KTD9, R21-R22, R29-R31, R46).
//!
//! Layout under `${dataDir}/cortexkit/lifecycle/`:
//!
//! ```text
//! lifecycle/
//!   generations/<payload-manifest-digest>/   staged payload files + manifest.json
//!   generations/tmp-<random>/                incomplete staging temps
//!   current-profile.json                     {"schema":1,"current":"<digest>"}
//! ```
//!
//! The digest that names a generation is the SHA-256 of its canonical
//! manifest bytes, which commit the target tuple, the U8 release-contract
//! digest, the U9 input-lock digest, and every file's path, mode, size, and
//! hash. Callers mutate the store only while holding the version-neutral
//! `transaction.lock`; this module owns byte-level trust, not serialization.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use rustix::fd::OwnedFd;
use rustix::fs::{fsync, mkdirat, openat, renameat, unlinkat, AtFlags, Mode, OFlags};
use sha2::Digest;

use crate::instance::{
    hex, io_err, is_safe_ancestor, is_secure_regular, mode_bits, open_secure_dir_existing,
    read_all_fd, secure_runtime_dir, write_all_fd, InstanceError, S_IFDIR, S_IFLNK, S_IFMT,
    S_IFREG,
};
use crate::lifecycle::{is_canonical_payload_digest, lifecycle_dir_path};

/// Directory of content-addressed generations inside the lifecycle root.
pub const GENERATIONS_DIR_NAME: &str = "generations";

/// The single current-selector profile file inside the lifecycle root.
pub const CURRENT_PROFILE_NAME: &str = "current-profile.json";

/// Canonical manifest name inside each generation directory. The manifest
/// is not listed in its own `files` array; its bytes are the digest input.
pub const GENERATION_MANIFEST_NAME: &str = "manifest.json";

/// Prefix for incomplete staging temporaries, cleaned during pruning.
pub const STAGING_TEMP_PREFIX: &str = "tmp-";

/// Manifest and evidence read cap, matching the lifecycle evidence cap.
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

/// Fixed metadata allowance charged by the capacity preflight for the
/// manifest, profile temp, and directory entries that coexist until rename.
const CAPACITY_FIXED_OVERHEAD_BYTES: u64 = 1024 * 1024;

/// Reserve floor from R46: `max(256 MiB, ceil(required * 10%))`.
const CAPACITY_RESERVE_FLOOR_BYTES: u64 = 256 * 1024 * 1024;

/// Closed store failure classes. Every variant maps onto exactly one closed
/// v1 reason: callers must not invent finer-grained externally visible
/// classifications from the bounded static detail.
#[derive(Debug)]
pub enum GenerationError {
    /// The capacity preflight failed or a post-preflight write hit ENOSPC;
    /// trusted selectors are unchanged and the owned temp was removed.
    InsufficientStorage,
    /// Validation, staging identity, exchange repair, or checked arithmetic
    /// failed. `current` is unchanged and no other generation was selected.
    NativePayloadInvalid {
        detail: &'static str,
    },
    /// A persisted profile or generation manifest carries an unknown schema:
    /// it is preserved byte-for-byte and quarantined, and the requested
    /// mutation or selection was aborted.
    UnsupportedStateSchema,
    Instance(InstanceError),
}

impl std::fmt::Display for GenerationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InsufficientStorage => write!(f, "insufficient storage for staging"),
            Self::NativePayloadInvalid { detail } => {
                write!(f, "native payload invalid: {detail}")
            }
            Self::UnsupportedStateSchema => write!(f, "unsupported persisted state schema"),
            Self::Instance(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for GenerationError {}

impl From<InstanceError> for GenerationError {
    fn from(err: InstanceError) -> Self {
        Self::Instance(err)
    }
}

fn invalid(detail: &'static str) -> GenerationError {
    GenerationError::NativePayloadInvalid { detail }
}

/// `fsync` that preserves the storage-exhaustion classification.
///
/// On delayed-allocation filesystems the blocks a write reserved are assigned
/// at writeback, so exhaustion can first surface here rather than from `write`.
/// The API promises post-preflight exhaustion as
/// [`GenerationError::InsufficientStorage`], whose remediation is to free
/// space; collapsing it into `NativePayloadInvalid` would tell a user on a full
/// disk to reinstall the payload instead.
fn fsync_preserving_storage<Fd: rustix::fd::AsFd>(
    fd: Fd,
    detail: &'static str,
) -> Result<(), GenerationError> {
    fsync(fd).map_err(|e| match e {
        rustix::io::Errno::NOSPC | rustix::io::Errno::DQUOT => GenerationError::InsufficientStorage,
        _ => invalid(detail),
    })
}

/// Whether an I/O error means the destination cannot accept more bytes.
///
/// A per-user quota is exhaustion the caller can act on exactly like a full
/// filesystem — free space, do not reinstall — and the capacity preflight cannot
/// see it, since `statvfs` reports the filesystem's free blocks rather than the
/// caller's remaining quota.
fn is_storage_exhausted(err: &std::io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        Some(code)
            if code == rustix::io::Errno::NOSPC.raw_os_error()
                || code == rustix::io::Errno::DQUOT.raw_os_error()
    )
}

/// One file inside a generation manifest. Paths are relative, contain no
/// parent segments, and are unique and sorted in the canonical encoding.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestFile {
    pub path: String,
    pub mode: u32,
    pub size: u64,
    pub sha256: String,
}

/// Canonical schema-1 payload manifest. Serialization order is fixed by the
/// struct, and `files` is sorted by path, so encoding is deterministic and
/// its SHA-256 is the generation's name.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenerationManifest {
    pub schema: u32,
    pub target: String,
    pub release_contract_sha256: String,
    pub inputs_lock_sha256: String,
    /// The payload manifest this generation was staged from, or `None` for a
    /// generation staged before the field existed.
    ///
    /// Schema 1 shipped without it and the schema number did not change when it
    /// was added, so requiring it would decode every retained predecessor as
    /// corrupt and fail the first no-`--payload-dir` start after an upgrade with
    /// `native_payload_invalid` — refusing a payload that is intact. A generation
    /// that cannot name its source instead fails only the checks that actually
    /// need that name, which is what `Option` makes explicit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_payload_manifest_sha256: Option<String>,
    pub files: Vec<ManifestFile>,
}

impl GenerationManifest {
    pub fn canonical_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("manifest serialization cannot fail")
    }

    pub fn digest(&self) -> String {
        hex(&sha2::Sha256::digest(self.canonical_bytes()))
    }
}

/// Outcome of strictly decoding manifest or profile bytes.
enum SchemaDecode<T> {
    Valid(T),
    UnknownSchema,
    Malformed,
}

fn decode_with_schema<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> SchemaDecode<T> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return SchemaDecode::Malformed;
    };
    match value.get("schema").and_then(serde_json::Value::as_u64) {
        Some(1) => {}
        Some(_) => return SchemaDecode::UnknownSchema,
        None => return SchemaDecode::Malformed,
    }
    match serde_json::from_value::<T>(value) {
        Ok(decoded) => SchemaDecode::Valid(decoded),
        Err(_) => SchemaDecode::Malformed,
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WireProfile {
    schema: u32,
    current: String,
}

/// What the current profile names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CurrentProfile {
    Absent,
    Current(String),
    /// Unknown persisted schema: preserved byte-for-byte, unselectable, and
    /// mutation-blocking while its references are uncertain.
    Quarantined,
}

/// One source file for staging: consumed through a no-follow descriptor with
/// bounded before/after metadata checks. A hard link into a package cache is
/// an acceptable source; the staged output is always an independent
/// owner-only single-link copy.
#[derive(Debug, Clone)]
pub struct SourceSpec {
    /// Relative destination path inside the generation.
    pub rel_path: String,
    /// Absolute source file path.
    pub source: PathBuf,
    /// Whether the staged copy is owner-executable (0o700 vs 0o600).
    pub executable: bool,
    /// Optional release-manifest size for production package sources.
    pub expected_size: Option<u64>,
    /// Optional release-manifest SHA-256 for production package sources.
    pub expected_sha256: Option<String>,
}

/// Non-file identity inputs committed by the staged manifest.
#[derive(Debug, Clone)]
pub struct StageMeta {
    pub target: String,
    pub release_contract_sha256: String,
    pub inputs_lock_sha256: String,
    pub source_payload_manifest_sha256: String,
}

/// A completely revalidated generation: the retained directory descriptor
/// pins the validated tree against pathname replacement, and the manifest
/// is the exact decoded canonical content.
pub struct ValidatedGeneration {
    pub digest: String,
    pub manifest: GenerationManifest,
    dir: OwnedFd,
    path: PathBuf,
}

impl ValidatedGeneration {
    /// Stable managed path for libraries that require pathname-based loading.
    /// Every consumer must still perform its own no-follow/hash validation;
    /// the retained directory descriptor remains the generation identity.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Opens one manifest-listed file through the retained validated
    /// directory descriptor, rechecking shape and hash so the returned
    /// descriptor is execution-trustworthy even if the pathname was
    /// replaced after validation.
    pub fn open_verified_file(&self, rel_path: &str) -> Result<OwnedFd, GenerationError> {
        let entry = self
            .manifest
            .files
            .iter()
            .find(|file| file.path == rel_path)
            .ok_or_else(|| invalid("file is not named by the manifest"))?;
        let fd = open_rel_nofollow(&self.dir, rel_path).ok_or_else(|| invalid("file missing"))?;
        verify_file_against_entry(&fd, entry)?;
        Ok(fd)
    }
}

/// Rounds a size up to a 4 KiB allocation block with checked arithmetic.
fn allocation_rounded(size: u64) -> Option<u64> {
    const BLOCK: u64 = 4096;
    size.checked_add(BLOCK - 1).map(|n| (n / BLOCK) * BLOCK)
}

/// Checked R46 accounting: `available >= required + max(256 MiB,
/// ceil(required * 10%))`. Public for exact boundary tests.
pub fn capacity_satisfied(available: u64, required: u64) -> Option<bool> {
    let tenth = required.div_ceil(10);
    let reserve = tenth.max(CAPACITY_RESERVE_FLOOR_BYTES);
    let needed = required.checked_add(reserve)?;
    Some(available >= needed)
}

/// Sums allocation-rounded staging requirements with checked arithmetic.
/// `None` means overflow or an impossible manifest size.
pub fn required_stage_bytes(sizes: &[u64]) -> Option<u64> {
    let mut total = CAPACITY_FIXED_OVERHEAD_BYTES;
    for size in sizes {
        total = total.checked_add(allocation_rounded(*size)?)?;
    }
    Some(total)
}

/// Opens `rel` under `dir` component by component with `O_NOFOLLOW`, so no
/// intermediate or final symlink is followed. `None` means absent; hostile
/// shapes surface as `None` too and fail the caller's stricter checks.
fn open_rel_nofollow(dir: &OwnedFd, rel: &str) -> Option<OwnedFd> {
    let mut components = rel.split('/').peekable();
    let mut current: Option<OwnedFd> = None;
    while let Some(component) = components.next() {
        if component.is_empty() || component == "." || component == ".." {
            return None;
        }
        let at = current.as_ref().unwrap_or(dir);
        let last = components.peek().is_none();
        let flags = if last {
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK
        } else {
            OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC
        };
        match openat(at, component, flags, Mode::empty()) {
            Ok(fd) => current = Some(fd),
            Err(_) => return None,
        }
    }
    current
}

/// Directory-only variant of [`open_rel_nofollow`]: every component, including
/// the last, is opened as a directory without following links.
fn open_rel_dir_nofollow(dir: &OwnedFd, rel: &str) -> Option<OwnedFd> {
    let mut current: Option<OwnedFd> = None;
    for component in rel.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return None;
        }
        let at = current.as_ref().unwrap_or(dir);
        match openat(
            at,
            component,
            OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => current = Some(fd),
            Err(_) => return None,
        }
    }
    current
}

fn owner_uid() -> u32 {
    rustix::process::geteuid().as_raw()
}

/// Permission bits as rustix's platform-width `RawMode`.
///
/// `RawMode` is `u32` on Linux and `u16` on the Darwin targets, while the
/// manifest commits `mode` as `u32`, so the two cannot meet without an explicit
/// conversion — leaving it implicit compiles on Linux and fails on Darwin. Only
/// the permission and set-id bits are meaningful to any caller here, and every
/// value passed is already within them (0o600 or 0o700 for staged output, and a
/// manifest mode that validation requires to equal `mode & 0o777`), so the mask
/// documents that range rather than narrowing a value that could exceed it.
#[allow(clippy::unnecessary_cast)]
fn raw_mode(mode: u32) -> rustix::fs::RawMode {
    (mode & 0o7777) as rustix::fs::RawMode
}

fn verify_file_against_entry(fd: &OwnedFd, entry: &ManifestFile) -> Result<(), GenerationError> {
    let stat = rustix::fs::fstat(fd).map_err(|_| invalid("file stat failed"))?;
    let mode = mode_bits(&stat);
    if (mode & S_IFMT) != S_IFREG {
        return Err(invalid("file is not a regular file"));
    }
    if stat.st_uid != owner_uid() || stat.st_nlink != 1 || (mode & 0o077) != 0 {
        return Err(invalid("file is not owner-only single-link"));
    }
    if (mode & 0o777) != entry.mode {
        return Err(invalid("file mode diverges from the manifest"));
    }
    if stat.st_size as u64 != entry.size {
        return Err(invalid("file size diverges from the manifest"));
    }
    let mut hasher = sha2::Sha256::new();
    let mut file = std::fs::File::from(
        rustix::io::dup(fd).map_err(|_| invalid("file descriptor dup failed"))?,
    );
    let mut buf = vec![0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|_| invalid("file read failed"))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > entry.size {
            return Err(invalid("file grew past its manifest size"));
        }
        hasher.update(&buf[..n]);
    }
    if total != entry.size || hex(&hasher.finalize()) != entry.sha256 {
        return Err(invalid("file hash diverges from the manifest"));
    }
    // The hashing dup above shares `fd`'s open file description, so reading it
    // to EOF left `fd` positioned at `entry.size`. Callers receive this
    // descriptor to read the verified bytes; rewind it so the first read is the
    // first byte rather than EOF.
    rustix::fs::seek(fd, rustix::fs::SeekFrom::Start(0))
        .map_err(|_| invalid("file rewind after verification failed"))?;
    Ok(())
}

/// The generation store rooted at the managed lifecycle directory.
pub struct GenerationStore {
    root: PathBuf,
    root_fd: OwnedFd,
    generations_fd: OwnedFd,
}

impl std::fmt::Debug for GenerationStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GenerationStore")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

/// What pruning removed and preserved.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PruneReport {
    pub removed_generations: usize,
    pub removed_temps: usize,
    pub quarantined: usize,
}

impl GenerationStore {
    /// Creates or opens the store, creating owner-only directories as
    /// needed. Mutating entry points require the caller to hold the
    /// version-neutral `transaction.lock`.
    pub fn open(data_dir_override: Option<&Path>) -> Result<Self, GenerationError> {
        let root = lifecycle_dir_path(data_dir_override)?;
        // Component-by-component creation through pinned no-follow descriptors.
        // A pathname `mkdir` walk reports `EEXIST` for a symlinked intermediate
        // and keeps traversing through it, and a final-component `O_NOFOLLOW`
        // does not undo that, so the store could be created and mutated outside
        // the requested data root.
        let root_fd = secure_runtime_dir(&root)?;
        validate_lifecycle_root_fd(&root_fd, &root)?;
        let created = match mkdirat(&root_fd, GENERATIONS_DIR_NAME, Mode::from_raw_mode(0o700)) {
            Ok(()) => true,
            Err(rustix::io::Errno::EXIST) => false,
            Err(e) => return Err(io_err("mkdir_generations", &root, e).into()),
        };
        // mkdir modes are filtered by umask, which can leave a freshly created
        // directory with no owner bits — and a 0700 directory cannot even be
        // opened by its owner, so the mode must be restored by pathname before
        // the descriptor exists. That pathname `chmodat` follows symlinks, so it
        // runs only when this call created the entry: `mkdirat` succeeding proves
        // a real directory is at that name and nothing else can be. An existing
        // entry is never chmodded, so a symlink planted at `generations` cannot
        // redirect the mode change onto its target before the no-follow open
        // below rejects the store.
        if created {
            rustix::fs::chmodat(
                &root_fd,
                GENERATIONS_DIR_NAME,
                Mode::from_raw_mode(0o700),
                AtFlags::empty(),
            )
            .map_err(|e| io_err("chmod_generations", &root, e))?;
        }
        let generations_fd = open_child_dir(&root_fd, GENERATIONS_DIR_NAME)
            .ok_or_else(|| invalid("generations directory failed security checks"))?;
        if created {
            // Pin the mode through the descriptor now that one exists, so the
            // final state is set on the object we validated rather than on a
            // name.
            rustix::fs::fchmod(&generations_fd, Mode::from_raw_mode(0o700))
                .map_err(|e| io_err("fchmod_generations", &root, e))?;
        }
        Ok(Self {
            root,
            root_fd,
            generations_fd,
        })
    }

    /// No-create open for observational probes: `Ok(None)` when the store
    /// does not exist yet. An existing root is held to exactly the same
    /// ownership and ancestor predicate as [`Self::open`]: this is the path
    /// production `start`/`restart` and the daemon itself take, so an
    /// insecure root fails closed here rather than being silently accepted.
    ///
    /// Absence and insecurity are distinct outcomes. Only a missing component
    /// is absence; an existing component that is a symlink, inaccessible, or
    /// otherwise outside the trust predicate is an error, because reporting it
    /// as `native_payload_missing` would mask hostile persisted state behind
    /// the remediation for a fresh install.
    pub fn open_probe(data_dir_override: Option<&Path>) -> Result<Option<Self>, GenerationError> {
        let root = lifecycle_dir_path(data_dir_override)?;
        let Some(root_fd) = open_secure_dir_existing(&root)? else {
            // Absent store: nothing staged yet, not a trust failure.
            return Ok(None);
        };
        validate_lifecycle_root_fd(&root_fd, &root)?;
        let Some(generations_fd) = open_child_dir_existing(&root_fd, GENERATIONS_DIR_NAME)? else {
            return Ok(None);
        };
        Ok(Some(Self {
            root,
            root_fd,
            generations_fd,
        }))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Reads the current profile without mutating anything.
    pub fn read_current(&self) -> Result<CurrentProfile, GenerationError> {
        let fd = match openat(
            &self.root_fd,
            CURRENT_PROFILE_NAME,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(CurrentProfile::Absent),
            Err(_) => return Err(invalid("current profile failed security checks")),
        };
        let stat = rustix::fs::fstat(&fd).map_err(|_| invalid("current profile stat failed"))?;
        // The profile is the selector that decides which generation runs, so
        // it is held to the same predicate as every other trusted state file:
        // owner-only, single-link, regular. A weaker check here would let an
        // extra hard link or a group/other-writable mode redirect selection.
        if !is_secure_regular(&stat) {
            return Err(invalid("current profile failed security checks"));
        }
        let bytes = read_all_fd(&fd, MAX_MANIFEST_BYTES)
            .map_err(|_| invalid("current profile read failed"))?;
        match decode_with_schema::<WireProfile>(&bytes) {
            SchemaDecode::Valid(profile) => {
                if !is_canonical_payload_digest(&profile.current) {
                    return Err(invalid("current profile names a noncanonical digest"));
                }
                Ok(CurrentProfile::Current(profile.current))
            }
            SchemaDecode::UnknownSchema => Ok(CurrentProfile::Quarantined),
            SchemaDecode::Malformed => Err(invalid("current profile is corrupt")),
        }
    }

    /// Completely revalidates one generation: manifest schema, digest
    /// binding, per-file shape/size/mode/hash, and no unlisted entries.
    /// Failed validation never selects another generation.
    pub fn validate(&self, digest: &str) -> Result<ValidatedGeneration, GenerationError> {
        if !is_canonical_payload_digest(digest) {
            return Err(invalid("generation digest is noncanonical"));
        }
        let Some(dir) = open_child_dir(&self.generations_fd, digest) else {
            return Err(invalid("generation directory is missing or insecure"));
        };
        let manifest = self.validate_in_dir(&dir, digest)?;
        Ok(ValidatedGeneration {
            digest: digest.to_owned(),
            manifest,
            dir,
            path: self.generation_path(digest),
        })
    }

    fn validate_in_dir(
        &self,
        dir: &OwnedFd,
        digest: &str,
    ) -> Result<GenerationManifest, GenerationError> {
        let manifest_fd = open_rel_nofollow(dir, GENERATION_MANIFEST_NAME)
            .ok_or_else(|| invalid("generation manifest is missing"))?;
        let stat = rustix::fs::fstat(&manifest_fd).map_err(|_| invalid("manifest stat failed"))?;
        if (mode_bits(&stat) & S_IFMT) != S_IFREG
            || stat.st_uid != owner_uid()
            || stat.st_nlink != 1
        {
            return Err(invalid("generation manifest failed security checks"));
        }
        let bytes = read_all_fd(&manifest_fd, MAX_MANIFEST_BYTES)
            .map_err(|_| invalid("generation manifest read failed"))?;
        let manifest = match decode_with_schema::<GenerationManifest>(&bytes) {
            SchemaDecode::Valid(manifest) => manifest,
            SchemaDecode::UnknownSchema => return Err(GenerationError::UnsupportedStateSchema),
            SchemaDecode::Malformed => return Err(invalid("generation manifest is corrupt")),
        };
        if hex(&sha2::Sha256::digest(&bytes)) != digest {
            return Err(invalid("manifest bytes do not hash to the generation name"));
        }
        // The digest above binds the generation name to whatever bytes are on
        // disk, not to the canonical encoding of the decoded manifest. Without
        // this equality a manifest with reordered keys or extra whitespace,
        // stored under the hash of those raw bytes, validates while
        // `manifest.digest()` names a different generation — two identities for
        // one logical manifest, which breaks the content-addressed
        // deduplication and repair the digest is supposed to provide.
        if manifest.canonical_bytes() != bytes {
            return Err(invalid("manifest is not canonically encoded"));
        }
        let mut expected: BTreeSet<String> = BTreeSet::new();
        let mut sorted = manifest.files.clone();
        sorted.sort_by(|a, b| a.path.cmp(&b.path));
        if sorted != manifest.files {
            return Err(invalid("manifest files are not sorted by path"));
        }
        for entry in &manifest.files {
            if !expected.insert(entry.path.clone()) {
                return Err(invalid("manifest lists a duplicate path"));
            }
            let fd = open_rel_nofollow(dir, &entry.path)
                .ok_or_else(|| invalid("manifest-listed file is missing"))?;
            verify_file_against_entry(&fd, entry)?;
        }
        // Reject unlisted entries: walk the tree and require every regular
        // file to be the manifest itself or manifest-listed, and every
        // directory to be owner-only. The walk goes through the retained
        // descriptor, never by re-resolving the digest pathname: a pathname
        // walk inspects whatever now occupies that name, so a replacement
        // holding only the expected names could satisfy this check while the
        // returned `ValidatedGeneration` still pins the original directory and
        // its unlisted content.
        let mut found: BTreeSet<String> = BTreeSet::new();
        walk_generation_tree(dir, "", &mut found)?;
        for path in &found {
            if path != GENERATION_MANIFEST_NAME && !expected.contains(path) {
                return Err(invalid("generation contains an unlisted file"));
            }
        }
        for path in &expected {
            if !found.contains(path) {
                return Err(invalid("manifest-listed file is missing"));
            }
        }
        Ok(manifest)
    }

    /// Managed pathname of one generation directory, derived from the store
    /// root rather than resolved, so it names the same location whether or not
    /// the directory exists yet.
    fn generation_path(&self, name: &str) -> PathBuf {
        self.root.join(GENERATIONS_DIR_NAME).join(name)
    }

    /// Available bytes for this store's destination filesystem, as seen by
    /// an unprivileged owner.
    pub fn available_bytes(&self) -> Result<u64, GenerationError> {
        let stat =
            rustix::fs::fstatvfs(&self.generations_fd).map_err(|_| invalid("statvfs failed"))?;
        // `f_bavail` counts `f_frsize` units, not `f_bsize` ones: `f_bsize` is
        // the preferred I/O transfer size, which on filesystems reporting a
        // 64 KiB or 128 KiB `f_bsize` over a 4 KiB fragment size would inflate
        // capacity by an order of magnitude and let the preflight admit a
        // staging run that cannot fit.
        let unit = if stat.f_frsize != 0 {
            stat.f_frsize
        } else {
            stat.f_bsize
        };
        Ok(stat.f_bavail.saturating_mul(unit))
    }

    /// Stages one generation from descriptor-validated sources and
    /// atomically replaces the current profile with its digest. The caller
    /// holds `transaction.lock`; `protected` is the caller-computed
    /// protected digest set used only for same-digest exchange repair.
    ///
    /// Failure modes: `InsufficientStorage` before temp creation or on
    /// post-preflight ENOSPC (temp removed, selectors preserved),
    /// `UnsupportedStateSchema` when the existing profile is quarantined,
    /// and `NativePayloadInvalid` for every identity or validation fault
    /// (profile unchanged).
    pub fn stage_and_promote(
        &self,
        sources: &[SourceSpec],
        meta: &StageMeta,
        protected: &BTreeSet<String>,
    ) -> Result<String, GenerationError> {
        // A quarantined profile blocks mutation outright: its references
        // are uncertain, so nothing may be replaced or pruned around it.
        if self.read_current()? == CurrentProfile::Quarantined {
            return Err(GenerationError::UnsupportedStateSchema);
        }
        // Capacity preflight with checked arithmetic, before temp creation.
        let mut sizes = Vec::with_capacity(sources.len());
        for spec in sources {
            let meta = std::fs::symlink_metadata(&spec.source)
                .map_err(|_| invalid("staging source is missing"))?;
            if !meta.is_file() {
                return Err(invalid("staging source is not a regular file"));
            }
            sizes.push(meta.len());
        }
        let required =
            required_stage_bytes(&sizes).ok_or_else(|| invalid("manifest size overflow"))?;
        let available = self.available_bytes()?;
        match capacity_satisfied(available, required) {
            Some(true) => {}
            Some(false) => return Err(GenerationError::InsufficientStorage),
            None => return Err(invalid("capacity arithmetic overflow")),
        }

        let (temp_name, temp_fd) = self.create_staging_temp()?;
        let result = self.stage_into_temp(&temp_fd, sources, meta);
        let manifest = match result {
            Ok(manifest) => manifest,
            Err(err) => {
                let _ = remove_tree(&self.generations_fd, &temp_name);
                return Err(err);
            }
        };
        let digest = manifest.digest();
        if let Err(err) = self.promote_temp(&temp_name, &digest, protected) {
            let _ = remove_tree(&self.generations_fd, &temp_name);
            return Err(err);
        }
        self.replace_profile(&digest)?;
        Ok(digest)
    }

    fn create_staging_temp(&self) -> Result<(String, OwnedFd), GenerationError> {
        let mut suffix = [0u8; 8];
        getrandom::getrandom(&mut suffix)
            .map_err(|_| GenerationError::Instance(InstanceError::Random))?;
        let temp_name = format!("{STAGING_TEMP_PREFIX}{}", hex(&suffix));
        mkdirat(
            &self.generations_fd,
            temp_name.as_str(),
            Mode::from_raw_mode(0o700),
        )
        .map_err(|e| match e {
            rustix::io::Errno::NOSPC | rustix::io::Errno::DQUOT => {
                GenerationError::InsufficientStorage
            }
            _ => invalid("staging temp creation failed"),
        })?;
        // The mkdir mode is umask-filtered, and a directory left without owner
        // bits cannot be opened by its owner at all — so the open below would
        // fail and report the temp as insecure. `mkdirat` does not tolerate
        // EEXIST here, so its success proves this call created the entry and the
        // pathname chmod cannot be redirected through a planted symlink.
        rustix::fs::chmodat(
            &self.generations_fd,
            temp_name.as_str(),
            Mode::from_raw_mode(0o700),
            AtFlags::empty(),
        )
        .map_err(|_| invalid("staging temp chmod failed"))?;
        let temp_fd = open_child_dir(&self.generations_fd, &temp_name)
            .ok_or_else(|| invalid("staging temp failed security checks"))?;
        rustix::fs::fchmod(&temp_fd, Mode::from_raw_mode(0o700))
            .map_err(|_| invalid("staging temp chmod failed"))?;
        Ok((temp_name, temp_fd))
    }

    fn stage_into_temp(
        &self,
        temp_fd: &OwnedFd,
        sources: &[SourceSpec],
        meta: &StageMeta,
    ) -> Result<GenerationManifest, GenerationError> {
        let mut files = Vec::with_capacity(sources.len());
        let mut seen = BTreeSet::new();
        // Every directory this staging run creates entries in. Each one needs
        // its own fsync: fsyncing a new file does not durably persist its
        // parent's entry for it, so a crash after profile promotion could
        // otherwise recover a current generation whose nested files are absent.
        let mut dirs: BTreeSet<String> = BTreeSet::new();
        for spec in sources {
            validate_rel_path(&spec.rel_path)?;
            if !seen.insert(spec.rel_path.clone()) {
                return Err(invalid("duplicate staged path"));
            }
            let components: Vec<&str> = spec.rel_path.split('/').collect();
            let mut walked = String::new();
            for component in &components[..components.len() - 1] {
                if !walked.is_empty() {
                    walked.push('/');
                }
                walked.push_str(component);
                dirs.insert(walked.clone());
            }
            let entry = copy_source_into(temp_fd, spec)?;
            files.push(entry);
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let manifest = GenerationManifest {
            schema: 1,
            target: meta.target.clone(),
            release_contract_sha256: meta.release_contract_sha256.clone(),
            inputs_lock_sha256: meta.inputs_lock_sha256.clone(),
            source_payload_manifest_sha256: Some(meta.source_payload_manifest_sha256.clone()),
            files,
        };
        let bytes = manifest.canonical_bytes();
        // Validation reads the persisted manifest under `MAX_MANIFEST_BYTES`,
        // so a manifest above that cap can never be revalidated. Refuse it here
        // rather than after promotion, which would leave `current-profile.json`
        // naming a generation this implementation is unable to accept.
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(invalid("staged manifest exceeds the manifest size cap"));
        }
        write_new_file(temp_fd, GENERATION_MANIFEST_NAME, &bytes, 0o600)?;
        // Deepest first, so each directory's entries are durable before its
        // own entry in its parent is made durable.
        for rel in dirs.iter().rev() {
            let dir = open_rel_dir_nofollow(temp_fd, rel)
                .ok_or_else(|| invalid("staged directory reopen failed"))?;
            fsync_preserving_storage(&dir, "staged directory fsync failed")?;
        }
        fsync_preserving_storage(temp_fd, "staging temp fsync failed")?;
        Ok(manifest)
    }

    /// Renames the fully staged temp to its digest name. When a directory
    /// already occupies the digest: a valid occupant wins (the temp is
    /// discarded), and an invalid unprotected occupant is repaired only by
    /// atomic exchange with the validated candidate, revalidated before the
    /// exchanged orphan is deleted.
    ///
    /// The rename must not replace: POSIX `renameat` succeeds when the target
    /// is an existing empty directory, so a plain rename would silently
    /// destroy a protected occupant that had been corrupted into an empty
    /// directory before the protection check below ever ran.
    fn promote_temp(
        &self,
        temp_name: &str,
        digest: &str,
        protected: &BTreeSet<String>,
    ) -> Result<(), GenerationError> {
        if rename_no_replace(&self.generations_fd, temp_name, digest)? {
            fsync_preserving_storage(&self.generations_fd, "generations fsync failed")?;
            return Ok(());
        }
        // Occupied digest target.
        match self.validate(digest) {
            // A valid occupant is already this generation: keep it, drop the temp.
            Ok(_) => {
                let _ = remove_tree(&self.generations_fd, temp_name);
                return Ok(());
            }
            // An unknown manifest schema is quarantined, not corrupt. Repairing
            // it would exchange and then delete bytes the store promises to
            // preserve, so the mutation is abandoned instead — the same rule
            // `prune` applies through `is_quarantined_schema`.
            Err(GenerationError::UnsupportedStateSchema) => {
                return Err(GenerationError::UnsupportedStateSchema);
            }
            Err(_) => {}
        }
        if protected.contains(digest) {
            return Err(invalid("corrupt digest target is protected"));
        }
        exchange_dirs(&self.generations_fd, temp_name, digest)?;
        fsync_preserving_storage(&self.generations_fd, "generations fsync failed")?;
        // Revalidate the promoted target before deleting the exchanged
        // corrupt orphan now sitting at the temp name.
        self.validate(digest)?;
        let _ = remove_tree(&self.generations_fd, temp_name);
        Ok(())
    }

    fn replace_profile(&self, digest: &str) -> Result<(), GenerationError> {
        let profile = WireProfile {
            schema: 1,
            current: digest.to_owned(),
        };
        let bytes = serde_json::to_vec(&profile).expect("profile serialization cannot fail");
        let temp_name = format!(".{CURRENT_PROFILE_NAME}.{}.tmp", std::process::id());
        let _ = unlinkat(&self.root_fd, temp_name.as_str(), AtFlags::empty());
        write_new_file(&self.root_fd, &temp_name, &bytes, 0o600)?;
        renameat(
            &self.root_fd,
            temp_name.as_str(),
            &self.root_fd,
            CURRENT_PROFILE_NAME,
        )
        .map_err(|_| invalid("profile rename failed"))?;
        fsync_preserving_storage(&self.root_fd, "lifecycle root fsync failed")?;
        Ok(())
    }

    /// Cheap removability classification for pruning. Only the manifest
    /// schema separates a quarantined entry from a removable one, and that is
    /// decided by the manifest decode alone; so pruning must not pay the
    /// per-file hash and tree walk of `validate` for a directory it removes
    /// either way. Every non-quarantine outcome (missing, insecure,
    /// unreadable, corrupt, or fully valid) is removable, exactly as the
    /// previous full-validation arms classified it.
    fn is_quarantined_schema(&self, digest: &str) -> bool {
        let Some(dir) = open_child_dir(&self.generations_fd, digest) else {
            return false;
        };
        let Some(manifest_fd) = open_rel_nofollow(&dir, GENERATION_MANIFEST_NAME) else {
            return false;
        };
        // A manifest above the read cap cannot be decoded, so its schema cannot
        // be decided either — and "we could not read it" is not evidence that it
        // is schema 1. This implementation refuses to write one, so an oversized
        // manifest is either corruption or a future release's format, and only
        // one of those is safe to delete. Quarantine it: preserving a generation
        // costs one skipped directory, while deleting a newer release's
        // generation is the forward-compatibility break quarantine exists to
        // prevent. Every other read failure stays removable.
        match rustix::fs::fstat(&manifest_fd) {
            Ok(stat) if stat.st_size as u64 > MAX_MANIFEST_BYTES as u64 => return true,
            Ok(_) => {}
            Err(_) => return false,
        }
        let Ok(bytes) = read_all_fd(&manifest_fd, MAX_MANIFEST_BYTES) else {
            return false;
        };
        matches!(
            decode_with_schema::<GenerationManifest>(&bytes),
            SchemaDecode::UnknownSchema
        )
    }

    /// Prunes complete generations outside the protected set and removes
    /// owned incomplete staging temps. The caller holds `transaction.lock`
    /// and supplies every protected digest: the current profile target,
    /// every coherent lock-held lifecycle digest, and the active candidate.
    /// Quarantined entries (unknown manifest schema, foreign names) are
    /// preserved; a quarantined profile aborts pruning entirely.
    pub fn prune(&self, protected: &BTreeSet<String>) -> Result<PruneReport, GenerationError> {
        let mut protected = protected.clone();
        match self.read_current()? {
            CurrentProfile::Absent => {}
            CurrentProfile::Current(digest) => {
                protected.insert(digest);
            }
            CurrentProfile::Quarantined => return Err(GenerationError::UnsupportedStateSchema),
        }
        let mut report = PruneReport::default();
        // Enumerated through the pinned descriptor, not the canonical pathname:
        // every removal below acts on `generations_fd`, so selecting names from a
        // re-resolved path would let a replacement directory holding chosen names
        // drive deletions inside the retained store.
        let entries = read_dir_names(&self.generations_fd)?;
        for name in entries {
            if let Some(_rest) = name.strip_prefix(STAGING_TEMP_PREFIX) {
                remove_tree(&self.generations_fd, &name)?;
                report.removed_temps += 1;
                continue;
            }
            if !is_canonical_payload_digest(&name) {
                report.quarantined += 1;
                continue;
            }
            if protected.contains(&name) {
                continue;
            }
            // An unprotected generation is referenced by nothing in the
            // protected set, so its file contents cannot change the outcome:
            // only an unknown manifest schema preserves it.
            if self.is_quarantined_schema(&name) {
                report.quarantined += 1;
            } else {
                remove_tree(&self.generations_fd, &name)?;
                report.removed_generations += 1;
            }
        }
        fsync(&self.generations_fd).map_err(|_| invalid("generations fsync failed"))?;
        Ok(report)
    }
}

fn validate_rel_path(rel: &str) -> Result<(), GenerationError> {
    if rel.is_empty() || rel.len() > 4096 {
        return Err(invalid("staged path length is invalid"));
    }
    for component in rel.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(invalid("staged path has an invalid component"));
        }
    }
    if rel == GENERATION_MANIFEST_NAME {
        return Err(invalid("staged path collides with the manifest name"));
    }
    Ok(())
}

/// Copies one source through a no-follow descriptor into an exclusive
/// owner-only single-link output inside `temp_fd`, hashing the same bytes
/// it writes and rechecking source identity afterwards.
fn copy_source_into(temp_fd: &OwnedFd, spec: &SourceSpec) -> Result<ManifestFile, GenerationError> {
    let source_fd = openat(
        rustix::fs::CWD,
        &*spec.source,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(|_| invalid("staging source open failed"))?;
    let before = rustix::fs::fstat(&source_fd).map_err(|_| invalid("source stat failed"))?;
    if (mode_bits(&before) & S_IFMT) != S_IFREG {
        return Err(invalid("staging source is not a regular file"));
    }
    if spec
        .expected_size
        .is_some_and(|size| size != before.st_size as u64)
    {
        return Err(invalid("staging source size differs from payload manifest"));
    }

    // Create intermediate directories, then the exclusive output file.
    let mut dir_path = String::new();
    let components: Vec<&str> = spec.rel_path.split('/').collect();
    for component in &components[..components.len() - 1] {
        if !dir_path.is_empty() {
            dir_path.push('/');
        }
        dir_path.push_str(component);
        let created = match mkdirat(temp_fd, dir_path.as_str(), Mode::from_raw_mode(0o700)) {
            Ok(()) => true,
            Err(rustix::io::Errno::EXIST) => false,
            Err(rustix::io::Errno::NOSPC) | Err(rustix::io::Errno::DQUOT) => {
                return Err(GenerationError::InsufficientStorage)
            }
            Err(_) => return Err(invalid("staging directory creation failed")),
        };
        // The mkdir mode is umask-filtered here too, and an intermediate left
        // without owner execute cannot be traversed — so the destination `openat`
        // below would fail on a nested path like `bin/tool`. Normalized only when
        // this call created the component, so the pathname chmod cannot be
        // redirected through something already sitting at that name.
        if created {
            rustix::fs::chmodat(
                temp_fd,
                dir_path.as_str(),
                Mode::from_raw_mode(0o700),
                AtFlags::empty(),
            )
            .map_err(|_| invalid("staging directory chmod failed"))?;
        }
    }
    let mode: u32 = if spec.executable { 0o700 } else { 0o600 };
    let dest_fd = openat(
        temp_fd,
        spec.rel_path.as_str(),
        OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(raw_mode(mode)),
    )
    .map_err(|e| match e {
        rustix::io::Errno::NOSPC | rustix::io::Errno::DQUOT => GenerationError::InsufficientStorage,
        _ => invalid("staging output creation failed"),
    })?;
    rustix::fs::fchmod(&dest_fd, Mode::from_raw_mode(raw_mode(mode)))
        .map_err(|_| invalid("staging output chmod failed"))?;

    let mut hasher = sha2::Sha256::new();
    let mut reader = std::fs::File::from(
        rustix::io::dup(&source_fd).map_err(|_| invalid("source descriptor dup failed"))?,
    );
    let mut buf = vec![0u8; 128 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|_| invalid("staging source read failed"))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > before.st_size as u64 {
            return Err(invalid("staging source grew during copy"));
        }
        hasher.update(&buf[..n]);
        write_all_fd(&dest_fd, &buf[..n]).map_err(|e| {
            if is_storage_exhausted(&e) {
                GenerationError::InsufficientStorage
            } else {
                invalid("staging output write failed")
            }
        })?;
    }
    fsync_preserving_storage(&dest_fd, "staging output fsync failed")?;

    // Bounded before/after source identity check: same object, same size,
    // same mtime. Source link count never substitutes for byte validation;
    // the hash above consumed the same descriptor the copy did.
    let after = rustix::fs::fstat(&source_fd).map_err(|_| invalid("source stat failed"))?;
    #[allow(clippy::unnecessary_cast)]
    let same_identity = before.st_dev as u64 == after.st_dev as u64
        && before.st_ino as u64 == after.st_ino as u64
        && before.st_size == after.st_size
        && before.st_mtime == after.st_mtime
        && before.st_mtime_nsec == after.st_mtime_nsec;
    if !same_identity || total != before.st_size as u64 {
        return Err(invalid("staging source mutated during copy"));
    }
    let dest_stat = rustix::fs::fstat(&dest_fd).map_err(|_| invalid("output stat failed"))?;
    if dest_stat.st_nlink != 1 || dest_stat.st_uid != owner_uid() {
        return Err(invalid("staging output is not owner-only single-link"));
    }
    let sha256 = hex(&hasher.finalize());
    if spec
        .expected_sha256
        .as_deref()
        .is_some_and(|expected| expected != sha256)
    {
        return Err(invalid("staging source hash differs from payload manifest"));
    }
    Ok(ManifestFile {
        path: spec.rel_path.clone(),
        mode,
        size: total,
        sha256,
    })
}

fn write_new_file(
    dir: &OwnedFd,
    name: &str,
    bytes: &[u8],
    mode: u32,
) -> Result<(), GenerationError> {
    let fd = openat(
        dir,
        name,
        OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(raw_mode(mode)),
    )
    .map_err(|e| match e {
        rustix::io::Errno::NOSPC | rustix::io::Errno::DQUOT => GenerationError::InsufficientStorage,
        _ => invalid("file creation failed"),
    })?;
    rustix::fs::fchmod(&fd, Mode::from_raw_mode(raw_mode(mode)))
        .map_err(|_| invalid("file chmod failed"))?;
    write_all_fd(&fd, bytes).map_err(|e| {
        if is_storage_exhausted(&e) {
            GenerationError::InsufficientStorage
        } else {
            invalid("file write failed")
        }
    })?;
    fsync_preserving_storage(&fd, "file fsync failed")?;
    Ok(())
}

/// Atomic same-filesystem directory exchange. Rustix maps `EXCHANGE` to
/// Linux `renameat2(RENAME_EXCHANGE)` and macOS
/// `renameatx_np(RENAME_SWAP)`; unsupported platforms fail closed.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn exchange_dirs(dir: &OwnedFd, a: &str, b: &str) -> Result<(), GenerationError> {
    rustix::fs::renameat_with(dir, a, dir, b, rustix::fs::RenameFlags::EXCHANGE)
        .map_err(|_| invalid("atomic digest-target exchange failed"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn exchange_dirs(_dir: &OwnedFd, _a: &str, _b: &str) -> Result<(), GenerationError> {
    Err(invalid(
        "atomic digest-target exchange is unsupported on this platform",
    ))
}

/// Renames `from` to `to` inside `dir` only when `to` is unoccupied.
/// `Ok(true)` means the rename happened; `Ok(false)` means the target is
/// occupied and the caller owns the occupied-target decision.
///
/// Linux takes `RENAME_NOREPLACE`, which makes the emptiness of an occupying
/// directory irrelevant. Filesystems that reject `renameat2` flags, and
/// platforms without them, fall back to checking occupancy first; that check
/// is sound here because every mutating entry point holds `transaction.lock`,
/// so no other participant in the trust model creates the target concurrently.
fn rename_no_replace(dir: &OwnedFd, from: &str, to: &str) -> Result<bool, GenerationError> {
    #[cfg(target_os = "linux")]
    {
        match rustix::fs::renameat_with(dir, from, dir, to, rustix::fs::RenameFlags::NOREPLACE) {
            Ok(()) => return Ok(true),
            Err(rustix::io::Errno::EXIST) | Err(rustix::io::Errno::NOTEMPTY) => return Ok(false),
            Err(rustix::io::Errno::NOSPC) => return Err(GenerationError::InsufficientStorage),
            // No renameat2 flag support on this kernel or filesystem: fall
            // through to the portable occupancy check.
            Err(rustix::io::Errno::INVAL)
            | Err(rustix::io::Errno::NOSYS)
            | Err(rustix::io::Errno::OPNOTSUPP) => {}
            Err(_) => return Err(invalid("generation rename failed")),
        }
    }
    match rustix::fs::statat(dir, to, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(_) => return Ok(false),
        Err(rustix::io::Errno::NOENT) => {}
        Err(_) => return Err(invalid("generation target stat failed")),
    }
    match renameat(dir, from, dir, to) {
        Ok(()) => Ok(true),
        Err(rustix::io::Errno::EXIST) | Err(rustix::io::Errno::NOTEMPTY) => Ok(false),
        Err(rustix::io::Errno::NOSPC) => Err(GenerationError::InsufficientStorage),
        Err(_) => Err(invalid("generation rename failed")),
    }
}

/// The lifecycle-root trust predicate: a directory we own whose ancestry
/// cannot be replaced under us. Shared by the mutating and probe opens so a
/// single definition governs both entry points.
fn validate_lifecycle_root_fd(fd: &OwnedFd, path: &Path) -> Result<(), GenerationError> {
    let stat = rustix::fs::fstat(fd).map_err(|e| io_err("fstat_lifecycle_root", path, e))?;
    let mode = mode_bits(&stat);
    if (mode & S_IFMT) != S_IFDIR || stat.st_uid != owner_uid() {
        return Err(invalid("lifecycle root failed security checks"));
    }
    if !is_safe_ancestor(&stat) {
        return Err(invalid("lifecycle root failed security checks"));
    }
    Ok(())
}

fn open_child_dir(parent: &OwnedFd, name: &str) -> Option<OwnedFd> {
    let fd = open_child_dir_for_removal(parent, name)?;
    let stat = rustix::fs::fstat(&fd).ok()?;
    if (mode_bits(&stat) & 0o077) != 0 {
        return None;
    }
    Some(fd)
}

/// [`open_child_dir`] that separates absence from insecurity: `Ok(None)` only
/// when the name does not exist, `Err` when something is there but fails the
/// directory trust predicate.
fn open_child_dir_existing(
    parent: &OwnedFd,
    name: &str,
) -> Result<Option<OwnedFd>, GenerationError> {
    let fd = match openat(
        parent,
        name,
        OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(_) => return Err(invalid("generations directory failed security checks")),
    };
    let stat = rustix::fs::fstat(&fd).map_err(|_| invalid("generations directory stat failed"))?;
    let mode = mode_bits(&stat);
    if (mode & S_IFMT) != S_IFDIR || stat.st_uid != owner_uid() || (mode & 0o077) != 0 {
        return Err(invalid("generations directory failed security checks"));
    }
    Ok(Some(fd))
}

fn open_child_dir_for_removal(parent: &OwnedFd, name: &str) -> Option<OwnedFd> {
    let fd = openat(
        parent,
        name,
        OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .ok()?;
    let stat = rustix::fs::fstat(&fd).ok()?;
    let mode = mode_bits(&stat);
    if (mode & S_IFMT) != S_IFDIR || stat.st_uid != owner_uid() {
        return None;
    }
    Some(fd)
}

fn walk_generation_tree(
    dir: &OwnedFd,
    prefix: &str,
    found: &mut BTreeSet<String>,
) -> Result<(), GenerationError> {
    let names = read_dir_names(dir)?;
    for name in names {
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        // Explicitly non-following metadata: the entry's own type decides,
        // never its target's.
        let stat = rustix::fs::statat(dir, name.as_str(), AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|_| invalid("generation entry stat failed"))?;
        match mode_bits(&stat) & S_IFMT {
            S_IFLNK => return Err(invalid("generation contains a symlink")),
            S_IFDIR => {
                let child = open_child_dir(dir, &name)
                    .ok_or_else(|| invalid("generation subdirectory failed security checks"))?;
                walk_generation_tree(&child, &rel, found)?;
            }
            S_IFREG => {
                found.insert(rel);
            }
            _ => return Err(invalid("generation contains a non-regular entry")),
        }
    }
    Ok(())
}

fn remove_tree(parent: &OwnedFd, name: &str) -> Result<(), GenerationError> {
    match unlinkat(parent, name, AtFlags::empty()) {
        Ok(()) => return Ok(()),
        Err(rustix::io::Errno::NOENT) => return Ok(()),
        Err(rustix::io::Errno::ISDIR) => {}
        // Linux reports EPERM for unlink-on-directory in some filesystems.
        Err(rustix::io::Errno::PERM) => {}
        Err(_) => return Err(invalid("entry removal failed")),
    }
    let Some(dir) = open_child_dir_for_removal(parent, name) else {
        return Err(invalid("removal target failed security checks"));
    };
    let names = read_dir_names(&dir)?;
    for child in names {
        remove_tree(&dir, &child)?;
    }
    unlinkat(parent, name, AtFlags::REMOVEDIR).map_err(|_| invalid("directory removal failed"))?;
    Ok(())
}

/// Lists the entry names of an already-validated open directory.
///
/// `fdopendir` enumerates the open directory description itself, so the listing
/// cannot be redirected by a pathname replacement after validation, and unlike
/// a `/proc/self/fd` round-trip it needs no procfs — the lifecycle root's own
/// validation path runs on every supported platform, not only Linux. `.` and
/// `..` are dropped: they are artifacts of the directory representation, not
/// entries a caller can act on.
fn read_dir_names(dir: &OwnedFd) -> Result<Vec<String>, GenerationError> {
    let borrowed = rustix::fs::Dir::read_from(dir).map_err(|_| invalid("directory open failed"))?;
    let mut names = Vec::new();
    for entry in borrowed {
        let entry = entry.map_err(|_| invalid("directory listing failed"))?;
        let raw = entry.file_name().to_bytes();
        if raw == b"." || raw == b".." {
            continue;
        }
        let name = std::str::from_utf8(raw)
            .map_err(|_| invalid("directory entry name is not unicode"))?
            .to_owned();
        names.push(name);
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn store_at(root: &Path) -> GenerationStore {
        GenerationStore::open(Some(root)).expect("open store")
    }

    #[test]
    fn a_generation_staged_before_the_source_digest_field_still_decodes() {
        // Schema 1 shipped without `source_payload_manifest_sha256`, and the schema
        // number did not change when it was added. Decoding a retained predecessor
        // as corrupt would make the first no-`--payload-dir` start after an upgrade
        // report `native_payload_invalid` for a payload that is perfectly intact.
        let predecessor = br#"{"schema":1,"target":"linux-x64-gnu","release_contract_sha256":"aa","inputs_lock_sha256":"bb","files":[]}"#;
        let decoded = match decode_with_schema::<GenerationManifest>(predecessor) {
            SchemaDecode::Valid(manifest) => manifest,
            SchemaDecode::UnknownSchema => panic!("schema 1 must stay readable"),
            SchemaDecode::Malformed => {
                panic!("a predecessor generation is not corrupt merely for predating a field")
            }
        };
        assert_eq!(decoded.source_payload_manifest_sha256, None);
        // Absence is not serialized back, so a predecessor manifest round-trips to
        // its own bytes and keeps the digest that names its directory.
        assert_eq!(decoded.canonical_bytes(), predecessor);
    }

    fn meta() -> StageMeta {
        StageMeta {
            target: "linux-x64-gnu".to_owned(),
            release_contract_sha256: "a".repeat(64),
            inputs_lock_sha256: "b".repeat(64),
            source_payload_manifest_sha256: "unqualified-dev-manifest".to_owned(),
        }
    }

    fn write_source(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("write source");
        path
    }

    fn sources_in(dir: &Path) -> Vec<SourceSpec> {
        vec![
            SourceSpec {
                rel_path: "bin/ck-mc-host".to_owned(),
                source: write_source(dir, "launcher", b"#binary-bytes"),
                executable: true,
                expected_size: None,
                expected_sha256: None,
            },
            SourceSpec {
                rel_path: "notices.txt".to_owned(),
                source: write_source(dir, "notices", b"notice text"),
                executable: false,
                expected_size: None,
                expected_sha256: None,
            },
        ]
    }

    fn stage_default(store: &GenerationStore, src: &Path) -> String {
        store
            .stage_and_promote(&sources_in(src), &meta(), &BTreeSet::new())
            .expect("stage")
    }

    #[test]
    fn stage_validate_and_read_current_roundtrip() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());

        assert_eq!(store.read_current().expect("read"), CurrentProfile::Absent);
        let digest = stage_default(&store, src.path());
        assert!(is_canonical_payload_digest(&digest));
        assert_eq!(
            store.read_current().expect("read"),
            CurrentProfile::Current(digest.clone())
        );

        let validated = store.validate(&digest).expect("validate");
        assert_eq!(validated.manifest.files.len(), 2);
        assert_eq!(validated.manifest.digest(), digest);
        let fd = validated
            .open_verified_file("bin/ck-mc-host")
            .expect("verified open");
        drop(fd);

        // Staged outputs are owner-only and single-link.
        let bin = store
            .root()
            .join(GENERATIONS_DIR_NAME)
            .join(&digest)
            .join("bin/ck-mc-host");
        let meta = std::fs::metadata(&bin).expect("stat");
        assert_eq!(meta.permissions().mode() & 0o7777, 0o700);

        // Restaging the identical sources converges on the same digest.
        let again = stage_default(&store, src.path());
        assert_eq!(again, digest);
    }

    #[test]
    fn capacity_accounting_is_checked_and_exact() {
        // Exact boundary: available == required + reserve passes.
        let required = 1024 * 1024 * 1024u64;
        let reserve = (required.div_ceil(10)).max(CAPACITY_RESERVE_FLOOR_BYTES);
        assert_eq!(capacity_satisfied(required + reserve, required), Some(true));
        // One byte below fails.
        assert_eq!(
            capacity_satisfied(required + reserve - 1, required),
            Some(false)
        );
        // The 256 MiB floor dominates small requirements.
        assert_eq!(
            capacity_satisfied(CAPACITY_RESERVE_FLOOR_BYTES + 4096 - 1, 4096),
            Some(false)
        );
        // Checked arithmetic: overflow is an error, not a pass.
        assert_eq!(capacity_satisfied(u64::MAX, u64::MAX - 1), None);
        assert!(required_stage_bytes(&[u64::MAX]).is_none());
        assert!(required_stage_bytes(&[u64::MAX / 2, u64::MAX / 2]).is_none());
        let small = required_stage_bytes(&[1, 4096, 4097]).expect("small sums");
        assert_eq!(small, CAPACITY_FIXED_OVERHEAD_BYTES + 4096 + 4096 + 8192);
    }

    #[test]
    fn validation_rejects_every_tampered_shape() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let digest = stage_default(&store, src.path());
        let gen_dir = store.root().join(GENERATIONS_DIR_NAME).join(&digest);

        let expect_invalid = |store: &GenerationStore| {
            assert!(matches!(
                store.validate(&digest),
                Err(GenerationError::NativePayloadInvalid { .. })
            ));
        };

        // Changed bytes (same length).
        let bin = gen_dir.join("bin/ck-mc-host");
        let saved = std::fs::read(&bin).expect("read");
        let mut flipped = saved.clone();
        flipped[0] ^= 1;
        std::fs::write(&bin, &flipped).expect("write");
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).expect("mode");
        expect_invalid(&store);
        std::fs::write(&bin, &saved).expect("restore");
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).expect("mode");
        store
            .validate(&digest)
            .expect("restored generation validates");

        // Extra unlisted file.
        std::fs::write(gen_dir.join("extra"), b"x").expect("extra");
        expect_invalid(&store);
        std::fs::remove_file(gen_dir.join("extra")).expect("remove extra");

        // Loose mode.
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).expect("mode");
        expect_invalid(&store);
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).expect("mode");

        // Hard-link count above one.
        let alias = gen_dir.join("alias-link");
        std::fs::hard_link(&bin, &alias).expect("link");
        expect_invalid(&store);
        std::fs::remove_file(&alias).expect("unlink");

        // Symlink substitution.
        std::fs::remove_file(gen_dir.join("notices.txt")).expect("remove");
        std::os::unix::fs::symlink(&bin, gen_dir.join("notices.txt")).expect("symlink");
        expect_invalid(&store);

        // Missing file.
        std::fs::remove_file(gen_dir.join("notices.txt")).expect("remove symlink");
        expect_invalid(&store);
    }

    #[test]
    fn unknown_schemas_are_quarantined_and_block_mutation() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let digest = stage_default(&store, src.path());
        let gen_dir = store.root().join(GENERATIONS_DIR_NAME).join(&digest);

        let manifest_path = gen_dir.join(GENERATION_MANIFEST_NAME);
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).expect("read")).expect("json");
        value["schema"] = 7.into();
        let quarantined_bytes = serde_json::to_vec(&value).expect("encode");
        std::fs::write(&manifest_path, &quarantined_bytes).expect("write");
        assert!(matches!(
            store.validate(&digest),
            Err(GenerationError::UnsupportedStateSchema)
        ));
        let successor = vec![SourceSpec {
            rel_path: "bin/ck-mc-host".to_owned(),
            source: write_source(src.path(), "launcher-b", b"#successor-binary"),
            executable: true,
            expected_size: None,
            expected_sha256: None,
        }];
        store
            .stage_and_promote(&successor, &meta(), &BTreeSet::new())
            .expect("stage successor");
        let report = store.prune(&BTreeSet::new()).expect("prune");
        assert_eq!(report.removed_generations, 0);
        assert_eq!(report.quarantined, 1);
        assert_eq!(
            std::fs::read(&manifest_path).expect("reread"),
            quarantined_bytes,
            "quarantined bytes must be preserved exactly"
        );

        // Unknown profile schema: read as quarantined; staging and pruning
        // abort without touching it.
        let profile_path = store.root().join(CURRENT_PROFILE_NAME);
        let profile_bytes = br#"{"schema":9,"future":"state"}"#.to_vec();
        std::fs::write(&profile_path, &profile_bytes).expect("write profile");
        assert_eq!(
            store.read_current().expect("read"),
            CurrentProfile::Quarantined
        );
        assert!(matches!(
            store.stage_and_promote(&sources_in(src.path()), &meta(), &BTreeSet::new()),
            Err(GenerationError::UnsupportedStateSchema)
        ));
        assert!(matches!(
            store.prune(&BTreeSet::new()),
            Err(GenerationError::UnsupportedStateSchema)
        ));
        assert_eq!(
            std::fs::read(&profile_path).expect("reread profile"),
            profile_bytes
        );
    }

    #[test]
    fn pruning_protects_current_lockheld_and_candidate_digests() {
        let root = tempfile::tempdir().expect("root");
        let src_a = tempfile::tempdir().expect("src a");
        let src_b = tempfile::tempdir().expect("src b");
        let store = store_at(root.path());

        // Stage A then B: the profile names B, A becomes unreferenced.
        let digest_a = stage_default(&store, src_a.path());
        let spec_b = vec![SourceSpec {
            rel_path: "bin/ck-mc-host".to_owned(),
            source: write_source(src_b.path(), "launcher", b"#different-binary"),
            executable: true,
            expected_size: None,
            expected_sha256: None,
        }];
        let digest_b = store
            .stage_and_promote(&spec_b, &meta(), &BTreeSet::new())
            .expect("stage b");
        assert_ne!(digest_a, digest_b);

        // An incomplete temp and a foreign name coexist.
        std::fs::create_dir(
            store
                .root()
                .join(GENERATIONS_DIR_NAME)
                .join("tmp-deadbeef00000000"),
        )
        .expect("temp");
        std::fs::create_dir(store.root().join(GENERATIONS_DIR_NAME).join("not-a-digest"))
            .expect("foreign");

        // Protecting A (a coherent lock-held lifecycle digest) preserves it.
        let mut protected = BTreeSet::new();
        protected.insert(digest_a.clone());
        let report = store.prune(&protected).expect("prune");
        assert_eq!(report.removed_generations, 0);
        assert_eq!(report.removed_temps, 1);
        assert_eq!(report.quarantined, 1);
        assert!(store.validate(&digest_a).is_ok());
        assert!(store.validate(&digest_b).is_ok());

        // Without protection, A is pruned while current B survives.
        let report = store.prune(&BTreeSet::new()).expect("prune again");
        assert_eq!(report.removed_generations, 1);
        assert!(store.validate(&digest_a).is_err());
        assert!(store.validate(&digest_b).is_ok());
        assert_eq!(
            store.read_current().expect("read"),
            CurrentProfile::Current(digest_b)
        );
        assert!(store
            .root()
            .join(GENERATIONS_DIR_NAME)
            .join("not-a-digest")
            .exists());
    }

    #[test]
    fn same_digest_corrupt_target_is_repaired_only_by_validated_exchange() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let digest = stage_default(&store, src.path());
        let gen_dir = store.root().join(GENERATIONS_DIR_NAME).join(&digest);

        // Corrupt the staged binary in place: the digest name now holds an
        // invalid occupant.
        let bin = gen_dir.join("bin/ck-mc-host");
        let mut bytes = std::fs::read(&bin).expect("read");
        bytes[0] ^= 1;
        std::fs::write(&bin, &bytes).expect("corrupt");
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).expect("mode");
        assert!(store.validate(&digest).is_err());

        // A protected corrupt target must not be exchanged.
        let mut protected = BTreeSet::new();
        protected.insert(digest.clone());
        assert!(matches!(
            store.stage_and_promote(&sources_in(src.path()), &meta(), &protected),
            Err(GenerationError::NativePayloadInvalid { .. })
        ));
        assert!(store.validate(&digest).is_err(), "target left untouched");

        // Unprotected: restaging the same digest exchanges atomically and
        // revalidates before deleting the corrupt orphan.
        let repaired = store
            .stage_and_promote(&sources_in(src.path()), &meta(), &BTreeSet::new())
            .expect("repair");
        assert_eq!(repaired, digest);
        store.validate(&digest).expect("repaired target validates");
        // The exchanged orphan temp is gone.
        let leftovers: Vec<_> = std::fs::read_dir(store.root().join(GENERATIONS_DIR_NAME))
            .expect("dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(STAGING_TEMP_PREFIX)
            })
            .collect();
        assert!(leftovers.is_empty(), "no staging temp survives repair");
    }

    #[test]
    fn interrupted_staging_leaves_the_old_profile_complete() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let digest = stage_default(&store, src.path());

        // A crashed later staging attempt leaves only a temp directory; the
        // profile still names the complete old generation.
        let temp = store
            .root()
            .join(GENERATIONS_DIR_NAME)
            .join("tmp-0123456789abcdef");
        std::fs::create_dir(&temp).expect("temp");
        std::fs::write(temp.join("partial"), b"torn").expect("partial");
        assert_eq!(
            store.read_current().expect("read"),
            CurrentProfile::Current(digest.clone())
        );
        store.validate(&digest).expect("old generation is complete");

        // A leftover profile temp is inert: reads keep returning the
        // committed profile.
        std::fs::write(
            store.root().join(".current-profile.json.99999.tmp"),
            b"{\"torn\":true}",
        )
        .expect("profile temp");
        assert_eq!(
            store.read_current().expect("read"),
            CurrentProfile::Current(digest)
        );
    }

    #[test]
    fn sources_are_descriptor_validated_and_hardlinks_stage_independent_bytes() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());

        // A symlink source is rejected before any temp mutation.
        let real = write_source(src.path(), "real", b"bytes");
        let link = src.path().join("sym");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        let symlink_spec = vec![SourceSpec {
            rel_path: "bin/x".to_owned(),
            source: link,
            executable: true,
            expected_size: None,
            expected_sha256: None,
        }];
        assert!(matches!(
            store.stage_and_promote(&symlink_spec, &meta(), &BTreeSet::new()),
            Err(GenerationError::NativePayloadInvalid { .. })
        ));

        // Parent traversal in a staged path is rejected.
        let traversal = vec![SourceSpec {
            rel_path: "../escape".to_owned(),
            source: real.clone(),
            executable: false,
            expected_size: None,
            expected_sha256: None,
        }];
        assert!(store
            .stage_and_promote(&traversal, &meta(), &BTreeSet::new())
            .is_err());

        // A package-cache-style hard link is a valid source, and the staged
        // output is an independent single-link copy.
        let cache_link = src.path().join("cache-hardlink");
        std::fs::hard_link(&real, &cache_link).expect("hardlink");
        let spec = vec![SourceSpec {
            rel_path: "bin/x".to_owned(),
            source: cache_link,
            executable: true,
            expected_size: None,
            expected_sha256: None,
        }];
        let digest = store
            .stage_and_promote(&spec, &meta(), &BTreeSet::new())
            .expect("stage from hardlink");
        let staged = store
            .root()
            .join(GENERATIONS_DIR_NAME)
            .join(&digest)
            .join("bin/x");
        let staged_meta = std::fs::metadata(&staged).expect("stat");
        use std::os::unix::fs::MetadataExt;
        assert_eq!(staged_meta.nlink(), 1);
        // Mutating the original cache bytes cannot reach the staged copy.
        std::fs::write(&real, b"mutated-after-staging").expect("mutate");
        store
            .validate(&digest)
            .expect("staged bytes are independent");
    }

    /// `verify_file_against_entry` hashes a `dup` of the descriptor it returns,
    /// and a dup shares the open file description's offset, so without an
    /// explicit rewind every caller would read zero bytes from a file the
    /// manifest says is non-empty.
    #[test]
    fn verified_open_returns_a_readable_descriptor() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let digest = stage_default(&store, src.path());
        let validated = store.validate(&digest).expect("validate");

        let fd = validated
            .open_verified_file("bin/ck-mc-host")
            .expect("verified open");
        let mut file = std::fs::File::from(fd);
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).expect("read verified file");
        assert_eq!(bytes, b"#binary-bytes");
    }

    /// A manifest whose persisted bytes are not the canonical serialization of
    /// the decoded value would give one logical manifest two generation
    /// identities: the directory name hashes the raw bytes while
    /// `manifest.digest()` hashes the canonical form.
    #[test]
    fn noncanonically_encoded_manifests_are_rejected() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let digest = stage_default(&store, src.path());
        let dir = store.root().join(GENERATIONS_DIR_NAME).join(&digest);

        // Reserialize through a Value, which sorts keys and so reorders them
        // away from the struct's declaration order, then rename the generation
        // to the hash of those bytes so the digest binding still holds.
        let canonical = std::fs::read(dir.join(GENERATION_MANIFEST_NAME)).expect("manifest");
        let value: serde_json::Value = serde_json::from_slice(&canonical).expect("decode");
        let reordered = serde_json::to_vec(&value).expect("reencode");
        assert_ne!(reordered, canonical, "key order must actually differ");
        let renamed = hex(&sha2::Sha256::digest(&reordered));
        std::fs::write(dir.join(GENERATION_MANIFEST_NAME), &reordered).expect("write");
        let target = store.root().join(GENERATIONS_DIR_NAME).join(&renamed);
        std::fs::rename(&dir, &target).expect("rename to the new byte hash");

        let Err(err) = store.validate(&renamed) else {
            panic!("a noncanonically encoded manifest must be refused");
        };
        assert!(matches!(err, GenerationError::NativePayloadInvalid { .. }));
    }

    /// `renameat` replaces an existing empty directory, so a protected digest
    /// corrupted into an empty directory must be refused before the rename, not
    /// after it.
    #[test]
    fn an_empty_protected_digest_target_is_never_replaced() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let digest = stage_default(&store, src.path());
        let dir = store.root().join(GENERATIONS_DIR_NAME).join(&digest);

        // Corrupt the protected occupant into an empty directory.
        std::fs::remove_dir_all(&dir).expect("remove");
        std::fs::create_dir(&dir).expect("recreate empty");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("mode");

        let protected: BTreeSet<String> = [digest.clone()].into_iter().collect();
        let err = store
            .stage_and_promote(&sources_in(src.path()), &meta(), &protected)
            .expect_err("a protected corrupt occupant is untouched");
        assert!(matches!(err, GenerationError::NativePayloadInvalid { .. }));
        assert!(dir.is_dir(), "the protected occupant must still be there");
        assert_eq!(
            std::fs::read_dir(&dir).expect("read").count(),
            0,
            "the occupant is preserved as found, not repaired"
        );
    }

    /// Every directory a staging run creates entries in is fsynced, not just the
    /// staging root, so a crash after promotion cannot recover a current
    /// generation whose nested files are missing.
    #[test]
    fn nested_staged_directories_survive_validation() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let specs = vec![
            SourceSpec {
                rel_path: "a/b/c/deep".to_owned(),
                source: write_source(src.path(), "deep", b"deep bytes"),
                executable: false,
                expected_size: None,
                expected_sha256: None,
            },
            SourceSpec {
                rel_path: "a/b/sibling".to_owned(),
                source: write_source(src.path(), "sibling", b"sibling bytes"),
                executable: false,
                expected_size: None,
                expected_sha256: None,
            },
        ];
        let digest = store
            .stage_and_promote(&specs, &meta(), &BTreeSet::new())
            .expect("stage nested");
        let validated = store.validate(&digest).expect("validate nested");
        assert_eq!(validated.manifest.files.len(), 2);
    }

    /// A symlink inside a generation is refused by the entry's own type, never
    /// by its target's: a link to an empty directory must not be able to pass
    /// the walk as an empty subtree.
    #[test]
    fn a_symlink_to_a_directory_fails_validation() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let digest = stage_default(&store, src.path());
        let dir = store.root().join(GENERATIONS_DIR_NAME).join(&digest);
        let empty = src.path().join("empty-target");
        std::fs::create_dir(&empty).expect("empty target");
        std::os::unix::fs::symlink(&empty, dir.join("linked")).expect("symlink");

        let Err(err) = store.validate(&digest) else {
            panic!("a symlink inside a generation must be refused");
        };
        assert!(matches!(err, GenerationError::NativePayloadInvalid { .. }));
    }

    /// Absence and insecurity are distinct probe outcomes: an existing but
    /// untrusted store must not be reported as "nothing staged yet", which
    /// prescribes installing a payload instead of investigating the state.
    #[test]
    fn probe_separates_an_absent_store_from_an_insecure_one() {
        let root = tempfile::tempdir().expect("root");
        assert!(
            GenerationStore::open_probe(Some(root.path()))
                .expect("absent probe")
                .is_none(),
            "an uncreated store is absence, not a trust failure"
        );

        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        stage_default(&store, src.path());
        let generations = store.root().join(GENERATIONS_DIR_NAME);
        std::fs::set_permissions(&generations, std::fs::Permissions::from_mode(0o707))
            .expect("widen mode");

        let Err(err) = GenerationStore::open_probe(Some(root.path())) else {
            panic!("an insecure generations directory must fail closed");
        };
        assert!(matches!(err, GenerationError::NativePayloadInvalid { .. }));
    }

    /// Opening a store whose `generations` name is a symlink must fail closed
    /// without touching the link's target. The umask normalization is by
    /// pathname, so it may only run when `mkdirat` proved it created the entry.
    #[test]
    fn a_symlinked_generations_name_is_rejected_without_mutating_its_target() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        let victim = outside.path().join("victim");
        std::fs::create_dir(&victim).expect("victim");
        std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o755)).expect("mode");

        let lifecycle = root.path().join("cortexkit").join("lifecycle");
        std::fs::create_dir_all(&lifecycle).expect("lifecycle root");
        std::os::unix::fs::symlink(&victim, lifecycle.join(GENERATIONS_DIR_NAME)).expect("symlink");

        let Err(err) = GenerationStore::open(Some(root.path())) else {
            panic!("a symlinked generations name must fail closed");
        };
        assert!(matches!(err, GenerationError::NativePayloadInvalid { .. }));
        assert_eq!(
            std::fs::metadata(&victim)
                .expect("victim still there")
                .permissions()
                .mode()
                & 0o777,
            0o755,
            "the symlink target's mode must be untouched"
        );
    }

    /// An unknown manifest schema at an occupied digest is quarantined, not
    /// corrupt: promotion must abandon the mutation rather than exchange the
    /// directory away and delete it.
    #[test]
    fn a_quarantined_digest_occupant_is_never_repaired() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let digest = stage_default(&store, src.path());
        let manifest = store
            .root()
            .join(GENERATIONS_DIR_NAME)
            .join(&digest)
            .join(GENERATION_MANIFEST_NAME);

        // Schema 2 decodes as an unknown schema: preserved, never repaired.
        let quarantined = br#"{"schema":2,"unknown_future_field":true}"#;
        std::fs::write(&manifest, quarantined).expect("quarantine the occupant");

        // Staging the same sources produces the same digest, so promotion lands
        // on the quarantined occupant. It is deliberately not in `protected`:
        // the quarantine rule alone must stop the repair.
        let err = match store.stage_and_promote(&sources_in(src.path()), &meta(), &BTreeSet::new())
        {
            Ok(_) => panic!("a quarantined occupant must not be repaired"),
            Err(err) => err,
        };
        assert!(matches!(err, GenerationError::UnsupportedStateSchema));
        assert_eq!(
            std::fs::read(&manifest).expect("occupant still there"),
            quarantined,
            "quarantined bytes must be preserved exactly"
        );
    }

    /// A manifest above the read cap cannot have its schema decided, so pruning
    /// must not treat it as removable corruption: it may be a newer release's
    /// generation, and deleting that is the forward-compatibility break
    /// quarantine exists to prevent.
    #[test]
    fn an_oversized_manifest_is_quarantined_rather_than_pruned() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let digest = stage_default(&store, src.path());
        let manifest_path = store
            .root()
            .join(GENERATIONS_DIR_NAME)
            .join(&digest)
            .join(GENERATION_MANIFEST_NAME);

        // Unknown schema plus padding past MAX_MANIFEST_BYTES, so the capped
        // read fails before the schema can be decoded.
        let mut oversized = br#"{"schema":2,"unknown_future_field":true,"pad":""#.to_vec();
        oversized.resize(oversized.len() + MAX_MANIFEST_BYTES, b'x');
        oversized.extend_from_slice(br#""}"#);
        assert!(oversized.len() > MAX_MANIFEST_BYTES);
        std::fs::write(&manifest_path, &oversized).expect("write oversized manifest");

        // Promote a successor so the oversized generation is no longer the
        // current profile target, leaving the quarantine rule as the only thing
        // that can preserve it.
        let successor = vec![SourceSpec {
            rel_path: "bin/ck-mc-host".to_owned(),
            source: write_source(src.path(), "launcher-successor", b"#successor-binary"),
            executable: true,
            expected_size: None,
            expected_sha256: None,
        }];
        store
            .stage_and_promote(&successor, &meta(), &BTreeSet::new())
            .expect("stage successor");

        let report = store.prune(&BTreeSet::new()).expect("prune");
        assert_eq!(report.removed_generations, 0);
        assert_eq!(report.quarantined, 1);
        assert_eq!(
            std::fs::read(&manifest_path).expect("manifest still there"),
            oversized,
            "an undecidable manifest must be preserved byte-for-byte"
        );
    }
}
