//! Checkout snapshots: worktree-aware open, HEAD resolution, and a
//! content-addressed dirty fingerprint, taken once per request.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use gix::bstr::{BStr, ByteSlice};
use sha2::{Digest, Sha256};

const HASH_CHUNK_BYTES: usize = 64 * 1024;

/// Worker-thread ceiling for the status scan. Spawn and coordination cost commentlint: allow(JUDGE)
/// grows with core count while the stat-bound scan does not, so an uncapped commentlint: allow(JUDGE)
/// scan on a many-core host spends more on threads than on the walk. gix commentlint: allow(JUDGE)
/// clamps the value to available parallelism on smaller hosts. commentlint: allow(JUDGE)
const STATUS_SCAN_THREAD_CAP: usize = 4;

/// Deadline plus cooperative interrupt flag threaded through every walk the
/// engine performs. The flag is the shape gix status accepts, so an async
/// host can map cancellation onto it without this crate depending on a
/// runtime.
#[derive(Debug, Clone)]
pub struct EvalBudget {
    deadline: Option<Instant>,
    interrupt: Arc<AtomicBool>,
}

impl EvalBudget {
    pub fn new(deadline: Option<Instant>, interrupt: Arc<AtomicBool>) -> Self {
        Self {
            deadline,
            interrupt,
        }
    }

    /// Budget with no deadline and a private interrupt flag.
    pub fn unbounded() -> Self {
        Self::new(None, Arc::new(AtomicBool::new(false)))
    }

    /// The flag gix walks poll; exceeding the deadline also raises it so
    /// in-flight scans stop at their next poll.
    pub fn interrupt_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.interrupt)
    }

    pub fn is_exhausted(&self) -> bool {
        if self.interrupt.load(Ordering::Relaxed) {
            return true;
        }
        match self.deadline {
            Some(deadline) if Instant::now() >= deadline => {
                self.interrupt.store(true, Ordering::Relaxed);
                true
            }
            _ => false,
        }
    }

    pub fn check(&self) -> Result<(), SnapshotError> {
        if self.is_exhausted() {
            Err(SnapshotError::BudgetExhausted)
        } else {
            Ok(())
        }
    }
}

struct DeadlineWatchdog {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl DeadlineWatchdog {
    /// TICK bounds deadline detection and drop-time join latency to 25 ms.
    const TICK: std::time::Duration = std::time::Duration::from_millis(25);

    fn arm(budget: &EvalBudget) -> Option<Self> {
        let deadline = budget.deadline?;
        let interrupt = budget.interrupt_flag();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_signal = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            while !stop_signal.load(Ordering::Relaxed) {
                let now = Instant::now();
                if now >= deadline {
                    interrupt.store(true, Ordering::Relaxed);
                    return;
                }
                std::thread::sleep((deadline - now).min(Self::TICK));
            }
        });
        Some(Self {
            stop,
            handle: Some(handle),
        })
    }
}

impl Drop for DeadlineWatchdog {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Why a checkout snapshot could not be taken. Every variant renders the
/// request's objects uncertain; none of them is a store failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotError {
    /// The path is not a git checkout this engine can open.
    Open(String),
    /// The checkout has no resolvable HEAD commit (unborn branch).
    NoHead,
    /// Deadline exceeded or interrupt raised; partial results discarded.
    BudgetExhausted,
    /// The status scan or object access failed mid-walk.
    Scan(String),
}

impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Open(detail) => write!(f, "checkout open failed: {detail}"),
            Self::NoHead => f.write_str("checkout has no resolvable HEAD commit"),
            Self::BudgetExhausted => f.write_str("evaluation budget exhausted"),
            Self::Scan(detail) => write!(f, "checkout status scan failed: {detail}"),
        }
    }
}

impl std::error::Error for SnapshotError {}

/// One uncommitted entry: repo-relative path, status label, and a content
/// address (blob/content hash, or a fixed token for deletions).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct DirtyEntry {
    pub path: String,
    pub status: &'static str,
    pub content_hash: String,
}

/// Frozen view of one checkout, taken once per request: identity, HEAD, and
/// the dirty state. Cache keys derive from `identity`, `head`, and
/// `dirty_fingerprint`; the open repository handle serves the request's
/// object-database work and is never cached.
pub struct CheckoutSnapshot {
    repo: gix::Repository,
    identity: String,
    head: String,
    dirty_fingerprint: String,
    dirty_entries: Vec<DirtyEntry>,
}

impl CheckoutSnapshot {
    /// Stable per-worktree identity: the resolved `.git` directory, which
    /// distinguishes linked worktrees sharing one object store. This is
    /// deliberately not a project identity (clones stay distinct).
    pub fn identity(&self) -> &str {
        &self.identity
    }

    /// HEAD commit OID, lower hex.
    pub fn head(&self) -> &str {
        &self.head
    }

    /// Digest over the sorted set of (path, status, content hash) for
    /// staged, unstaged, untracked, and conflicted entries.
    pub fn dirty_fingerprint(&self) -> &str {
        &self.dirty_fingerprint
    }

    pub fn dirty_entries(&self) -> &[DirtyEntry] {
        &self.dirty_entries
    }

    /// Repo-relative uncommitted paths, for overlap classification against
    /// an object's affected paths.
    pub fn dirty_paths(&self) -> BTreeSet<&str> {
        self.dirty_entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect()
    }

    pub(crate) fn repo(&self) -> &gix::Repository {
        &self.repo
    }

    /// Returns only paths contained by the worktree.
    pub fn worktree_path(&self, rela_path: &str) -> Option<PathBuf> {
        contained_path(self.repo.workdir()?, Path::new(rela_path))
    }
}

impl std::fmt::Debug for CheckoutSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CheckoutSnapshot")
            .field("identity", &self.identity)
            .field("head", &self.head)
            .field("dirty_fingerprint", &self.dirty_fingerprint)
            .field("dirty_entries", &self.dirty_entries.len())
            .finish()
    }
}

/// Opens a checkout with isolated options: installation, user, and system
/// configuration stay unread, which keeps configured credential helpers and
/// filter drivers from ever becoming reachable. Repository-local
/// configuration is still honored for layout (worktrees, object store).
pub fn open_isolated(path: &Path) -> Result<gix::Repository, SnapshotError> {
    gix::open_opts(path, gix::open::Options::isolated())
        .map_err(|error| SnapshotError::Open(error.to_string()))
}

/// Takes the once-per-request checkout snapshot: HEAD plus a full status
/// scan under `budget`. Interruption or deadline exhaustion discards the
/// partial scan; a fingerprint is never built from a prefix of the walk.
pub fn snapshot_checkout(
    path: &Path,
    budget: &EvalBudget,
) -> Result<CheckoutSnapshot, SnapshotError> {
    budget.check()?;
    let mut repo = open_isolated(path)?;
    // Resolution re-reads the same commits and trees across anchors.
    repo.object_cache_size_if_unset(4 * 1024 * 1024);
    let identity = checkout_identity(&repo)?;
    let head = repo
        .head_id()
        .map_err(|_| SnapshotError::NoHead)?
        .detach()
        .to_string();
    // The scan polls between items and a clean checkout emits none;
    // `DeadlineWatchdog` interrupts the scan at `budget`'s deadline.
    let _watchdog = DeadlineWatchdog::arm(budget);
    let dirty_entries = scan_dirty_entries(&repo, budget)?;
    // A concurrent checkout, reset, or branch switch can pair old HEAD with
    // new index/worktree state; the scan rejects that inconsistent snapshot.
    let head_after = repo
        .head_id()
        .map_err(|_| SnapshotError::NoHead)?
        .detach()
        .to_string();
    if head_after != head {
        return Err(SnapshotError::Scan(
            "HEAD moved during the status scan".to_string(),
        ));
    }
    let dirty_fingerprint = fingerprint_entries(&dirty_entries, &sparse_state(&repo, budget)?);
    Ok(CheckoutSnapshot {
        repo,
        identity,
        head,
        dirty_fingerprint,
        dirty_entries,
    })
}

fn checkout_identity(repo: &gix::Repository) -> Result<String, SnapshotError> {
    let git_dir = repo
        .git_dir()
        .canonicalize()
        .map_err(|error| SnapshotError::Open(error.to_string()))?;
    // The digest suffix distinguishes non-UTF-8 git-dir paths that share a
    // lossy string.
    match git_dir.to_str() {
        Some(utf8) => Ok(utf8.to_owned()),
        None => {
            let raw = git_dir.as_os_str().as_encoded_bytes();
            Ok(format!(
                "{}#x{:x}",
                git_dir.to_string_lossy(),
                Sha256::digest(raw)
            ))
        }
    }
}

fn scan_dirty_entries(
    repo: &gix::Repository,
    budget: &EvalBudget,
) -> Result<Vec<DirtyEntry>, SnapshotError> {
    use gix::status::Item;

    let platform = repo
        .status(gix::progress::Discard)
        .map_err(|error| SnapshotError::Scan(error.to_string()))?
        .should_interrupt_owned(budget.interrupt_flag())
        // Collapsed untracked directories share one content-less fingerprint
        // entry; `Files` also overrides `status.showUntrackedFiles`.
        .untracked_files(gix::status::UntrackedFiles::Files)
        // Rename tracking would fold a delete+add pair into one entry;
        // the fingerprint wants the raw path set.
        .index_worktree_rewrites(None)
        .index_worktree_options_mut(|opts| opts.thread_limit = Some(STATUS_SCAN_THREAD_CAP))
        .tree_index_track_renames(gix::status::tree_index::TrackRenames::Disabled);
    let iter = platform
        .into_iter(None)
        .map_err(|error| SnapshotError::Scan(error.to_string()))?;

    let mut entries = BTreeSet::new();
    for item in iter {
        budget.check()?;
        let item = item.map_err(|error| SnapshotError::Scan(error.to_string()))?;
        let entry = match item {
            Item::IndexWorktree(item) => index_worktree_entry(repo, item, budget)?,
            Item::TreeIndex(change) => Some(tree_index_entry(&change)),
        };
        if let Some(entry) = entry {
            entries.insert(entry);
        }
    }
    budget.check()?;
    // The status walk skips stats for assume-valid entries; hash their
    // worktree content to preserve key correctness.
    let index = repo
        .index_or_empty()
        .map_err(|error| SnapshotError::Scan(error.to_string()))?;
    for entry in index.entries() {
        if !entry.flags.contains(gix::index::entry::Flags::ASSUME_VALID) {
            continue;
        }
        budget.check()?;
        let rela_path = entry.path(&index);
        entries.insert(DirtyEntry {
            content_hash: worktree_content_hash(repo, rela_path, budget)?,
            path: path_string(rela_path),
            status: "assume_valid",
        });
    }
    Ok(entries.into_iter().collect())
}

fn index_worktree_entry(
    repo: &gix::Repository,
    item: gix::status::index_worktree::Item,
    budget: &EvalBudget,
) -> Result<Option<DirtyEntry>, SnapshotError> {
    use gix::status::index_worktree::Item;
    use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};

    match item {
        Item::Modification {
            rela_path, status, ..
        } => {
            let entry = match status {
                EntryStatus::Conflict { .. } => Some(DirtyEntry {
                    content_hash: conflict_content_hash(repo, rela_path.as_ref(), budget)?,
                    path: path_string(rela_path.as_ref()),
                    status: "conflicted",
                }),
                EntryStatus::Change(Change::Removed) => Some(DirtyEntry {
                    path: path_string(rela_path.as_ref()),
                    status: "removed",
                    content_hash: "absent".to_string(),
                }),
                EntryStatus::Change(_) => Some(DirtyEntry {
                    content_hash: worktree_content_hash(repo, rela_path.as_ref(), budget)?,
                    path: path_string(rela_path.as_ref()),
                    status: "modified",
                }),
                EntryStatus::IntentToAdd => Some(DirtyEntry {
                    content_hash: worktree_content_hash(repo, rela_path.as_ref(), budget)?,
                    path: path_string(rela_path.as_ref()),
                    status: "intent_to_add",
                }),
                // A racy stat with unchanged content is not dirty.
                EntryStatus::NeedsUpdate(_) => None,
            };
            Ok(entry)
        }
        Item::DirectoryContents { entry, .. } => {
            if !matches!(entry.status, gix::dir::entry::Status::Untracked) {
                return Ok(None);
            }
            if entry.disk_kind.is_some_and(|kind| kind.is_dir()) {
                // `UntrackedFiles::Files` emits contained files individually,
                // so directory entries have no content to hash.
                return Ok(Some(DirtyEntry {
                    path: path_string(entry.rela_path.as_ref()),
                    status: "untracked",
                    content_hash: "directory".to_string(),
                }));
            }
            Ok(Some(DirtyEntry {
                content_hash: worktree_content_hash(repo, entry.rela_path.as_ref(), budget)?,
                path: path_string(entry.rela_path.as_ref()),
                status: "untracked",
            }))
        }
        // Rewrites are disabled in the scan configuration.
        Item::Rewrite { .. } => Ok(None),
    }
}

/// The digest suffix distinguishes non-UTF-8 paths that share a lossy
/// string.
fn path_string(rela_path: &BStr) -> String {
    match rela_path.to_str() {
        Ok(utf8) => utf8.to_owned(),
        Err(_) => format!(
            "{}#x{:x}",
            rela_path.to_str_lossy(),
            Sha256::digest(rela_path.as_bytes())
        ),
    }
}

fn tree_index_entry(change: &gix::diff::index::Change) -> DirtyEntry {
    use gix::diff::index::Change;
    let (status, location, id): (&'static str, _, _) = match change {
        Change::Addition {
            location,
            id,
            entry_mode,
            ..
        } => (
            "staged_added",
            location,
            format!("{}:{:o}", id.as_ref(), entry_mode.bits()),
        ),
        Change::Deletion { location, .. } => ("staged_removed", location, "absent".to_string()),
        Change::Modification {
            location,
            id,
            entry_mode,
            ..
        } => (
            "staged_modified",
            location,
            format!("{}:{:o}", id.as_ref(), entry_mode.bits()),
        ),
        Change::Rewrite {
            location,
            entry_mode,
            id,
            ..
        } => (
            "staged_rewritten",
            location,
            format!("{}:{:o}", id.as_ref(), entry_mode.bits()),
        ),
    };
    DirtyEntry {
        path: path_string(location.as_ref()),
        status,
        content_hash: id,
    }
}

/// Content hash of a worktree file, so the fingerprint changes exactly when
/// content changes (stat-only churn keeps the same key).
///
/// Symlinks hash their target path rather than the pointee.
/// Non-regular files use a fixed token because opening them can block forever.
fn worktree_content_hash(
    repo: &gix::Repository,
    rela_path: &BStr,
    budget: &EvalBudget,
) -> Result<String, SnapshotError> {
    budget.check()?;
    let Some(workdir) = repo.workdir() else {
        return Ok("no-worktree".to_string());
    };
    // A lossy conversion would look up the wrong file for non-UTF-8 names.
    let Ok(rela_path) = gix::path::try_from_bstr(rela_path) else {
        return Ok("unreadable".to_string());
    };
    let Some(path) = contained_path(workdir, &rela_path) else {
        return Ok("out-of-worktree".to_string());
    };
    // Inspection failures use `unreadable`, distinct from content hashes.
    let Ok(metadata) = std::fs::symlink_metadata(&path) else {
        return Ok("unreadable".to_string());
    };
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        let Ok(target) = std::fs::read_link(&path) else {
            return Ok("unreadable".to_string());
        };
        let mut hash = Sha256::new();
        hash.update(b"symlink\0");
        hash.update(target.as_os_str().as_encoded_bytes());
        return Ok(format!("symlink:{:x}", hash.finalize()));
    }
    if !file_type.is_file() {
        if file_type.is_dir() {
            // A dirty tracked gitlink resolves to a directory; its HEAD is
            // the content that moved.
            return Ok(submodule_head_hash(&path));
        }
        return Ok("not-a-regular-file".to_string());
    }
    let Ok(mut file) = std::fs::File::open(&path) else {
        return Ok("unreadable".to_string());
    };
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; HASH_CHUNK_BYTES];
    loop {
        budget.check()?;
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => hash.update(&buffer[..read]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Ok("unreadable".to_string()),
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// The hash covers the stage-1/2/3 index entries and the worktree content:
/// replacing a conflict's base, ours, or theirs blob changes the checkout
/// state even when the worktree file is untouched.
fn conflict_content_hash(
    repo: &gix::Repository,
    rela_path: &BStr,
    budget: &EvalBudget,
) -> Result<String, SnapshotError> {
    use gix::index::entry::Stage;

    let mut hash = Sha256::new();
    hash.update(b"conflict\0");
    match repo.index_or_empty() {
        Ok(index) => {
            for stage in [Stage::Base, Stage::Ours, Stage::Theirs] {
                match index.entry_by_path_and_stage(rela_path, stage) {
                    Some(entry) => {
                        hash.update(b"stage\0");
                        hash.update(entry.id.as_slice());
                        hash.update(entry.mode.bits().to_le_bytes());
                    }
                    None => hash.update(b"absent\0"),
                }
            }
        }
        Err(_) => hash.update(b"index-unreadable\0"),
    }
    let worktree = worktree_content_hash(repo, rela_path, budget)?;
    hash.update(worktree.as_bytes());
    Ok(format!("conflict:{:x}", hash.finalize()))
}

/// Rejects paths that escape `workdir`: absolute paths, `..` components,
/// and symlinked ancestors can resolve outside it.
fn contained_path(workdir: &Path, rela_path: &Path) -> Option<PathBuf> {
    if rela_path.as_os_str().is_empty() {
        return None;
    }
    let escapes = rela_path
        .components()
        .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir));
    if escapes {
        return None;
    }
    let joined = workdir.join(rela_path);
    let canonical_workdir = workdir.canonicalize().ok()?;
    // Canonicalize the deepest existing ancestor so the final component
    // remains unresolved.
    let mut ancestor = joined.parent()?;
    let resolved = loop {
        match ancestor.canonicalize() {
            Ok(resolved) => break resolved,
            Err(_) => ancestor = ancestor.parent()?,
        }
    };
    if !resolved.starts_with(&canonical_workdir) {
        return None;
    }
    Some(joined)
}

fn fingerprint_entries(entries: &[DirtyEntry], sparse_state: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"mc-dirty-fingerprint-v3\0");
    // Sparse state distinguishes layouts that materialize different files
    // from the same HEAD.
    hash.update((sparse_state.len() as u64).to_le_bytes());
    hash.update(sparse_state);
    for entry in entries {
        // Length prefixes make adjacent fields unambiguous.
        for field in [
            entry.path.as_bytes(),
            entry.status.as_bytes(),
            entry.content_hash.as_bytes(),
        ] {
            hash.update((field.len() as u64).to_le_bytes());
            hash.update(field);
        }
    }
    format!("{:x}", hash.finalize())
}

fn submodule_head_hash(path: &Path) -> String {
    let Ok(submodule) = gix::open_opts(path, gix::open::Options::isolated()) else {
        return "not-a-regular-file".to_string();
    };
    match submodule.head_id() {
        Ok(head) => format!("gitlink:{}", head.detach()),
        Err(_) => "gitlink-unborn".to_string(),
    }
}

/// Sparse-checkout configuration and patterns determine which paths
/// materialize.
fn sparse_state(repo: &gix::Repository, budget: &EvalBudget) -> Result<Vec<u8>, SnapshotError> {
    let config = repo.config_snapshot();
    let mut state = vec![
        config.boolean("core.sparseCheckout").unwrap_or(false) as u8,
        config.boolean("core.sparseCheckoutCone").unwrap_or(false) as u8,
    ];
    let patterns_path = repo.git_dir().join("info/sparse-checkout");
    // Opening a FIFO here can block indefinitely.
    let is_regular = std::fs::symlink_metadata(&patterns_path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false);
    if !is_regular {
        return Ok(state);
    }
    let Ok(mut file) = std::fs::File::open(&patterns_path) else {
        return Ok(state);
    };
    let mut buffer = vec![0u8; HASH_CHUNK_BYTES];
    loop {
        budget.check()?;
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => state.extend_from_slice(&buffer[..read]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    Ok(state)
}
