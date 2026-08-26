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
    hex, io_err, is_safe_ancestor, mode_bits, read_all_fd, write_all_fd, InstanceError, S_IFDIR,
    S_IFMT, S_IFREG,
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
}

/// Non-file identity inputs committed by the staged manifest.
#[derive(Debug, Clone)]
pub struct StageMeta {
    pub target: String,
    pub release_contract_sha256: String,
    pub inputs_lock_sha256: String,
}

/// A completely revalidated generation: the retained directory descriptor
/// pins the validated tree against pathname replacement, and the manifest
/// is the exact decoded canonical content.
pub struct ValidatedGeneration {
    pub digest: String,
    pub manifest: GenerationManifest,
    dir: OwnedFd,
}

impl ValidatedGeneration {
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
        create_dir_all_owner_only(&root)?;
        let root_fd = open_validated_dir_fd(&root)?;
        match mkdirat(&root_fd, GENERATIONS_DIR_NAME, Mode::from_raw_mode(0o700)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(e) => return Err(io_err("mkdir_generations", &root, e).into()),
        }
        let generations_fd = open_child_dir(&root_fd, GENERATIONS_DIR_NAME)
            .ok_or_else(|| invalid("generations directory failed security checks"))?;
        Ok(Self {
            root,
            root_fd,
            generations_fd,
        })
    }

    /// No-create open for observational probes: `Ok(None)` when the store
    /// does not exist yet.
    pub fn open_probe(data_dir_override: Option<&Path>) -> Result<Option<Self>, GenerationError> {
        let root = lifecycle_dir_path(data_dir_override)?;
        let Ok(root_fd) = openat(
            rustix::fs::CWD,
            &*root,
            OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) else {
            return Ok(None);
        };
        let Some(generations_fd) = open_child_dir(&root_fd, GENERATIONS_DIR_NAME) else {
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
        if (mode_bits(&stat) & S_IFMT) != S_IFREG || stat.st_uid != owner_uid() {
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
        // directory to be owner-only.
        let mut found: BTreeSet<String> = BTreeSet::new();
        walk_generation_tree(&self.generation_path(digest), "", &mut found)?;
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

    fn generation_path(&self, name: &str) -> PathBuf {
        self.root.join(GENERATIONS_DIR_NAME).join(name)
    }

    /// Available bytes for this store's destination filesystem, as seen by
    /// an unprivileged owner.
    pub fn available_bytes(&self) -> Result<u64, GenerationError> {
        let stat =
            rustix::fs::fstatvfs(&self.generations_fd).map_err(|_| invalid("statvfs failed"))?;
        Ok(stat.f_bavail.saturating_mul(stat.f_bsize))
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
            rustix::io::Errno::NOSPC => GenerationError::InsufficientStorage,
            _ => invalid("staging temp creation failed"),
        })?;
        let temp_fd = open_child_dir(&self.generations_fd, &temp_name)
            .ok_or_else(|| invalid("staging temp failed security checks"))?;
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
        for spec in sources {
            validate_rel_path(&spec.rel_path)?;
            if !seen.insert(spec.rel_path.clone()) {
                return Err(invalid("duplicate staged path"));
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
            files,
        };
        let bytes = manifest.canonical_bytes();
        write_new_file(temp_fd, GENERATION_MANIFEST_NAME, &bytes, 0o600)?;
        fsync(temp_fd).map_err(|_| invalid("staging temp fsync failed"))?;
        Ok(manifest)
    }

    /// Renames the fully staged temp to its digest name. When a directory
    /// already occupies the digest: a valid occupant wins (the temp is
    /// discarded), and an invalid unprotected occupant is repaired only by
    /// atomic exchange with the validated candidate, revalidated before the
    /// exchanged orphan is deleted.
    fn promote_temp(
        &self,
        temp_name: &str,
        digest: &str,
        protected: &BTreeSet<String>,
    ) -> Result<(), GenerationError> {
        match renameat(
            &self.generations_fd,
            temp_name,
            &self.generations_fd,
            digest,
        ) {
            Ok(()) => {
                fsync(&self.generations_fd).map_err(|_| invalid("generations fsync failed"))?;
                return Ok(());
            }
            Err(rustix::io::Errno::EXIST) | Err(rustix::io::Errno::NOTEMPTY) => {}
            Err(rustix::io::Errno::NOSPC) => return Err(GenerationError::InsufficientStorage),
            Err(_) => return Err(invalid("generation rename failed")),
        }
        // Occupied digest target.
        if self.validate(digest).is_ok() {
            let _ = remove_tree(&self.generations_fd, temp_name);
            return Ok(());
        }
        if protected.contains(digest) {
            return Err(invalid("corrupt digest target is protected"));
        }
        exchange_dirs(&self.generations_fd, temp_name, digest)?;
        fsync(&self.generations_fd).map_err(|_| invalid("generations fsync failed"))?;
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
        fsync(&self.root_fd).map_err(|_| invalid("lifecycle root fsync failed"))?;
        Ok(())
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
        let entries: Vec<String> = std::fs::read_dir(self.root.join(GENERATIONS_DIR_NAME))
            .map_err(|_| invalid("generations directory read failed"))?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
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
            match self.validate(&name) {
                Ok(_) => {
                    remove_tree(&self.generations_fd, &name)?;
                    report.removed_generations += 1;
                }
                Err(GenerationError::UnsupportedStateSchema) => {
                    report.quarantined += 1;
                }
                // An invalid unprotected generation is still removable: it
                // is complete garbage under a canonical name, referenced by
                // nothing in the protected set.
                Err(GenerationError::NativePayloadInvalid { .. }) => {
                    remove_tree(&self.generations_fd, &name)?;
                    report.removed_generations += 1;
                }
                Err(err) => return Err(err),
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

    // Create intermediate directories, then the exclusive output file.
    let mut dir_path = String::new();
    let components: Vec<&str> = spec.rel_path.split('/').collect();
    for component in &components[..components.len() - 1] {
        if !dir_path.is_empty() {
            dir_path.push('/');
        }
        dir_path.push_str(component);
        match mkdirat(temp_fd, dir_path.as_str(), Mode::from_raw_mode(0o700)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(rustix::io::Errno::NOSPC) => return Err(GenerationError::InsufficientStorage),
            Err(_) => return Err(invalid("staging directory creation failed")),
        }
    }
    let mode = if spec.executable { 0o700 } else { 0o600 };
    let dest_fd = openat(
        temp_fd,
        spec.rel_path.as_str(),
        OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(mode),
    )
    .map_err(|e| match e {
        rustix::io::Errno::NOSPC => GenerationError::InsufficientStorage,
        _ => invalid("staging output creation failed"),
    })?;
    rustix::fs::fchmod(&dest_fd, Mode::from_raw_mode(mode))
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
            if e.raw_os_error() == Some(rustix::io::Errno::NOSPC.raw_os_error()) {
                GenerationError::InsufficientStorage
            } else {
                invalid("staging output write failed")
            }
        })?;
    }
    fsync(&dest_fd).map_err(|_| invalid("staging output fsync failed"))?;

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
    Ok(ManifestFile {
        path: spec.rel_path.clone(),
        mode,
        size: total,
        sha256: hex(&hasher.finalize()),
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
        Mode::from_raw_mode(mode),
    )
    .map_err(|e| match e {
        rustix::io::Errno::NOSPC => GenerationError::InsufficientStorage,
        _ => invalid("file creation failed"),
    })?;
    rustix::fs::fchmod(&fd, Mode::from_raw_mode(mode)).map_err(|_| invalid("file chmod failed"))?;
    write_all_fd(&fd, bytes).map_err(|e| {
        if e.raw_os_error() == Some(rustix::io::Errno::NOSPC.raw_os_error()) {
            GenerationError::InsufficientStorage
        } else {
            invalid("file write failed")
        }
    })?;
    fsync(&fd).map_err(|_| invalid("file fsync failed"))?;
    Ok(())
}

/// Atomic same-filesystem directory exchange. Linux `renameat2` with
/// `RENAME_EXCHANGE`; other platforms fail closed as `native_payload_invalid`
/// (macOS `renamex_np(RENAME_SWAP)` support is deferred with the rest of the
/// macOS lane).
#[cfg(target_os = "linux")]
fn exchange_dirs(dir: &OwnedFd, a: &str, b: &str) -> Result<(), GenerationError> {
    rustix::fs::renameat_with(dir, a, dir, b, rustix::fs::RenameFlags::EXCHANGE)
        .map_err(|_| invalid("atomic digest-target exchange failed"))
}

#[cfg(not(target_os = "linux"))]
fn exchange_dirs(_dir: &OwnedFd, _a: &str, _b: &str) -> Result<(), GenerationError> {
    Err(invalid(
        "atomic digest-target exchange is unsupported on this platform",
    ))
}

fn create_dir_all_owner_only(path: &Path) -> Result<(), GenerationError> {
    let mut current = PathBuf::from("/");
    for component in path.components() {
        match component {
            std::path::Component::RootDir => continue,
            std::path::Component::Normal(name) => current.push(name),
            _ => return Err(invalid("lifecycle root path is not absolute-normal")),
        }
        match rustix::fs::mkdir(&*current, Mode::from_raw_mode(0o700)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(e) => return Err(io_err("mkdir_lifecycle", &current, e).into()),
        }
    }
    Ok(())
}

fn open_validated_dir_fd(path: &Path) -> Result<OwnedFd, GenerationError> {
    let fd = openat(
        rustix::fs::CWD,
        path,
        OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|e| io_err("open_lifecycle_root", path, e))?;
    let stat = rustix::fs::fstat(&fd).map_err(|e| io_err("fstat_lifecycle_root", path, e))?;
    let mode = mode_bits(&stat);
    if (mode & S_IFMT) != S_IFDIR || stat.st_uid != owner_uid() {
        return Err(invalid("lifecycle root failed security checks"));
    }
    if !is_safe_ancestor(&stat) {
        return Err(invalid("lifecycle root failed security checks"));
    }
    Ok(fd)
}

fn open_child_dir(parent: &OwnedFd, name: &str) -> Option<OwnedFd> {
    let fd = open_child_dir_for_removal(parent, name)?;
    let stat = rustix::fs::fstat(&fd).ok()?;
    if (mode_bits(&stat) & 0o077) != 0 {
        return None;
    }
    Some(fd)
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
    dir_path: &Path,
    prefix: &str,
    found: &mut BTreeSet<String>,
) -> Result<(), GenerationError> {
    let entries =
        std::fs::read_dir(dir_path).map_err(|_| invalid("generation directory read failed"))?;
    for entry in entries {
        let entry = entry.map_err(|_| invalid("generation directory read failed"))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| invalid("generation entry name is not unicode"))?;
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let meta = entry
            .metadata()
            .map_err(|_| invalid("generation entry stat failed"))?;
        if meta.file_type().is_symlink() {
            return Err(invalid("generation contains a symlink"));
        }
        if meta.is_dir() {
            walk_generation_tree(&entry.path(), &rel, found)?;
        } else if meta.is_file() {
            found.insert(rel);
        } else {
            return Err(invalid("generation contains a non-regular entry"));
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
    let names: Vec<String> = {
        let dup = rustix::io::dup(&dir).map_err(|_| invalid("directory dup failed"))?;
        let std_dir = std::fs::File::from(dup);
        read_dir_names(&std_dir)?
    };
    for child in names {
        remove_tree(&dir, &child)?;
    }
    unlinkat(parent, name, AtFlags::REMOVEDIR).map_err(|_| invalid("directory removal failed"))?;
    Ok(())
}

fn read_dir_names(dir_file: &std::fs::File) -> Result<Vec<String>, GenerationError> {
    use std::os::fd::AsRawFd;
    // `read_dir` needs a path; /proc/self/fd resolves the already validated
    // open directory description without re-walking the pathname.
    let path = format!("/proc/self/fd/{}", dir_file.as_raw_fd());
    let entries = std::fs::read_dir(path).map_err(|_| invalid("directory listing failed"))?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| invalid("directory listing failed"))?;
        names.push(
            entry
                .file_name()
                .into_string()
                .map_err(|_| invalid("directory entry name is not unicode"))?,
        );
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

    fn meta() -> StageMeta {
        StageMeta {
            target: "linux-x64-gnu".to_owned(),
            release_contract_sha256: "a".repeat(64),
            inputs_lock_sha256: "b".repeat(64),
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
            },
            SourceSpec {
                rel_path: "notices.txt".to_owned(),
                source: write_source(dir, "notices", b"notice text"),
                executable: false,
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
}
