//! The store content-addresses generations and atomically selects one current profile.
//!
//! The store uses `${dataDir}/cortexkit/lifecycle/` for its persisted state.
//!
//! ```text
//! lifecycle/
//!   generations/<payload-manifest-digest>/   staged payload files + manifest.json
//!   generations/tmp-<random>/                incomplete staging temps
//!   current-profile.json                     {"schema":1,"current":"<digest>"}
//! ```
//!
//! The generation name is the SHA-256 digest of canonical manifest bytes.
//! The manifest commits the target tuple and the U8 release-contract digest.
//! The manifest commits the U9 input-lock digest and every file's path, mode, size, and hash.
//! Callers must hold `transaction.lock` before mutating the store.
//! This module validates persisted bytes but does not serialize mutations.

use std::collections::BTreeSet;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use rustix::fd::OwnedFd;
use rustix::fs::{fsync, mkdirat, openat, renameat, unlinkat, AtFlags, Mode, OFlags};
use sha2::Digest;

use crate::file_mode::raw_mode;
use crate::instance::{
    hex, io_err, is_safe_ancestor, is_secure_regular, mode_bits, open_secure_dir_existing,
    read_all_fd, secure_runtime_dir, write_all_fd, InstanceError, S_IFDIR, S_IFLNK, S_IFMT,
    S_IFREG,
};
use crate::lifecycle::{is_canonical_payload_digest, lifecycle_dir_path};

pub const GENERATIONS_DIR_NAME: &str = "generations";

pub const CURRENT_PROFILE_NAME: &str = "current-profile.json";

/// The `files` array excludes `manifest.json` because its bytes produce the generation digest.
pub const GENERATION_MANIFEST_NAME: &str = "manifest.json";

/// Pruning removes incomplete staging directories whose names begin `tmp-`.
pub const STAGING_TEMP_PREFIX: &str = "tmp-";

/// Manifest and lifecycle-evidence readers each cap input at 1 MiB.
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

/// Capacity preflight reserves 1 MiB for metadata that coexists until rename.
const CAPACITY_FIXED_OVERHEAD_BYTES: u64 = 1024 * 1024;

/// Capacity preflight reserves `max(256 MiB, ceil(required * 10%))`.
const CAPACITY_RESERVE_FLOOR_BYTES: u64 = 256 * 1024 * 1024;

/// Each `GenerationError` variant maps to exactly one closed v1 reason.
/// Callers must not derive externally visible classifications finer than the bounded static detail.
#[derive(Debug)]
pub enum GenerationError {
    /// `InsufficientStorage` leaves trusted selectors unchanged and removes the owned temp after preflight failure or post-preflight `ENOSPC`.
    InsufficientStorage,
    /// `NativePayloadInvalid` leaves `current` unchanged and selects no other generation after validation, staging-identity, exchange-repair, or checked-arithmetic failure.
    NativePayloadInvalid {
        detail: &'static str,
    },
    /// `UnsupportedStateSchema` preserves and quarantines a profile or manifest with an unknown schema, then aborts the requested mutation or selection.
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

/// The helper preserves storage-exhaustion classification for `fsync` failures.
///
/// Delayed-allocation filesystems can report exhaustion from `fsync` because they assign blocks at writeback rather than from `write`.
fn fsync_preserving_storage<Fd: rustix::fd::AsFd>(
    fd: Fd,
    detail: &'static str,
) -> Result<(), GenerationError> {
    fsync(fd).map_err(|e| match e {
        rustix::io::Errno::NOSPC | rustix::io::Errno::DQUOT => GenerationError::InsufficientStorage,
        _ => invalid(detail),
    })
}

///
/// `statvfs` cannot detect per-user quota exhaustion because it reports filesystem free blocks, not the caller's remaining quota.
fn is_storage_exhausted(err: &std::io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        Some(code)
            if code == rustix::io::Errno::NOSPC.raw_os_error()
                || code == rustix::io::Errno::DQUOT.raw_os_error()
    )
}

/// `GenerationManifest::files` paths are relative, contain no parent segments, and are unique and sorted in canonical encoding.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestFile {
    pub path: String,
    pub mode: u32,
    pub size: u64,
    pub sha256: String,
}

/// `GenerationManifest` serializes fields in declaration order.
/// `files` is sorted by path, making the encoding deterministic.
/// `GenerationManifest`'s SHA-256 names the generation.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenerationManifest {
    pub schema: u32,
    pub target: String,
    pub release_contract_sha256: String,
    pub inputs_lock_sha256: String,
    /// `None` denotes a generation without a recorded source payload manifest.
    ///
    /// `#[serde(default)]` preserves decoding of schema-1 manifests that omit this field.
    /// Generations without a source manifest digest fail only checks that require that digest.
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CurrentProfile {
    Absent,
    Current(String),
    /// Unknown persisted schemas are preserved byte-for-byte, cannot be selected, and block mutations until their references are known.
    Quarantined,
}

/// Staging consumes each source through a no-follow descriptor and verifies metadata before and after copying.
/// Staging always creates an independent, owner-only, single-link copy.
#[derive(Debug, Clone)]
pub struct SourceSpec {
    /// The destination path is relative to the generation.
    pub rel_path: String,
    pub source: PathBuf,
    pub executable: bool,
    /// `expected_size` is present only for production package sources.
    pub expected_size: Option<u64>,
    /// `expected_sha256` is an optional release-manifest SHA-256 for production package sources.
    pub expected_sha256: Option<String>,
}

/// `StageMeta` stores non-file identity inputs committed by the staged manifest.
#[derive(Debug, Clone)]
pub struct StageMeta {
    pub target: String,
    pub release_contract_sha256: String,
    pub inputs_lock_sha256: String,
    pub source_payload_manifest_sha256: String,
}

/// `verify_sources` reads every source and verifies each declared size and SHA-256 identity.
///
/// For `restart`, `stage_and_promote` copies sources only after stopping the incumbent.
/// `verify_sources` performs only reads, so callers must run it before stopping the incumbent.
///
/// `verify_sources` hashes only sources with declared identities; source enumeration verifies unqualified dev-tree existence and type.
pub fn verify_sources(sources: &[SourceSpec]) -> Result<(), GenerationError> {
    for spec in sources {
        let fd = openat(
            rustix::fs::CWD,
            &*spec.source,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(|_| invalid("payload source open failed"))?;
        let stat = rustix::fs::fstat(&fd).map_err(|_| invalid("payload source stat failed"))?;
        if (mode_bits(&stat) & S_IFMT) != S_IFREG {
            return Err(invalid("payload source is not a regular file"));
        }
        if spec
            .expected_size
            .is_some_and(|size| size != stat.st_size as u64)
        {
            return Err(invalid("payload source size differs from payload manifest"));
        }
        let Some(expected) = spec.expected_sha256.as_deref() else {
            continue;
        };
        let mut hasher = sha2::Sha256::new();
        let mut reader = std::fs::File::from(fd);
        let mut buf = vec![0u8; 128 * 1024];
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|_| invalid("payload source read failed"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        if hex(&hasher.finalize()) != expected {
            return Err(invalid("payload source hash differs from payload manifest"));
        }
    }
    Ok(())
}

/// The retained directory descriptor pins the validated tree against pathname replacement.
/// `manifest` contains the exact decoded canonical content.
pub struct ValidatedGeneration {
    pub digest: String,
    pub manifest: GenerationManifest,
    dir: OwnedFd,
}

impl ValidatedGeneration {
    /// In-process loaders may use the descriptor-rooted path only while `ValidatedGeneration` remains alive.
    ///
    /// `descriptor_root_path` supports directory traversal only on Linux.
    pub fn descriptor_root_path(&self) -> PathBuf {
        crate::harness_closure::descriptor_path(self.dir.as_raw_fd())
    }

    /// `open_verified_file` opens a manifest-listed file through the retained directory descriptor and rechecks its shape and hash.
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

fn allocation_rounded(size: u64) -> Option<u64> {
    const BLOCK: u64 = 4096;
    size.checked_add(BLOCK - 1).map(|n| (n / BLOCK) * BLOCK)
}

/// The R46 check uses checked arithmetic and requires `available >= required + max(256 MiB, ceil(required * 10%))`.
pub fn capacity_satisfied(available: u64, required: u64) -> Option<bool> {
    let tenth = required.div_ceil(10);
    let reserve = tenth.max(CAPACITY_RESERVE_FLOOR_BYTES);
    let needed = required.checked_add(reserve)?;
    Some(available >= needed)
}

/// `None` means overflow or an impossible manifest size.
pub fn required_stage_bytes(sizes: &[u64]) -> Option<u64> {
    let mut total = CAPACITY_FIXED_OVERHEAD_BYTES;
    for size in sizes {
        total = total.checked_add(allocation_rounded(*size)?)?;
    }
    Some(total)
}

/// `open_rel_nofollow` opens `rel` under `dir` component by component with `O_NOFOLLOW` and follows no intermediate or final symlink.
/// `None` means a path component was invalid or an `openat` call failed.
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

/// Component traversal opens every component, including the last, as a directory without following links.
/// Component traversal opens every component, including the last, as a directory without following links.
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
    // The hash reads a duplicated descriptor that shares `fd`'s offset, so rewind `fd` before returning it to callers.
    // The hash reads a duplicated descriptor that shares `fd`'s offset, so rewind `fd` before returning it to callers.
    // The hash reads a duplicated descriptor that shares `fd`'s offset, so rewind `fd` before returning it to callers.
    // The hash reads a duplicated descriptor that shares `fd`'s offset, so rewind `fd` before returning it to callers.
    rustix::fs::seek(fd, rustix::fs::SeekFrom::Start(0))
        .map_err(|_| invalid("file rewind after verification failed"))?;
    Ok(())
}

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

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PruneReport {
    pub removed_generations: usize,
    pub removed_temps: usize,
    pub quarantined: usize,
}

impl GenerationStore {
    /// version-neutral `transaction.lock`.
    pub fn open(data_dir_override: Option<&Path>) -> Result<Self, GenerationError> {
        let root = lifecycle_dir_path(data_dir_override)?;
        // `mkdir` can traverse a symlinked intermediate after `EEXIST`, allowing mutations outside the data root.
        // `mkdir` can traverse a symlinked intermediate after `EEXIST`, allowing mutations outside the data root.
        // `mkdir` can traverse a symlinked intermediate after `EEXIST`, allowing mutations outside the data root.
        // `mkdir` can traverse a symlinked intermediate after `EEXIST`, allowing mutations outside the data root.
        let root_fd = secure_runtime_dir(&root)?;
        validate_lifecycle_root_fd(&root_fd, &root)?;
        let created = match mkdirat(&root_fd, GENERATIONS_DIR_NAME, Mode::from_raw_mode(0o700)) {
            Ok(()) => true,
            Err(rustix::io::Errno::EXIST) => false,
            Err(e) => return Err(io_err("mkdir_generations", &root, e).into()),
        };
        // Because umask can clear owner bits, restore the requested mode before opening a newly created directory; never chmod an existing path.
        // Because umask can clear owner bits, restore the requested mode before opening a newly created directory; never chmod an existing path.
        // Because umask can clear owner bits, restore the requested mode before opening a newly created directory; never chmod an existing path.
        // Because umask can clear owner bits, restore the requested mode before opening a newly created directory; never chmod an existing path.
        // Because umask can clear owner bits, restore the requested mode before opening a newly created directory; never chmod an existing path.
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
            // `fchmod` uses the validated descriptor to avoid changing a replacement path.
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

    /// `Ok(None)` only when a store component is missing.
    /// Existing roots must satisfy the same ownership and ancestor checks as [`Self::open`].
    /// An insecure existing root returns an error rather than being silently accepted.
    ///
    pub fn open_probe(data_dir_override: Option<&Path>) -> Result<Option<Self>, GenerationError> {
        let root = lifecycle_dir_path(data_dir_override)?;
        let Some(root_fd) = open_secure_dir_existing(&root)? else {
            // A missing store has no staged generation and is not a trust failure.
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
        // The code requires `manifest.digest()` to equal the generation directory digest; otherwise noncanonical manifest encodings create multiple identities for one logical manifest.
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

    pub fn available_bytes(&self) -> Result<u64, GenerationError> {
        let stat =
            rustix::fs::fstatvfs(&self.generations_fd).map_err(|_| invalid("statvfs failed"))?;
        // `f_bavail` counts `f_frsize` units; `f_bsize` is the preferred I/O transfer size.
        // Using a 64 KiB or 128 KiB `f_bsize` with a 4 KiB fragment size would overstate capacity and admit staging runs that cannot fit.
        let unit = if stat.f_frsize != 0 {
            stat.f_frsize
        } else {
            stat.f_bsize
        };
        Ok(stat.f_bavail.saturating_mul(unit))
    }

    /// The method atomically replaces the current profile with the staged generation's digest.
    /// `protected` is used only for same-digest exchange repair.
    ///
    /// The method returns `InsufficientStorage` before creating a temp directory or after post-preflight `ENOSPC`; it removes the temp directory and preserves selectors in the latter case.
    /// The method returns `UnsupportedStateSchema` when the existing profile is quarantined.
    /// The method returns `NativePayloadInvalid` for identity and validation faults.
    /// (profile unchanged).
    pub fn stage_and_promote(
        &self,
        sources: &[SourceSpec],
        meta: &StageMeta,
        protected: &BTreeSet<String>,
    ) -> Result<String, GenerationError> {
        // A quarantined profile blocks mutation because its references are uncertain.
        if self.read_current()? == CurrentProfile::Quarantined {
            return Err(GenerationError::UnsupportedStateSchema);
        }
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
        // `mkdirat` applies the umask, so removing owner bits would prevent the owner from opening the directory and cause the subsequent security check to fail.
        // `mkdirat` rejects `EEXIST`, so success proves this call created the entry and prevents pathname `chmod` from following a planted symlink.
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
        // The code fsyncs each directory that receives an entry because fsyncing a file does not persist its parent entry.
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
        // The validator cannot revalidate manifests larger than `MAX_MANIFEST_BYTES`, so staging rejects them before promotion.
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(invalid("staged manifest exceeds the manifest size cap"));
        }
        write_new_file(temp_fd, GENERATION_MANIFEST_NAME, &bytes, 0o600)?;
        // The code fsyncs directories deepest-first so each directory's entries are durable before its entry in its parent.
        for rel in dirs.iter().rev() {
            let dir = open_rel_dir_nofollow(temp_fd, rel)
                .ok_or_else(|| invalid("staged directory reopen failed"))?;
            fsync_preserving_storage(&dir, "staged directory fsync failed")?;
        }
        fsync_preserving_storage(temp_fd, "staging temp fsync failed")?;
        Ok(manifest)
    }

    /// For an invalid, unprotected target, `promote_temp` atomically exchanges the temp and revalidates the promoted target before deleting the exchanged orphan.
    ///
    /// `renameat` can replace an empty target directory, bypassing the protected-target check.
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
        match self.validate(digest) {
            // A valid target occupant wins; cleanup attempts to remove the temp.
            Ok(_) => {
                let _ = remove_tree(&self.generations_fd, temp_name);
                return Ok(());
            }
            // An unsupported manifest schema is quarantined because exchange would delete bytes that `prune` preserves.
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

    /// `is_quarantined_schema` decodes only the manifest because every non-quarantined outcome is removable.
    fn is_quarantined_schema(&self, digest: &str) -> bool {
        let Some(dir) = open_child_dir(&self.generations_fd, digest) else {
            return false;
        };
        let Some(manifest_fd) = open_rel_nofollow(&dir, GENERATION_MANIFEST_NAME) else {
            return false;
        };
        // The code quarantines manifests above the read cap because deletion could remove a future-format generation; other read failures are removable.
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

    /// `prune` removes complete generations outside `protected` and owned incomplete staging temps.
    /// `prune`'s caller holds `transaction.lock` and supplies every protected digest:
    /// The protected digests include the current profile target and every coherent lock-held lifecycle digest.
    /// The protected digests include the active candidate.
    /// `prune` preserves entries with unknown manifest schemas or foreign names.
    /// `prune` returns `UnsupportedStateSchema` when the current profile is quarantined.
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
        // `prune` enumerates `generations_fd` instead of its pathname so a replacement directory cannot select retained-store deletions.
        // `prune` removes through `generations_fd` so a replaced pathname cannot redirect deletions.
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
            // An unprotected generation's contents affect pruning only through its manifest schema.
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

/// The copy rejects symlink sources and fails if source identity changes before completion.
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
        // mkdirat applies umask; chmod newly created components to 0700 so nested openat can traverse them.
        // Chmod only components created by mkdirat so an existing pathname cannot redirect chmodat.
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

    // The before/after check requires the same device, inode, size, mtime, and mtime nanoseconds.
    // The hash consumes the descriptor that the copy consumes.
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

/// `rename_noreplace` returns `Ok(true)` after renaming and `Ok(false)` when `to` is occupied.
/// Callers decide how to handle an occupied target.
///
/// `RENAME_NOREPLACE` atomically rejects an occupied target on Linux.
/// When renameat2 flags are unavailable, check occupancy while transaction.lock excludes trusted concurrent creators.
/// Every mutating entry point holds `transaction.lock`, excluding trusted concurrent creators.
fn rename_no_replace(dir: &OwnedFd, from: &str, to: &str) -> Result<bool, GenerationError> {
    #[cfg(target_os = "linux")]
    {
        match rustix::fs::renameat_with(dir, from, dir, to, rustix::fs::RenameFlags::NOREPLACE) {
            Ok(()) => return Ok(true),
            Err(rustix::io::Errno::EXIST) | Err(rustix::io::Errno::NOTEMPTY) => return Ok(false),
            Err(rustix::io::Errno::NOSPC) => return Err(GenerationError::InsufficientStorage),
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

/// A lifecycle root is an owned directory whose ancestry cannot be replaced under the process.
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

/// `open_child_dir_existing` returns `Ok(None)` only when `name` is absent; it returns `Err` when an existing entry fails the directory trust predicate.
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
        // Non-following metadata uses the entry's type rather than its target's.
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

///
/// fdopendir enumerates the already-open directory, preventing pathname replacement from changing the listing.
/// Unlike a `/proc/self/fd` round-trip, `fdopendir` needs no procfs.
/// `fdopendir` uses the lifecycle root's validation path on every supported platform, not only Linux.
/// `read_dir_names` excludes `.` and `..` so callers cannot delete the listed directory or its parent.
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
        // Schema 1 omits `source_payload_manifest_sha256` without a schema-version change.
        // The decoder must accept retained schema-1 manifests that omit `source_payload_manifest_sha256`.
        // Rejecting a retained schema-1 manifest that omits `source_payload_manifest_sha256` would report `native_payload_invalid` on the first no-`--payload-dir` start after an upgrade.
        let predecessor = br#"{"schema":1,"target":"linux-x64-gnu","release_contract_sha256":"aa","inputs_lock_sha256":"bb","files":[]}"#;
        let decoded = match decode_with_schema::<GenerationManifest>(predecessor) {
            SchemaDecode::Valid(manifest) => manifest,
            SchemaDecode::UnknownSchema => panic!("schema 1 must stay readable"),
            SchemaDecode::Malformed => {
                panic!("a predecessor generation is not corrupt merely for predating a field")
            }
        };
        assert_eq!(decoded.source_payload_manifest_sha256, None);
        // A predecessor manifest that omits the field serializes to its original bytes.
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

        let bin = store
            .root()
            .join(GENERATIONS_DIR_NAME)
            .join(&digest)
            .join("bin/ck-mc-host");
        let meta = std::fs::metadata(&bin).expect("stat");
        assert_eq!(meta.permissions().mode() & 0o7777, 0o700);

        let again = stage_default(&store, src.path());
        assert_eq!(again, digest);
    }

    #[test]
    fn descriptor_root_survives_generation_path_replacement() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let digest = stage_default(&store, src.path());
        let validated = store.validate(&digest).expect("validate");
        let descriptor_path = validated.descriptor_root_path().join("bin/ck-mc-host");
        let expected = std::fs::read(&descriptor_path).expect("descriptor bytes");

        let generation_path = store.root().join(GENERATIONS_DIR_NAME).join(&digest);
        let moved = store
            .root()
            .join(GENERATIONS_DIR_NAME)
            .join("moved-generation");
        std::fs::rename(&generation_path, moved).expect("rename generation");
        std::fs::create_dir_all(generation_path.join("bin")).expect("replacement tree");
        std::fs::write(
            generation_path.join("bin/ck-mc-host"),
            b"malicious replacement",
        )
        .expect("replacement bytes");

        assert_eq!(
            std::fs::read(descriptor_path).expect("retained descriptor bytes"),
            expected
        );
    }

    #[test]
    fn capacity_accounting_is_checked_and_exact() {
        // Exact boundary: available == required + reserve passes.
        let required = 1024 * 1024 * 1024u64;
        let reserve = (required.div_ceil(10)).max(CAPACITY_RESERVE_FLOOR_BYTES);
        assert_eq!(capacity_satisfied(required + reserve, required), Some(true));
        // `available == required + reserve - 1` fails.
        assert_eq!(
            capacity_satisfied(required + reserve - 1, required),
            Some(false)
        );
        assert_eq!(
            capacity_satisfied(CAPACITY_RESERVE_FLOOR_BYTES + 4096 - 1, 4096),
            Some(false)
        );
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

        std::fs::write(gen_dir.join("extra"), b"x").expect("extra");
        expect_invalid(&store);
        std::fs::remove_file(gen_dir.join("extra")).expect("remove extra");

        // Loose mode.
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).expect("mode");
        expect_invalid(&store);
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).expect("mode");

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

        std::fs::create_dir(
            store
                .root()
                .join(GENERATIONS_DIR_NAME)
                .join("tmp-deadbeef00000000"),
        )
        .expect("temp");
        std::fs::create_dir(store.root().join(GENERATIONS_DIR_NAME).join("not-a-digest"))
            .expect("foreign");

        let mut protected = BTreeSet::new();
        protected.insert(digest_a.clone());
        let report = store.prune(&protected).expect("prune");
        assert_eq!(report.removed_generations, 0);
        assert_eq!(report.removed_temps, 1);
        assert_eq!(report.quarantined, 1);
        assert!(store.validate(&digest_a).is_ok());
        assert!(store.validate(&digest_b).is_ok());

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

        // invalid occupant.
        let bin = gen_dir.join("bin/ck-mc-host");
        let mut bytes = std::fs::read(&bin).expect("read");
        bytes[0] ^= 1;
        std::fs::write(&bin, &bytes).expect("corrupt");
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).expect("mode");
        assert!(store.validate(&digest).is_err());

        let mut protected = BTreeSet::new();
        protected.insert(digest.clone());
        assert!(matches!(
            store.stage_and_promote(&sources_in(src.path()), &meta(), &protected),
            Err(GenerationError::NativePayloadInvalid { .. })
        ));
        assert!(store.validate(&digest).is_err(), "target left untouched");

        let repaired = store
            .stage_and_promote(&sources_in(src.path()), &meta(), &BTreeSet::new())
            .expect("repair");
        assert_eq!(repaired, digest);
        store.validate(&digest).expect("repaired target validates");
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
        std::fs::write(&real, b"mutated-after-staging").expect("mutate");
        store
            .validate(&digest)
            .expect("staged bytes are independent");
    }

    /// `verify_file_against_entry` must rewind its returned descriptor after hashing its duplicate.
    /// A duplicated descriptor shares the open file description's offset.
    /// Without rewinding, callers read zero bytes from a non-empty verified file.
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

    /// Persisted manifest bytes must equal the canonical serialization of the decoded manifest.
    /// Otherwise, raw-byte and canonical-form hashes give one manifest different generation identities.
    /// The generation directory name hashes the raw manifest bytes.
    /// `manifest.digest()` hashes the manifest's canonical serialization.
    #[test]
    fn noncanonically_encoded_manifests_are_rejected() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let digest = stage_default(&store, src.path());
        let dir = store.root().join(GENERATIONS_DIR_NAME).join(&digest);

        // Reserializing through `serde_json::Value` sorts keys and can change their declaration order.
        // Renaming the generation to the hash of the reserialized bytes preserves digest binding.
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

    /// `renameat` can replace an existing empty directory; protected digests must be refused before rename.
    /// after it.
    #[test]
    fn an_empty_protected_digest_target_is_never_replaced() {
        let root = tempfile::tempdir().expect("root");
        let src = tempfile::tempdir().expect("src");
        let store = store_at(root.path());
        let digest = stage_default(&store, src.path());
        let dir = store.root().join(GENERATIONS_DIR_NAME).join(&digest);

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

    /// `validate` rejects a symlink by its own entry type so a link to an empty directory cannot pass as an empty subtree.
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

    /// An existing untrusted store must be distinguished from an absent store; reporting it as unstaged would prescribe payload installation instead of investigation.
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
    /// `umask` normalization may run only when `mkdirat` created the entry, because it operates by pathname.
    /// `umask` normalization may run only when `mkdirat` created the entry.
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

    /// An occupied digest with an unknown manifest schema is quarantined; promotion must abandon the mutation rather than exchange and delete the directory.
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

        // The same sources reproduce `digest`, so promotion targets the quarantined generation.
        // The quarantined occupant is excluded from `protected` so the quarantine rule must prevent repair.
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

    /// A manifest larger than `MAX_MANIFEST_BYTES` cannot have its schema decoded, so pruning must retain it rather than treat it as removable corruption.
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

        // Padding an unknown-schema manifest past `MAX_MANIFEST_BYTES` makes the capped read fail before schema decoding.
        let mut oversized = br#"{"schema":2,"unknown_future_field":true,"pad":""#.to_vec();
        oversized.resize(oversized.len() + MAX_MANIFEST_BYTES, b'x');
        oversized.extend_from_slice(br#""}"#);
        assert!(oversized.len() > MAX_MANIFEST_BYTES);
        std::fs::write(&manifest_path, &oversized).expect("write oversized manifest");

        // Pruning must preserve an oversized generation after a successor replaces it as the current profile target.
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
