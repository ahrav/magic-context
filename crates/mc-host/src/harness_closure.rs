//! Immutable, content-addressed runtime closures for managed Broca harnesses.
//!
//! A closure preserves the qualified package layout under `files/`. Its
//! canonical manifest commits every launch root, dependency edge, extension
//! position, source identity, file mode, size, and hash.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CStr;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

use rustix::fd::OwnedFd;
use rustix::fs::{
    fsync, mkdirat, openat, renameat_with, unlinkat, AtFlags, Dir, Mode, OFlags, RenameFlags, CWD,
};
use sha2::{Digest, Sha256};

const MANIFEST_NAME: &str = "manifest.json";
const FILES_NAME: &str = "files";
const CLOSURE_SCHEMA: &str = "magic-context.mc-host-harness-closure/v1";
const TEMP_PREFIX: &str = ".tmp-";
const MAX_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_NODES: usize = 65_536;
const MAX_PATH_BYTES: usize = 4096;
const MAX_STRING_BYTES: usize = 1024;
const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;
const S_ISVTX: u32 = 0o1000;

/// A strict schema-1 harness runtime closure.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClosureManifest {
    pub schema: String,
    pub harness: String,
    pub package: String,
    pub version: String,
    pub argument_variant: String,
    pub source_roots: Vec<String>,
    pub executable: Option<String>,
    pub interpreter: Option<String>,
    pub entrypoint: Option<String>,
    pub extensions: Vec<String>,
    pub nodes: Vec<ClosureNode>,
}

/// One qualified file in a closure.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClosureNode {
    pub path: String,
    pub source_root: String,
    pub source_path: String,
    pub kind: NodeKind,
    pub mode: u32,
    pub size_bytes: u64,
    pub sha256: String,
    pub dependencies: Vec<ClosureDependency>,
}

/// A qualified dependency edge from one closure node to another.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClosureDependency {
    pub path: String,
    pub kind: DependencyKind,
}

/// Closed file roles accepted by the runtime closure.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Interpreter,
    Executable,
    Module,
    NativeAddon,
    Extension,
    Data,
}

/// Closed dependency-edge classes. Dynamic imports must be finite and listed.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum DependencyKind {
    Static,
    FiniteDynamic,
    Native,
}

/// Qualified source roots paired with one exact closure manifest.
#[derive(Debug, Clone)]
pub struct ClosureCandidate {
    pub manifest: ClosureManifest,
    pub source_roots: BTreeMap<String, PathBuf>,
}

/// A validated immutable closure retained by an open directory descriptor.
pub struct ValidatedHarnessClosure {
    digest: String,
    manifest: ClosureManifest,
    path: PathBuf,
    files_fd: OwnedFd,
}

impl std::fmt::Debug for ValidatedHarnessClosure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ValidatedHarnessClosure")
            .field("digest", &self.digest)
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl ValidatedHarnessClosure {
    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn manifest(&self) -> &ClosureManifest {
        &self.manifest
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Opens and revalidates one node, returning both the descriptor-rooted
    /// path that names the verified inode and the closure pathname, so each
    /// call site can hand the child the form its role actually supports.
    pub fn resolve_node_descriptor(
        &self,
        node_path: &str,
    ) -> Result<ResolvedHarnessNode, HarnessClosureError> {
        let node = self
            .manifest
            .nodes
            .iter()
            .find(|node| node.path == node_path)
            .ok_or_else(|| invalid("resolved node is not listed by the manifest"))?;
        let fd = open_relative_file(&self.files_fd, node_path)
            .map_err(|_| invalid("resolved node is missing or insecure"))?;
        verify_node_file(&fd, node)?;
        // Verification hashes to EOF through an offset-sharing dup, leaving
        // this descriptor at EOF. A macOS child opening `/dev/fd/N` receives a
        // dup of it, offset included, and would read zero bytes.
        rustix::fs::seek(&fd, rustix::fs::SeekFrom::Start(0))
            .map_err(|_| invalid("resolved node rewind failed"))?;
        Ok(ResolvedHarnessNode {
            descriptor_path: descriptor_path(fd.as_raw_fd()),
            closure_path: self.path.join(FILES_NAME).join(node_path),
            fd,
        })
    }
}

/// Builds the descriptor-rooted pathname naming an open descriptor's object.
///
/// Linux `/proc/self/fd/N` is a magic symlink: opening it performs a fresh
/// open of the underlying inode at offset 0, and a loader that resolves
/// symlinks recovers the object's real pathname. macOS `/dev/fd/N` provides
/// neither property. `open("/dev/fd/N", ...)` is equivalent to
/// `fcntl(N, F_DUPFD, 0)`, so it shares the descriptor's file offset, and the
/// entry is not a symlink, so a loader cannot walk back to the containing
/// directory. Both platforms support exec through this path, which the release
/// contract declares as `procfs_self_fd_exec` and `dev_fd_exec`.
#[allow(dead_code)] // Path-included closure tests compile without Broca adapters.
pub fn descriptor_path(fd: RawFd) -> PathBuf {
    let root = if cfg!(target_os = "macos") {
        "/dev/fd"
    } else {
        "/proc/self/fd"
    };
    PathBuf::from(root).join(fd.to_string())
}

/// Whether a descriptor-rooted path behaves like the file it names for data
/// reads and module resolution, not only for exec. See [`descriptor_path`].
#[allow(dead_code)] // Path-included closure tests compile without Broca adapters.
pub const DESCRIPTOR_PATHS_ARE_FILE_LIKE: bool = !cfg!(target_os = "macos");

#[allow(dead_code)] // Path-included closure tests compile without Broca adapters.
pub struct ResolvedHarnessNode {
    descriptor_path: PathBuf,
    closure_path: PathBuf,
    fd: OwnedFd,
}

#[allow(dead_code)] // Path-included closure tests compile without Broca adapters.
impl ResolvedHarnessNode {
    /// Path for an exec target: always descriptor-rooted, so the pathname
    /// cannot be replaced between validation and exec.
    pub fn path(&self) -> &Path {
        &self.descriptor_path
    }

    /// Path for a file the child reads as data or resolves sibling modules
    /// against. Descriptor-rooted only where that resolves like the file
    /// itself; otherwise the closure pathname, which every platform can walk.
    pub fn module_path(&self) -> &Path {
        if DESCRIPTOR_PATHS_ARE_FILE_LIKE {
            &self.descriptor_path
        } else {
            &self.closure_path
        }
    }

    /// The closure-owned pathname of the verified node.
    pub fn closure_path(&self) -> &Path {
        &self.closure_path
    }

    pub fn inherited_fd(&self) -> RawFd {
        self.fd.as_raw_fd()
    }

    /// The descriptor a child must inherit to use [`Self::module_path`], which
    /// is `None` when that path is an ordinary pathname needing no descriptor.
    pub fn module_inherited_fd(&self) -> Option<RawFd> {
        DESCRIPTOR_PATHS_ARE_FILE_LIKE.then(|| self.fd.as_raw_fd())
    }
}

/// Closed failure from manifest validation, copying, or retained revalidation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessClosureError {
    detail: &'static str,
}

impl HarnessClosureError {
    pub fn detail(&self) -> &'static str {
        self.detail
    }
}

impl std::fmt::Display for HarnessClosureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "harness closure invalid: {}", self.detail)
    }
}

impl std::error::Error for HarnessClosureError {}

fn invalid(detail: &'static str) -> HarnessClosureError {
    HarnessClosureError { detail }
}

/// Returns the SHA-256 of the validated canonical manifest encoding.
pub fn manifest_digest(manifest: &ClosureManifest) -> Result<String, HarnessClosureError> {
    validate_manifest(manifest)?;
    let bytes = canonical_manifest(manifest)?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(invalid("canonical manifest exceeds its size cap"));
    }
    Ok(hex(&Sha256::digest(bytes)))
}

fn canonical_manifest(manifest: &ClosureManifest) -> Result<Vec<u8>, HarnessClosureError> {
    let value =
        serde_json::to_value(manifest).map_err(|_| invalid("manifest serialization failed"))?;
    serde_json::to_vec_pretty(&sort_json(value))
        .map_err(|_| invalid("manifest serialization failed"))
}

fn sort_json(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(sort_json).collect())
        }
        serde_json::Value::Object(values) => {
            let mut keys: Vec<String> = values.keys().cloned().collect();
            keys.sort();
            let mut sorted = serde_json::Map::new();
            for key in keys {
                sorted.insert(
                    key.clone(),
                    sort_json(
                        values
                            .get(&key)
                            .expect("key was collected from this object")
                            .clone(),
                    ),
                );
            }
            serde_json::Value::Object(sorted)
        }
        scalar => scalar,
    }
}

/// Validates schema, paths, launch roots, graph edges, reachability, modes,
/// hashes, source-root identifiers, and deterministic node ordering.
pub fn validate_manifest(manifest: &ClosureManifest) -> Result<(), HarnessClosureError> {
    if manifest.schema != CLOSURE_SCHEMA {
        return Err(invalid("unsupported manifest schema"));
    }
    for value in [
        &manifest.harness,
        &manifest.package,
        &manifest.version,
        &manifest.argument_variant,
    ] {
        validate_identifier(value)?;
    }
    if manifest.nodes.is_empty() || manifest.nodes.len() > MAX_NODES {
        return Err(invalid("manifest node count is invalid"));
    }
    if manifest.source_roots.is_empty()
        || manifest
            .source_roots
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
    {
        return Err(invalid("manifest source roots are not uniquely sorted"));
    }
    for root in &manifest.source_roots {
        validate_identifier(root)?;
    }
    if manifest.executable.is_none()
        && !(manifest.interpreter.is_some() && manifest.entrypoint.is_some())
    {
        return Err(invalid("manifest has no complete launch root"));
    }
    if manifest.executable.is_some()
        && (manifest.interpreter.is_some() || manifest.entrypoint.is_some())
    {
        return Err(invalid(
            "manifest mixes executable and interpreted launch roots",
        ));
    }

    let mut by_path = BTreeMap::new();
    let mut previous_path: Option<&str> = None;
    for node in &manifest.nodes {
        validate_relative_path(&node.path)?;
        validate_relative_path(&node.source_path)?;
        validate_identifier(&node.source_root)?;
        if manifest
            .source_roots
            .binary_search(&node.source_root)
            .is_err()
        {
            return Err(invalid("node source root is not declared"));
        }
        validate_hash(&node.sha256)?;
        if node.mode != 0o600 && node.mode != 0o700 {
            return Err(invalid("node mode is not owner-only"));
        }
        match node.kind {
            NodeKind::Executable | NodeKind::Interpreter if node.mode != 0o700 => {
                return Err(invalid("launch node is not executable"));
            }
            NodeKind::Module | NodeKind::NativeAddon | NodeKind::Extension | NodeKind::Data
                if node.mode != 0o600 =>
            {
                return Err(invalid("non-launch node has executable mode"));
            }
            _ => {}
        }
        if previous_path.is_some_and(|previous| previous >= node.path.as_str()) {
            return Err(invalid("manifest nodes are not uniquely sorted by path"));
        }
        if previous_path.is_some_and(|previous| {
            node.path
                .strip_prefix(previous)
                .is_some_and(|suffix| suffix.starts_with('/'))
        }) {
            return Err(invalid("manifest node path collides with a parent file"));
        }
        previous_path = Some(&node.path);
        if by_path.insert(node.path.as_str(), node).is_some() {
            return Err(invalid("manifest contains a duplicate node path"));
        }
        let mut previous_dependency: Option<&ClosureDependency> = None;
        for dependency in &node.dependencies {
            validate_relative_path(&dependency.path)?;
            if previous_dependency.is_some_and(|previous| previous >= dependency) {
                return Err(invalid(
                    "node dependencies are not uniquely sorted by path and kind",
                ));
            }
            previous_dependency = Some(dependency);
        }
    }

    let mut roots = Vec::new();
    for (path, expected_kind) in [
        (manifest.executable.as_deref(), NodeKind::Executable),
        (manifest.interpreter.as_deref(), NodeKind::Interpreter),
    ] {
        if let Some(path) = path {
            require_root(&by_path, path, expected_kind)?;
            roots.push(path);
        }
    }
    if let Some(path) = manifest.entrypoint.as_deref() {
        let node = require_existing_node(&by_path, path)?;
        if !matches!(node.kind, NodeKind::Module | NodeKind::Executable) {
            return Err(invalid("entrypoint has an invalid node kind"));
        }
        roots.push(path);
    }
    let mut seen_extensions = BTreeSet::new();
    for path in &manifest.extensions {
        validate_relative_path(path)?;
        if !seen_extensions.insert(path.as_str()) {
            return Err(invalid("manifest contains a duplicate extension"));
        }
        require_root(&by_path, path, NodeKind::Extension)?;
        roots.push(path);
    }

    for node in &manifest.nodes {
        for dependency in &node.dependencies {
            let target = require_existing_node(&by_path, &dependency.path)?;
            if dependency.kind == DependencyKind::Native && target.kind != NodeKind::NativeAddon {
                return Err(invalid("native dependency does not target a native addon"));
            }
        }
    }

    let mut reachable = BTreeSet::new();
    let mut pending = roots;
    while let Some(path) = pending.pop() {
        if !reachable.insert(path) {
            continue;
        }
        let node = by_path
            .get(path)
            .expect("launch and dependency roots were checked above");
        pending.extend(
            node.dependencies
                .iter()
                .map(|dependency| dependency.path.as_str()),
        );
    }
    if reachable.len() != manifest.nodes.len() {
        return Err(invalid("manifest contains an unreachable node"));
    }
    Ok(())
}

fn require_existing_node<'a>(
    nodes: &'a BTreeMap<&str, &'a ClosureNode>,
    path: &str,
) -> Result<&'a ClosureNode, HarnessClosureError> {
    nodes
        .get(path)
        .copied()
        .ok_or_else(|| invalid("manifest references a missing node"))
}

fn require_root(
    nodes: &BTreeMap<&str, &ClosureNode>,
    path: &str,
    kind: NodeKind,
) -> Result<(), HarnessClosureError> {
    validate_relative_path(path)?;
    if require_existing_node(nodes, path)?.kind != kind {
        return Err(invalid("launch root has an invalid node kind"));
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), HarnessClosureError> {
    if value.is_empty()
        || value.len() > MAX_STRING_BYTES
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(invalid("manifest identifier is invalid"));
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), HarnessClosureError> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES || path.as_bytes().contains(&0) {
        return Err(invalid("manifest path length is invalid"));
    }
    if path.split('/').any(|part| {
        part.is_empty()
            || part == "."
            || part == ".."
            || part.len() > 255
            || part.as_bytes().contains(&b'\\')
    }) {
        return Err(invalid("manifest path has an invalid component"));
    }
    Ok(())
}

fn validate_hash(hash: &str) -> Result<(), HarnessClosureError> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid("manifest hash is not canonical sha256"));
    }
    Ok(())
}

/// A store whose direct children are canonical manifest digests.
pub struct HarnessClosureStore {
    root: PathBuf,
    root_fd: OwnedFd,
}

impl std::fmt::Debug for HarnessClosureStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HarnessClosureStore")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl HarnessClosureStore {
    /// Opens or creates an owner-only store without following a symlink in
    /// any path component.
    pub fn open(root: &Path) -> Result<Self, HarnessClosureError> {
        let root_fd = open_or_create_store_path(root)?;
        Ok(Self {
            root: root.to_path_buf(),
            root_fd,
        })
    }

    /// Materializes a qualified candidate or reuses an already valid closure
    /// with the same digest.
    pub fn materialize(
        &self,
        candidate: &ClosureCandidate,
    ) -> Result<ValidatedHarnessClosure, HarnessClosureError> {
        validate_manifest(&candidate.manifest)?;
        validate_source_root_set(candidate)?;
        let digest = manifest_digest(&candidate.manifest)?;
        if let Ok(validated) = self.validate(&digest) {
            return Ok(validated);
        }
        if child_exists(&self.root_fd, &digest)? {
            return Err(invalid("digest target exists but is invalid"));
        }

        let (temp_name, temp_fd) = self.create_temp()?;
        let staged = self.stage_candidate(&temp_fd, candidate);
        if let Err(error) = staged {
            let _ = remove_tree(&self.root_fd, &temp_name);
            return Err(error);
        }
        match renameat_with(
            &self.root_fd,
            temp_name.as_str(),
            &self.root_fd,
            digest.as_str(),
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => {
                fsync(&self.root_fd).map_err(|_| invalid("closure store fsync failed"))?;
            }
            Err(rustix::io::Errno::EXIST) | Err(rustix::io::Errno::NOTEMPTY) => {
                let existing = self.validate(&digest)?;
                remove_tree(&self.root_fd, &temp_name)?;
                return Ok(existing);
            }
            Err(_) => {
                let _ = remove_tree(&self.root_fd, &temp_name);
                return Err(invalid("closure promotion failed"));
            }
        }
        self.validate(&digest)
    }

    /// Fully revalidates one retained closure before returning it.
    pub fn validate(&self, digest: &str) -> Result<ValidatedHarnessClosure, HarnessClosureError> {
        validate_hash(digest)?;
        let dir_fd = open_owned_dir(&self.root_fd, digest)?;
        let manifest_fd = open_direct_file(&dir_fd, MANIFEST_NAME)?;
        verify_secure_file(&manifest_fd, 0o600)?;
        let bytes = read_bounded(&manifest_fd, MAX_MANIFEST_BYTES)?;
        if hex(&Sha256::digest(&bytes)) != digest {
            return Err(invalid("manifest bytes do not match the closure digest"));
        }
        let manifest: ClosureManifest =
            serde_json::from_slice(&bytes).map_err(|_| invalid("manifest decoding failed"))?;
        validate_manifest(&manifest)?;
        let canonical = canonical_manifest(&manifest)?;
        if canonical != bytes {
            return Err(invalid("retained manifest is not canonical"));
        }

        let files_fd = open_owned_dir(&dir_fd, FILES_NAME)?;
        let expected: BTreeMap<&str, &ClosureNode> = manifest
            .nodes
            .iter()
            .map(|node| (node.path.as_str(), node))
            .collect();
        let mut found = BTreeSet::new();
        validate_tree(&files_fd, "", &expected, &mut found)?;
        if found.len() != expected.len() {
            return Err(invalid("closure is missing a manifest-listed node"));
        }
        let entries = list_names(&dir_fd)?;
        if entries != BTreeSet::from([FILES_NAME.to_owned(), MANIFEST_NAME.to_owned()]) {
            return Err(invalid("closure directory contains an unlisted entry"));
        }
        Ok(ValidatedHarnessClosure {
            digest: digest.to_owned(),
            manifest,
            path: self.root.join(digest),
            files_fd,
        })
    }

    fn create_temp(&self) -> Result<(String, OwnedFd), HarnessClosureError> {
        for _ in 0..8 {
            let mut random = [0u8; 12];
            getrandom::getrandom(&mut random)
                .map_err(|_| invalid("temporary name generation failed"))?;
            let name = format!("{TEMP_PREFIX}{}", hex(&random));
            match mkdirat(&self.root_fd, name.as_str(), Mode::from_raw_mode(0o700)) {
                Ok(()) => return Ok((name.clone(), open_owned_dir(&self.root_fd, &name)?)),
                Err(rustix::io::Errno::EXIST) => continue,
                Err(_) => return Err(invalid("temporary closure creation failed")),
            }
        }
        Err(invalid("temporary closure name collision"))
    }

    fn stage_candidate(
        &self,
        temp_fd: &OwnedFd,
        candidate: &ClosureCandidate,
    ) -> Result<(), HarnessClosureError> {
        mkdirat(temp_fd, FILES_NAME, Mode::from_raw_mode(0o700))
            .map_err(|_| invalid("closure files directory creation failed"))?;
        let files_fd = open_owned_dir(temp_fd, FILES_NAME)?;
        let source_fds = open_source_roots(&candidate.source_roots)?;
        for node in &candidate.manifest.nodes {
            let source_root = source_fds
                .get(&node.source_root)
                .ok_or_else(|| invalid("node source root is missing"))?;
            copy_node(source_root, &files_fd, node)?;
        }
        fsync(&files_fd).map_err(|_| invalid("closure files fsync failed"))?;
        let bytes = canonical_manifest(&candidate.manifest)?;
        write_new_file(temp_fd, MANIFEST_NAME, &bytes, 0o600)?;
        fsync(temp_fd).map_err(|_| invalid("temporary closure fsync failed"))?;
        Ok(())
    }
}

fn validate_source_root_set(candidate: &ClosureCandidate) -> Result<(), HarnessClosureError> {
    let expected: BTreeSet<&str> = candidate
        .manifest
        .source_roots
        .iter()
        .map(String::as_str)
        .collect();
    let actual: BTreeSet<&str> = candidate.source_roots.keys().map(String::as_str).collect();
    if expected != actual {
        return Err(invalid(
            "candidate source roots do not exactly match the manifest",
        ));
    }
    Ok(())
}

fn open_source_roots(
    roots: &BTreeMap<String, PathBuf>,
) -> Result<BTreeMap<String, OwnedFd>, HarnessClosureError> {
    roots
        .iter()
        .map(|(name, path)| {
            let fd = openat(
                CWD,
                path,
                OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| invalid("source root open failed"))?;
            let stat = rustix::fs::fstat(&fd).map_err(|_| invalid("source root stat failed"))?;
            if mode_bits(&stat) & S_IFMT != S_IFDIR {
                return Err(invalid("source root is not a directory"));
            }
            Ok((name.clone(), fd))
        })
        .collect()
}

fn copy_node(
    source_root: &OwnedFd,
    files_root: &OwnedFd,
    node: &ClosureNode,
) -> Result<(), HarnessClosureError> {
    let source = open_relative_file(source_root, &node.source_path)
        .map_err(|_| invalid("source node is missing or insecure"))?;
    let before = rustix::fs::fstat(&source).map_err(|_| invalid("source node stat failed"))?;
    if mode_bits(&before) & S_IFMT != S_IFREG || before.st_size as u64 != node.size_bytes {
        return Err(invalid("source node shape or size diverges from manifest"));
    }

    let (parent, basename) = create_parent_dirs(files_root, &node.path)?;
    let destination = openat(
        &parent,
        basename.as_str(),
        OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        mode_from_u32(node.mode),
    )
    .map_err(|_| invalid("closure node creation failed"))?;
    rustix::fs::fchmod(&destination, mode_from_u32(node.mode))
        .map_err(|_| invalid("closure node chmod failed"))?;

    let mut reader = std::fs::File::from(
        rustix::io::dup(&source).map_err(|_| invalid("source node descriptor dup failed"))?,
    );
    let mut writer = std::fs::File::from(
        rustix::io::dup(&destination)
            .map_err(|_| invalid("destination node descriptor dup failed"))?,
    );
    let mut hasher = Sha256::new();
    let mut copied = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| invalid("source node read failed"))?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(count as u64)
            .ok_or_else(|| invalid("source node size overflow"))?;
        if copied > node.size_bytes {
            return Err(invalid("source node grew during copy"));
        }
        hasher.update(&buffer[..count]);
        writer
            .write_all(&buffer[..count])
            .map_err(|_| invalid("closure node write failed"))?;
    }
    writer
        .flush()
        .map_err(|_| invalid("closure node flush failed"))?;
    fsync(&destination).map_err(|_| invalid("closure node fsync failed"))?;
    let after = rustix::fs::fstat(&source).map_err(|_| invalid("source node stat failed"))?;
    if !same_file_snapshot(&before, &after)
        || copied != node.size_bytes
        || hex(&hasher.finalize()) != node.sha256
    {
        return Err(invalid("source node bytes diverge from manifest"));
    }
    verify_secure_file(&destination, node.mode)?;
    Ok(())
}

fn same_file_snapshot(before: &rustix::fs::Stat, after: &rustix::fs::Stat) -> bool {
    #[allow(clippy::unnecessary_cast)]
    {
        before.st_dev as u64 == after.st_dev as u64
            && before.st_ino as u64 == after.st_ino as u64
            && before.st_size == after.st_size
            && before.st_mtime == after.st_mtime
            && before.st_mtime_nsec == after.st_mtime_nsec
    }
}

fn create_parent_dirs(
    root: &OwnedFd,
    relative: &str,
) -> Result<(OwnedFd, String), HarnessClosureError> {
    let mut parts = relative.split('/').peekable();
    let mut current =
        rustix::io::dup(root).map_err(|_| invalid("closure files descriptor dup failed"))?;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            return Ok((current, part.to_owned()));
        }
        match mkdirat(&current, part, Mode::from_raw_mode(0o700)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(_) => return Err(invalid("closure layout directory creation failed")),
        }
        current = open_owned_dir(&current, part)?;
    }
    Err(invalid("closure node path is empty"))
}

fn validate_tree(
    dir: &OwnedFd,
    prefix: &str,
    expected: &BTreeMap<&str, &ClosureNode>,
    found: &mut BTreeSet<String>,
) -> Result<(), HarnessClosureError> {
    for name in list_names(dir)? {
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let fd = openat(
            dir,
            name.as_str(),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(|_| invalid("closure tree entry open failed"))?;
        let stat = rustix::fs::fstat(&fd).map_err(|_| invalid("closure tree entry stat failed"))?;
        match mode_bits(&stat) & S_IFMT {
            S_IFDIR => {
                let prefix = format!("{relative}/");
                if !expected.keys().any(|path| path.starts_with(&prefix)) {
                    return Err(invalid("closure contains an unlisted directory"));
                }
                verify_owned_directory(&fd)?;
                validate_tree(&fd, &relative, expected, found)?;
            }
            S_IFREG => {
                let node = expected
                    .get(relative.as_str())
                    .ok_or_else(|| invalid("closure contains an unlisted file"))?;
                verify_node_file(&fd, node)?;
                found.insert(relative);
            }
            _ => return Err(invalid("closure contains a non-regular entry")),
        }
    }
    Ok(())
}

fn verify_node_file(fd: &OwnedFd, node: &ClosureNode) -> Result<(), HarnessClosureError> {
    verify_secure_file(fd, node.mode)?;
    let stat = rustix::fs::fstat(fd).map_err(|_| invalid("closure node stat failed"))?;
    if stat.st_size as u64 != node.size_bytes {
        return Err(invalid("closure node size diverges from manifest"));
    }
    let mut reader = std::fs::File::from(
        rustix::io::dup(fd).map_err(|_| invalid("closure node descriptor dup failed"))?,
    );
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| invalid("closure node read failed"))?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| invalid("closure node size overflow"))?;
        if total > node.size_bytes {
            return Err(invalid("closure node grew past its manifest size"));
        }
        hasher.update(&buffer[..count]);
    }
    if total != node.size_bytes || hex(&hasher.finalize()) != node.sha256 {
        return Err(invalid("closure node hash diverges from manifest"));
    }
    Ok(())
}

fn verify_secure_file(fd: &OwnedFd, expected_mode: u32) -> Result<(), HarnessClosureError> {
    let stat = rustix::fs::fstat(fd).map_err(|_| invalid("closure file stat failed"))?;
    let mode = mode_bits(&stat);
    if mode & S_IFMT != S_IFREG
        || stat.st_uid != owner_uid()
        || stat.st_nlink != 1
        || mode & 0o777 != expected_mode
    {
        return Err(invalid("closure file is not owner-only single-link"));
    }
    Ok(())
}

fn open_relative_file(root: &OwnedFd, relative: &str) -> Result<OwnedFd, HarnessClosureError> {
    validate_relative_path(relative)?;
    let mut parts = relative.split('/').peekable();
    let mut current =
        rustix::io::dup(root).map_err(|_| invalid("directory descriptor dup failed"))?;
    while let Some(part) = parts.next() {
        let last = parts.peek().is_none();
        let flags = if last {
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK
        } else {
            OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC
        };
        current = openat(&current, part, flags, Mode::empty())
            .map_err(|_| invalid("relative file traversal failed"))?;
        if !last {
            let stat = rustix::fs::fstat(&current)
                .map_err(|_| invalid("relative directory stat failed"))?;
            if mode_bits(&stat) & S_IFMT != S_IFDIR {
                return Err(invalid("relative path component is not a directory"));
            }
        }
    }
    Ok(current)
}

fn open_direct_file(parent: &OwnedFd, name: &str) -> Result<OwnedFd, HarnessClosureError> {
    openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(|_| invalid("closure file open failed"))
}

fn open_owned_dir(parent: &OwnedFd, name: &str) -> Result<OwnedFd, HarnessClosureError> {
    let fd = openat(
        parent,
        name,
        OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| invalid("closure directory open failed"))?;
    verify_owned_directory(&fd)?;
    Ok(fd)
}

fn verify_owned_directory(fd: &OwnedFd) -> Result<(), HarnessClosureError> {
    let stat = rustix::fs::fstat(fd).map_err(|_| invalid("closure directory stat failed"))?;
    let mode = mode_bits(&stat);
    if mode & S_IFMT != S_IFDIR || stat.st_uid != owner_uid() || mode & 0o777 != 0o700 {
        return Err(invalid("closure directory is not owner-only"));
    }
    Ok(())
}

fn list_names(dir: &OwnedFd) -> Result<BTreeSet<String>, HarnessClosureError> {
    let mut names = BTreeSet::new();
    let mut entries = Dir::read_from(dir).map_err(|_| invalid("closure directory read failed"))?;
    for entry in &mut entries {
        let entry = entry.map_err(|_| invalid("closure directory read failed"))?;
        let name = cstr_name(entry.file_name())?;
        if name == "." || name == ".." {
            continue;
        }
        if !names.insert(name) {
            return Err(invalid("closure directory contains duplicate names"));
        }
    }
    Ok(names)
}

fn cstr_name(name: &CStr) -> Result<String, HarnessClosureError> {
    let bytes = name.to_bytes();
    if bytes.is_empty() || bytes.len() > 255 {
        return Err(invalid("closure entry name is invalid"));
    }
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| invalid("closure entry name is not utf8"))
}

fn read_bounded(fd: &OwnedFd, cap: usize) -> Result<Vec<u8>, HarnessClosureError> {
    let reader = std::fs::File::from(
        rustix::io::dup(fd).map_err(|_| invalid("closure file descriptor dup failed"))?,
    );
    let mut bytes = Vec::new();
    reader
        .take((cap + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid("closure file read failed"))?;
    if bytes.len() > cap {
        return Err(invalid("closure file exceeds its size cap"));
    }
    Ok(bytes)
}

fn write_new_file(
    parent: &OwnedFd,
    name: &str,
    bytes: &[u8],
    mode: u32,
) -> Result<(), HarnessClosureError> {
    let fd = openat(
        parent,
        name,
        OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        mode_from_u32(mode),
    )
    .map_err(|_| invalid("closure metadata file creation failed"))?;
    rustix::fs::fchmod(&fd, mode_from_u32(mode))
        .map_err(|_| invalid("closure metadata file chmod failed"))?;
    let mut writer = std::fs::File::from(
        rustix::io::dup(&fd).map_err(|_| invalid("closure metadata descriptor dup failed"))?,
    );
    writer
        .write_all(bytes)
        .map_err(|_| invalid("closure metadata write failed"))?;
    writer
        .flush()
        .map_err(|_| invalid("closure metadata flush failed"))?;
    fsync(&fd).map_err(|_| invalid("closure metadata fsync failed"))?;
    verify_secure_file(&fd, mode)
}

fn child_exists(parent: &OwnedFd, name: &str) -> Result<bool, HarnessClosureError> {
    match rustix::fs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(_) => Ok(true),
        Err(rustix::io::Errno::NOENT) => Ok(false),
        Err(_) => Err(invalid("digest target stat failed")),
    }
}

fn remove_tree(parent: &OwnedFd, name: &str) -> Result<(), HarnessClosureError> {
    match unlinkat(parent, name, AtFlags::empty()) {
        Ok(()) | Err(rustix::io::Errno::NOENT) => return Ok(()),
        Err(rustix::io::Errno::ISDIR) | Err(rustix::io::Errno::PERM) => {}
        Err(_) => return Err(invalid("temporary closure removal failed")),
    }
    let dir = open_owned_dir(parent, name)?;
    for child in list_names(&dir)? {
        remove_tree(&dir, &child)?;
    }
    unlinkat(parent, name, AtFlags::REMOVEDIR)
        .map_err(|_| invalid("temporary closure directory removal failed"))
}

fn open_or_create_store_path(path: &Path) -> Result<OwnedFd, HarnessClosureError> {
    let (anchor_name, components): (&str, Vec<_>) = if path.is_absolute() {
        (
            "/",
            path.components()
                .filter_map(|component| match component {
                    Component::RootDir => None,
                    Component::Normal(name) => Some(name),
                    _ => Some(std::ffi::OsStr::new("")),
                })
                .collect(),
        )
    } else {
        (
            ".",
            path.components()
                .map(|component| match component {
                    Component::CurDir => std::ffi::OsStr::new("."),
                    Component::Normal(name) => name,
                    _ => std::ffi::OsStr::new(""),
                })
                .collect(),
        )
    };
    if components.iter().any(|component| component.is_empty()) {
        return Err(invalid("closure store path is not normalized"));
    }
    let mut current = openat(
        CWD,
        anchor_name,
        OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| invalid("closure store anchor open failed"))?;
    verify_safe_ancestor(&current)?;
    for (index, component) in components.iter().enumerate() {
        if *component == std::ffi::OsStr::new(".") {
            continue;
        }
        match openat(
            &current,
            component.as_bytes(),
            OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(next) => current = next,
            Err(rustix::io::Errno::NOENT) => {
                mkdirat(&current, component.as_bytes(), Mode::from_raw_mode(0o700))
                    .map_err(|_| invalid("closure store directory creation failed"))?;
                current = openat(
                    &current,
                    component.as_bytes(),
                    OFlags::DIRECTORY | OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| invalid("closure store directory open failed"))?;
            }
            Err(_) => return Err(invalid("closure store path traversal failed")),
        }
        if index + 1 == components.len() {
            verify_owned_directory(&current)?;
        } else {
            verify_safe_ancestor(&current)?;
        }
    }
    verify_owned_directory(&current)?;
    Ok(current)
}

fn verify_safe_ancestor(fd: &OwnedFd) -> Result<(), HarnessClosureError> {
    let stat = rustix::fs::fstat(fd).map_err(|_| invalid("store ancestor stat failed"))?;
    let mode = mode_bits(&stat);
    if mode & S_IFMT != S_IFDIR
        || (stat.st_uid != owner_uid() && stat.st_uid != 0)
        || (mode & 0o022 != 0 && mode & S_ISVTX == 0)
    {
        return Err(invalid("closure store ancestor is insecure"));
    }
    Ok(())
}

fn owner_uid() -> u32 {
    rustix::process::geteuid().as_raw()
}

#[cfg(target_os = "macos")]
fn mode_from_u32(mode: u32) -> Mode {
    Mode::from_raw_mode(u16::try_from(mode).expect("validated mode fits macOS mode_t"))
}

#[cfg(not(target_os = "macos"))]
fn mode_from_u32(mode: u32) -> Mode {
    Mode::from_raw_mode(mode)
}

#[cfg(target_os = "macos")]
fn mode_bits(stat: &rustix::fs::Stat) -> u32 {
    u32::from(stat.st_mode)
}

#[cfg(not(target_os = "macos"))]
fn mode_bits(stat: &rustix::fs::Stat) -> u32 {
    stat.st_mode
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}
