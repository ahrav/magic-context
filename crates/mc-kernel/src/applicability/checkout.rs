//! Checkout snapshots: worktree-aware open, HEAD resolution, and a
//! content-addressed dirty fingerprint, taken once per request.

use std::cell::OnceCell;
use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::os::fd::OwnedFd;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use gix::bstr::{BStr, ByteSlice};
use rustix::fs::{self as rfs, AtFlags, OFlags};
use sha2::{Digest, Sha256};

const HASH_CHUNK_BYTES: usize = 64 * 1024;

/// A path re-resolved after containment validation can escape if an ancestor
/// is replaced with a symlink before open, because `NOFOLLOW` only ever
/// guards the final component. Walking one component at a time with
/// `NOFOLLOW` refuses a symlink at every level, and each descriptor pins its
/// directory's inode, so the returned parent cannot be moved out from under
/// the caller.
///
/// `PATH` descriptors allow child resolution with directory search
/// permission. Requiring read access would refuse a tracked file under an
/// execute-only directory that git reads fine, and the resulting
/// `out-of-worktree` token would then stop moving when its content changed. A
/// `PATH` descriptor still serves as the base for `openat`, `statat`, and
/// `readlinkat`.
///
/// `workdir` is trusted; its resolved directory is the containment root.
enum ParentDir {
    Opened(OwnedFd, OsString),
    /// An ancestor does not exist, so nothing beneath it exists either. Read
    /// repair needs that separated from a walk that failed: absence is a
    /// definite answer about the checked path, whereas a refused or unreadable
    /// ancestor hides whatever is really there.
    AncestorAbsent,
    Unresolvable,
}

impl ParentDir {
    /// For callers that owe the same answer however the walk stopped.
    fn opened(self) -> Option<(OwnedFd, OsString)> {
        match self {
            Self::Opened(dir, name) => Some((dir, name)),
            Self::AncestorAbsent | Self::Unresolvable => None,
        }
    }
}

fn open_parent_beneath(workdir: &Path, rela_path: &Path) -> ParentDir {
    let mut names = Vec::new();
    for component in rela_path.components() {
        match component {
            Component::Normal(name) => names.push(name),
            Component::CurDir => {}
            // Absolute roots, prefixes, and `..` leave the worktree.
            _ => return ParentDir::Unresolvable,
        }
    }
    let Some((final_name, ancestors)) = names.split_last() else {
        return ParentDir::Unresolvable;
    };
    let Ok(mut dir) = rfs::open(
        workdir,
        OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC,
        rfs::Mode::empty(),
    ) else {
        return ParentDir::Unresolvable;
    };
    for ancestor in ancestors {
        match rfs::openat(
            &dir,
            *ancestor,
            OFlags::PATH | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            rfs::Mode::empty(),
        ) {
            Ok(next) => dir = next,
            // Only absence is definite. `O_PATH` with `NOFOLLOW` opens a
            // symlinked ancestor rather than refusing it, so `O_DIRECTORY`
            // rejects that link as `ENOTDIR` — indistinguishable here from a
            // plain non-directory, and the link hides whatever it points at.
            // Both stay unresolvable.
            Err(rustix::io::Errno::NOENT) => return ParentDir::AncestorAbsent,
            Err(_) => return ParentDir::Unresolvable,
        }
    }
    ParentDir::Opened(dir, (*final_name).to_os_string())
}

/// A path can be replaced after a stat; validate the opened descriptor
/// instead. A swapped-in symlink would move the read outside the checkout,
/// and a FIFO would block the request without reaching another budget poll,
/// so `NOFOLLOW` and `NONBLOCK` refuse both at open time and the
/// descriptor's own mode settles what was reached.
///
/// `Ok(None)` means no regular file is there — it vanished, or it is a
/// symlink, FIFO, directory, or device. `Err` keeps genuine failures
/// distinguishable, since those hide content that still governs the
/// checkout.
fn open_regular_no_follow_at<Fd: std::os::fd::AsFd>(
    dir: Fd,
    name: &OsStr,
) -> Result<Option<std::fs::File>, rustix::io::Errno> {
    let file = match rfs::openat(
        dir,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        rfs::Mode::empty(),
    ) {
        Ok(file) => std::fs::File::from(file),
        // NOENT is a vanished path; LOOP answers NOFOLLOW on a symlink,
        // NXIO answers NONBLOCK on a reader-less FIFO, and ISDIR answers a
        // directory. All four report the absence of a regular file here
        // rather than a failure to scan one.
        Err(
            rustix::io::Errno::NOENT
            | rustix::io::Errno::LOOP
            | rustix::io::Errno::NXIO
            | rustix::io::Errno::ISDIR,
        ) => return Ok(None),
        Err(error) => return Err(error),
    };
    let stat = rfs::fstat(&file)?;
    if !rfs::FileType::from_raw_mode(stat.st_mode).is_file() {
        return Ok(None);
    }
    Ok(Some(file))
}

/// Worker-thread ceiling for the status scan. Spawn and coordination cost
/// grows with core count while the stat-bound scan does not, so an uncapped
/// scan on a many-core host spends more on threads than on the walk. gix
/// clamps the value to available parallelism on smaller hosts.
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

    /// The instant this budget expires, for callers that hand a deadline to a
    /// blocking primitive instead of polling `is_exhausted` themselves.
    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    /// Both cancellation mechanisms as one value, for the store primitives that
    /// wait on a connection. A budget with no deadline still cancels through its
    /// interrupt, so the interrupt travels with the deadline.
    pub(crate) fn acquire_limit(&self) -> crate::open::AcquireLimit {
        crate::open::AcquireLimit::new(self.deadline, Some(Arc::clone(&self.interrupt)))
    }
}

/// `DeadlineWatchdog` raises `budget`'s interrupt when its deadline passes, so
/// an in-flight gix walk stops at its next poll.
///
/// The wait is a condvar rather than a sleep: `drop` has to stop this thread
/// promptly, and a sleeping thread cannot be woken, which would add the
/// remainder of its nap to every snapshot that finishes early.
struct DeadlineWatchdog {
    stop: Arc<(Mutex<bool>, Condvar)>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl DeadlineWatchdog {
    fn arm(budget: &EvalBudget) -> Option<Self> {
        let deadline = budget.deadline?;
        let interrupt = budget.interrupt_flag();
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let signal = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            let (lock, woken) = &*signal;
            // A poisoned lock still carries the flag, and its only writer sets
            // it to `true`, so an unwind mid-update cannot invent a stop.
            let mut stop = lock.lock().unwrap_or_else(|error| error.into_inner());
            while !*stop {
                let now = Instant::now();
                if now >= deadline {
                    interrupt.store(true, Ordering::Relaxed);
                    return;
                }
                // The guard is held across the deadline test, so a `drop`
                // racing this wait cannot signal into the gap and be missed.
                stop = woken
                    .wait_timeout(stop, deadline - now)
                    .unwrap_or_else(|error| error.into_inner())
                    .0;
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
        let (lock, woken) = &*self.stop;
        {
            let mut stop = lock.lock().unwrap_or_else(|error| error.into_inner());
            *stop = true;
        }
        woken.notify_all();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Why a checkout snapshot could not be taken. Every variant renders the
/// request's objects uncertain; none of them is a store failure.
#[derive(thiserror::Error, Debug, Clone, PartialEq, Eq)]
pub enum SnapshotError {
    /// The path is not a git checkout this engine can open.
    #[error("checkout open failed: {0}")]
    Open(String),
    /// The checkout has no resolvable HEAD commit (unborn branch).
    #[error("checkout has no resolvable HEAD commit")]
    NoHead,
    /// Deadline exceeded or interrupt raised; partial results discarded.
    #[error("evaluation budget exhausted")]
    BudgetExhausted,
    /// The status scan or object access failed mid-walk.
    #[error("checkout status scan failed: {0}")]
    Scan(String),
}

/// One scan's budget together with its submodule nesting depth. Recursing
/// into a dirty gitlink re-enters the scan, so the depth travels with the
/// budget rather than widening four private signatures.
#[derive(Clone, Copy)]
struct ScanCtx<'a> {
    budget: &'a EvalBudget,
    depth: u32,
}

impl<'a> ScanCtx<'a> {
    /// Nesting beyond this depth ends the scan rather than keying a gitlink
    /// whose contents went unread.
    const MAX_SUBMODULE_DEPTH: u32 = 3;

    fn root(budget: &'a EvalBudget) -> Self {
        Self { budget, depth: 0 }
    }

    fn check(&self) -> Result<(), SnapshotError> {
        self.budget.check()
    }

    /// The context one submodule deeper, or `None` at the depth limit.
    fn nested(&self) -> Option<Self> {
        (self.depth < Self::MAX_SUBMODULE_DEPTH).then_some(Self {
            budget: self.budget,
            depth: self.depth + 1,
        })
    }
}

/// One uncommitted entry: repo-relative path, status label, and a content
/// address (blob/content hash, or a fixed token for deletions).
///
/// `path_encoding` distinguishes valid UTF-8 paths from lossy renderings of
/// non-UTF-8 paths. Without it, a file named exactly like some byte path's
/// lossy rendering yields an identical tuple, so the set keeps one entry
/// while the two checkouts it stands for hold different bytes.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct DirtyEntry {
    pub path: String,
    pub path_encoding: PathEncoding,
    /// The path exactly as the repository holds it. `path` is a rendering for
    /// display and fingerprinting and is lossy for bytes that are not valid
    /// UTF-8, so only these bytes identify the file; a rendering cannot say
    /// where loss occurred, which leaves even its prefixes ambiguous.
    pub raw_path: Vec<u8>,
    pub status: &'static str,
    pub content_hash: String,
}

/// Whether `DirtyEntry::path` is the path itself or a lossy rendering of
/// bytes that are not valid UTF-8.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PathEncoding {
    Utf8,
    /// Lossy rendering with a digest of the raw bytes appended.
    LossyWithDigest,
}

impl DirtyEntry {
    /// Whether this entry records an uncommitted change, as opposed to an index
    /// bookkeeping flag the status walk does not inspect.
    ///
    /// `skip_worktree` and `assume_valid` entries are keyed straight from the
    /// index so a fingerprint covers state the walk skips. Git reports both
    /// clean, and a sparse checkout marks every unmaterialized path
    /// `skip_worktree`, so treating them as dirty would gate every object
    /// declaring such a path forever.
    pub fn is_uncommitted_change(&self) -> bool {
        !matches!(self.status, "skip_worktree" | "assume_valid")
    }
}

impl PathEncoding {
    fn as_bytes(self) -> &'static [u8] {
        match self {
            Self::Utf8 => b"utf8",
            Self::LossyWithDigest => b"lossy",
        }
    }
}

/// Frozen view of one checkout, taken once per request: identity, HEAD,
/// repository state, and the dirty state. Cache keys derive from `identity`,
/// `head`, `repository_state`, and the dirty entries an object declares; the
/// open repository handle serves the request's object-database work and is
/// never cached.
pub struct CheckoutSnapshot {
    repo: gix::Repository,
    identity: String,
    head: String,
    repository_state: String,
    dirty_fingerprint: String,
    dirty_entries: Vec<DirtyEntry>,
    shallow: bool,
    commit_graph: OnceCell<Option<gix::commitgraph::Graph>>,
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

    /// `repository_state` digests sparse-checkout configuration and shallow boundary.
    ///
    /// Unshallowing or a sparse-pattern edit moves neither HEAD nor the
    /// worktree, so a cache key for a verdict that read history reach or path
    /// materialization has to carry this generation.
    ///
    /// Object availability is deliberately outside it: a fetch can supply a
    /// missing object without moving HEAD, the worktree, sparse configuration,
    /// or the shallow file, so a verdict that rested on an absent object must
    /// not be retained against this generation at all.
    pub fn repository_state(&self) -> &str {
        &self.repository_state
    }

    /// Whether the repository was shallow when this snapshot was taken.
    ///
    /// A shallow boundary truncates every graph walk, so a negative ancestry
    /// result cannot be trusted. Readers take it from here rather than from
    /// the live repository, which can be deepened or re-truncated after the
    /// fingerprint was fixed.
    pub fn is_shallow(&self) -> bool {
        self.shallow
    }

    /// Whether sparse configuration and the shallow boundary still match the
    /// state this snapshot's cache keys record.
    ///
    /// The keys record that state once, while a graph walk reads the live
    /// repository later. A concurrent fetch between the two makes a walk
    /// answer for a boundary the key does not name, and a boundary that moves
    /// away and back leaves that answer reachable under the original key.
    /// State that cannot be re-read counts as moved: an unverifiable boundary
    /// is no basis for retaining a verdict derived from one.
    pub(super) fn repository_state_still_current(&self, budget: &EvalBudget) -> bool {
        let ctx = ScanCtx::root(budget);
        match repository_state(&self.repo, &ctx) {
            Ok((state, _)) => hex_digest(&state) == self.repository_state,
            Err(_) => false,
        }
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

    pub(crate) fn revision_graph<T>(
        &self,
    ) -> gix::revwalk::Graph<'_, '_, gix::revwalk::graph::Commit<T>> {
        let commit_graph = self
            .commit_graph
            .get_or_init(|| self.repo.commit_graph_if_enabled().ok().flatten());
        self.repo.revision_graph(commit_graph.as_ref())
    }

    /// Joins `rela_path` onto the worktree, rejecting paths whose *ancestors*
    /// leave it: absolute paths, `..` components, and symlinked parent
    /// directories.
    ///
    /// The final component stays unresolved, so a returned path may itself be
    /// a symlink pointing outside the worktree — `worktree_content_hash` needs
    /// that in order to hash the link rather than its target. A caller that
    /// opens the path with following enabled therefore has to resolve and
    /// re-check it, or use no-follow access such as `symlink_metadata`.
    pub fn worktree_path(&self, rela_path: &str) -> Option<PathBuf> {
        contained_path(self.repo.workdir()?, Path::new(rela_path))
    }
}

/// Shape of one worktree entry, established without following a symlink at any
/// level — ancestor or final.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum WorktreeEntry {
    RegularFile,
    Absent,
    Symlink,
    Directory,
    /// Present as something no reader can consume: FIFO, socket, device.
    Other,
    /// The declared spelling leaves the worktree, or its ancestors could not be
    /// walked beneath it.
    Unresolvable(String),
}

impl CheckoutSnapshot {
    /// Inspects `rela_path` beneath the worktree without traversing a symlink.
    ///
    /// `worktree_path` validates containment against a pathname, which a
    /// concurrent checkout can invalidate by replacing an ancestor directory
    /// with a symlink before the caller looks. Resolving through
    /// `open_parent_beneath` pins every ancestor's inode instead, so no rung of
    /// the path can be swapped out from under this stat.
    pub(super) fn worktree_entry(&self, rela_path: &str) -> WorktreeEntry {
        let Some(workdir) = self.repo.workdir() else {
            return WorktreeEntry::Unresolvable(format!(
                "path {rela_path} has no worktree to resolve against"
            ));
        };
        // A malformed spelling and an ancestor that cannot be walked both stop
        // `open_parent_beneath`, and read repair needs them distinguished.
        if !Path::new(rela_path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        {
            return WorktreeEntry::Unresolvable(format!(
                "path {rela_path} is not a plain relative path inside the checkout"
            ));
        }
        let (dir, name) = match open_parent_beneath(workdir, Path::new(rela_path)) {
            ParentDir::Opened(dir, name) => (dir, name),
            // Nothing exists beneath a missing ancestor, so the checked path is
            // definitely absent rather than unexamined.
            ParentDir::AncestorAbsent => return WorktreeEntry::Absent,
            ParentDir::Unresolvable => {
                return WorktreeEntry::Unresolvable(format!(
                    "path {rela_path} does not resolve beneath this checkout's worktree"
                ));
            }
        };
        match rfs::statat(&dir, name.as_os_str(), AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => {
                let kind = rfs::FileType::from_raw_mode(stat.st_mode);
                if kind.is_file() {
                    WorktreeEntry::RegularFile
                } else if kind.is_symlink() {
                    WorktreeEntry::Symlink
                } else if kind.is_dir() {
                    WorktreeEntry::Directory
                } else {
                    WorktreeEntry::Other
                }
            }
            Err(rustix::io::Errno::NOENT) => WorktreeEntry::Absent,
            Err(error) => WorktreeEntry::Unresolvable(format!(
                "path {rela_path} could not be inspected: {error}"
            )),
        }
    }

    /// Opens `rela_path` beneath the worktree as a regular file, following no
    /// symlink at any level. `Ok(None)` means no regular file is there.
    pub(super) fn open_worktree_regular(
        &self,
        rela_path: &str,
    ) -> Result<Option<std::fs::File>, rustix::io::Errno> {
        let Some(workdir) = self.repo.workdir() else {
            return Ok(None);
        };
        let Some((dir, name)) = open_parent_beneath(workdir, Path::new(rela_path)).opened() else {
            return Ok(None);
        };
        open_regular_no_follow_at(&dir, name.as_os_str())
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
    let watchdog = DeadlineWatchdog::arm(budget);
    let ctx = ScanCtx::root(budget);
    let dirty_entries = scan_dirty_entries(&repo, &ctx)?;
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
    let (repository_state, shallow) = repository_state(&repo, &ctx)?;
    let dirty_fingerprint = fingerprint_entries(&dirty_entries, &repository_state);
    // Stop the watchdog before the last check, so neither the fingerprint nor
    // the watchdog's own teardown can carry a cacheable snapshot past the
    // deadline that the scan's final poll still satisfied.
    drop(watchdog);
    budget.check()?;
    Ok(CheckoutSnapshot {
        repo,
        identity,
        head,
        repository_state: hex_digest(&repository_state),
        dirty_fingerprint,
        dirty_entries,
        shallow,
        commit_graph: OnceCell::new(),
    })
}

fn checkout_identity(repo: &gix::Repository) -> Result<String, SnapshotError> {
    let git_dir = repo
        .git_dir()
        .canonicalize()
        .map_err(|error| SnapshotError::Open(error.to_string()))?;
    // The digest suffix distinguishes non-UTF-8 git-dir paths that share a
    // lossy string, and the tag keeps the two encodings disjoint: a checkout
    // whose valid path reads exactly like some lossy rendering would
    // otherwise share an identity with the bytes it stands for.
    match git_dir.to_str() {
        Some(utf8) => Ok(format!("utf8:{utf8}")),
        None => {
            let raw = git_dir.as_os_str().as_encoded_bytes();
            Ok(format!(
                "lossy:{}#x{:x}",
                git_dir.to_string_lossy(),
                Sha256::digest(raw)
            ))
        }
    }
}

fn scan_dirty_entries(
    repo: &gix::Repository,
    ctx: &ScanCtx<'_>,
) -> Result<Vec<DirtyEntry>, SnapshotError> {
    use gix::status::Item;

    let platform = repo
        .status(gix::progress::Discard)
        .map_err(|error| SnapshotError::Scan(error.to_string()))?
        .should_interrupt_owned(ctx.budget.interrupt_flag())
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
        ctx.check()?;
        let item = item.map_err(|error| SnapshotError::Scan(error.to_string()))?;
        let entry = match item {
            Item::IndexWorktree(item) => index_worktree_entry(repo, item, ctx)?,
            Item::TreeIndex(change) => Some(tree_index_entry(&change)),
        };
        if let Some(entry) = entry {
            entries.insert(entry);
        }
    }
    ctx.check()?;
    // The status walk skips stats for assume-valid entries and reports
    // skip-worktree entries clean whether or not a file is materialized, so
    // both classes are keyed straight from the index instead.
    let index = repo
        .index_or_empty()
        .map_err(|error| SnapshotError::Scan(error.to_string()))?;
    for entry in index.entries() {
        use gix::index::entry::Flags;
        // `ctx.check()` precedes classification so every entry observes
        // cancellation during large scans. Ordinary entries reach `continue`
        // without per-entry work, so polling only on the rare classes would
        // walk a whole index past an armed deadline.
        ctx.check()?;
        let status = if entry.flags.contains(Flags::SKIP_WORKTREE) {
            "skip_worktree"
        } else if entry.flags.contains(Flags::ASSUME_VALID) {
            "assume_valid"
        } else {
            continue;
        };
        let rela_path = entry.path(&index);
        let (path, path_encoding, raw_path) = encode_path(rela_path);
        // A chmod moves the git entry mode while the bytes stay equal, so
        // the mode tag participates alongside the content hash. The index
        // blob id separates two absent-file states whose staged content
        // differs.
        entries.insert(DirtyEntry {
            content_hash: format!(
                "{}:{}:{}",
                entry.id,
                worktree_content_hash(repo, rela_path, ctx)?,
                worktree_mode_tag(repo, rela_path)
            ),
            path,
            path_encoding,
            raw_path,
            status,
        });
    }
    Ok(entries.into_iter().collect())
}

fn index_worktree_entry(
    repo: &gix::Repository,
    item: gix::status::index_worktree::Item,
    ctx: &ScanCtx<'_>,
) -> Result<Option<DirtyEntry>, SnapshotError> {
    use gix::status::index_worktree::Item;
    use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};

    match item {
        Item::Modification {
            rela_path, status, ..
        } => {
            let (path, path_encoding, raw_path) = encode_path(rela_path.as_ref());
            let entry = match status {
                EntryStatus::Conflict { .. } => Some(DirtyEntry {
                    content_hash: conflict_content_hash(repo, rela_path.as_ref(), ctx)?,
                    path,
                    path_encoding,
                    raw_path,
                    status: "conflicted",
                }),
                EntryStatus::Change(Change::Removed) => Some(DirtyEntry {
                    path,
                    path_encoding,
                    raw_path,
                    status: "removed",
                    content_hash: "absent".to_string(),
                }),
                // The mode tag joins the content hash for the same reason it
                // does on assume-valid and skip-worktree entries: a chmod
                // moves git's worktree mode between 100644 and 100755 while
                // the bytes stay equal, and a file that is already dirty by
                // content would otherwise absorb that move unrecorded.
                EntryStatus::Change(_) => Some(DirtyEntry {
                    content_hash: format!(
                        "{}:{}",
                        worktree_content_hash(repo, rela_path.as_ref(), ctx)?,
                        worktree_mode_tag(repo, rela_path.as_ref())
                    ),
                    path,
                    path_encoding,
                    raw_path,
                    status: "modified",
                }),
                EntryStatus::IntentToAdd => Some(DirtyEntry {
                    content_hash: format!(
                        "{}:{}",
                        worktree_content_hash(repo, rela_path.as_ref(), ctx)?,
                        worktree_mode_tag(repo, rela_path.as_ref())
                    ),
                    path,
                    path_encoding,
                    raw_path,
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
            let (path, path_encoding, raw_path) = encode_path(entry.rela_path.as_ref());
            if entry.disk_kind.is_some_and(|kind| kind.is_dir()) {
                // `UntrackedFiles::Files` emits contained files individually,
                // so directory entries have no content to hash.
                return Ok(Some(DirtyEntry {
                    path,
                    path_encoding,
                    raw_path,
                    status: "untracked",
                    content_hash: "directory".to_string(),
                }));
            }
            Ok(Some(DirtyEntry {
                content_hash: worktree_content_hash(repo, entry.rela_path.as_ref(), ctx)?,
                path,
                path_encoding,
                raw_path,
                status: "untracked",
            }))
        }
        // Rewrites are disabled in the scan configuration.
        Item::Rewrite { .. } => Ok(None),
    }
}

/// The digest suffix distinguishes non-UTF-8 paths that share a lossy
/// string.
fn encode_path(rela_path: &BStr) -> (String, PathEncoding, Vec<u8>) {
    let raw = rela_path.as_bytes().to_vec();
    match rela_path.to_str() {
        Ok(utf8) => (utf8.to_owned(), PathEncoding::Utf8, raw),
        Err(_) => (
            format!(
                "{}#x{:x}",
                rela_path.to_str_lossy(),
                Sha256::digest(rela_path.as_bytes())
            ),
            PathEncoding::LossyWithDigest,
            raw,
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
    let (path, path_encoding, raw_path) = encode_path(location.as_ref());
    DirtyEntry {
        path,
        path_encoding,
        raw_path,
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
    ctx: &ScanCtx<'_>,
) -> Result<String, SnapshotError> {
    ctx.check()?;
    let Some(workdir) = repo.workdir() else {
        return Ok("no-worktree".to_string());
    };
    // A lossy conversion would look up the wrong file for non-UTF-8 names.
    let Ok(rela_path) = gix::path::try_from_bstr(rela_path) else {
        return Ok("unreadable".to_string());
    };
    let Some((dir, name)) = open_parent_beneath(workdir, &rela_path).opened() else {
        return Ok("out-of-worktree".to_string());
    };
    // Inspection failures use `unreadable`, distinct from content hashes.
    let Ok(stat) = rfs::statat(&dir, name.as_os_str(), AtFlags::SYMLINK_NOFOLLOW) else {
        return Ok("unreadable".to_string());
    };
    let file_type = rfs::FileType::from_raw_mode(stat.st_mode);
    if file_type.is_symlink() {
        let Ok(target) = rfs::readlinkat(&dir, name.as_os_str(), Vec::new()) else {
            return Ok("unreadable".to_string());
        };
        let mut hash = Sha256::new();
        hash.update(b"symlink\0");
        hash.update(target.as_bytes());
        return Ok(format!("symlink:{:x}", hash.finalize()));
    }
    if !file_type.is_file() {
        if file_type.is_dir() {
            // A dirty tracked gitlink resolves to a directory; its HEAD and
            // its own uncommitted state are the content that moved.
            return submodule_hash_at(&dir, name.as_os_str(), ctx);
        }
        return Ok("not-a-regular-file".to_string());
    }
    let mut file = match open_regular_no_follow_at(&dir, name.as_os_str()) {
        Ok(Some(file)) => file,
        // The path changed kind under the classification above.
        Ok(None) => return Ok("unreadable".to_string()),
        // A failure to read hides content that still governs the checkout, so
        // it must not collapse onto a fixed token that two different dirty
        // states would share.
        Err(error) => return Err(SnapshotError::Scan(error.to_string())),
    };
    let mut hash = Sha256::new();
    fold_open_file(&mut hash, &mut file, ctx)?;
    Ok(format!("{:x}", hash.finalize()))
}

/// The hash covers the stage-1/2/3 index entries and the worktree content:
/// replacing a conflict's base, ours, or theirs blob changes the checkout
/// state even when the worktree file is untouched.
fn conflict_content_hash(
    repo: &gix::Repository,
    rela_path: &BStr,
    ctx: &ScanCtx<'_>,
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
    let worktree = worktree_content_hash(repo, rela_path, ctx)?;
    hash.update(worktree.as_bytes());
    // A conflicted path stays conflicted through a chmod, so without the mode
    // tag a 100644 and a 100755 worktree share this hash — the same aliasing
    // the modified and index-keyed entries already record.
    hash.update(b"mode\0");
    hash.update(worktree_mode_tag(repo, rela_path).as_bytes());
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

fn hex_digest(digest: &[u8; 32]) -> String {
    use std::fmt::Write;
    digest
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

fn fingerprint_entries(entries: &[DirtyEntry], repository_state: &[u8; 32]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"mc-dirty-fingerprint-v7\0");
    hash.update(repository_state);
    for entry in entries {
        // Length prefixes make adjacent fields unambiguous.
        for field in [
            entry.path.as_bytes(),
            entry.path_encoding.as_bytes(),
            entry.status.as_bytes(),
            entry.content_hash.as_bytes(),
        ] {
            hash.update((field.len() as u64).to_le_bytes());
            hash.update(field);
        }
    }
    format!("{:x}", hash.finalize())
}

/// A gitlink's HEAD plus the submodule's own dirty fingerprint. HEAD alone
/// holds still while files under the submodule path are edited, and those
/// files sit inside the superproject worktree where applicability checks
/// read them.
/// The pinned parent descriptor prevents ancestor-path replacement from
/// redirecting the nested scan.
///
/// `gix` opens a repository by path, so the pinned directory is named through
/// `/proc/self/fd`, which resolves to the descriptor's inode however the
/// original pathname is rewritten. The descriptor stays open for the whole
/// nested scan, which is what keeps that name valid.
#[cfg(target_os = "linux")]
fn submodule_hash_at(
    dir: &OwnedFd,
    name: &OsStr,
    ctx: &ScanCtx<'_>,
) -> Result<String, SnapshotError> {
    use std::os::fd::AsRawFd;

    let Ok(gitlink) = rfs::openat(
        dir,
        name,
        OFlags::PATH | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        rfs::Mode::empty(),
    ) else {
        return Ok("unreadable-gitlink".to_string());
    };
    let pinned = PathBuf::from(format!("/proc/self/fd/{}", gitlink.as_raw_fd()));
    let hashed = submodule_hash(&pinned, ctx);
    drop(gitlink);
    hashed
}

/// Without `/proc`, the pinned directory cannot be named for `gix`, so the
/// gitlink is refused rather than reached through a re-resolved pathname.
#[cfg(not(target_os = "linux"))]
fn submodule_hash_at(
    dir: &OwnedFd,
    name: &OsStr,
    _ctx: &ScanCtx<'_>,
) -> Result<String, SnapshotError> {
    let _ = (dir, name);
    Ok("unreadable-gitlink".to_string())
}

/// A gitlink's HEAD plus the submodule's own dirty fingerprint. HEAD alone
/// holds still while files under the submodule path are edited, and those
/// files sit inside the superproject worktree where applicability checks
/// read them.
fn submodule_hash(path: &Path, ctx: &ScanCtx<'_>) -> Result<String, SnapshotError> {
    let Some(nested) = ctx.nested() else {
        return Err(SnapshotError::Scan(format!(
            "submodule nesting exceeds {} levels at {}",
            ScanCtx::MAX_SUBMODULE_DEPTH,
            path.display()
        )));
    };
    let Ok(mut submodule) = gix::open_opts(path, gix::open::Options::isolated()) else {
        return Ok("unopenable-gitlink".to_string());
    };
    // The nested scan walks trees exactly as the top-level one does, so it
    // wants the same cache floor.
    submodule.object_cache_size_if_unset(4 * 1024 * 1024);
    let head = match submodule.head_id() {
        Ok(head) => head.detach().to_string(),
        Err(_) => "unborn".to_string(),
    };
    let entries = scan_dirty_entries(&submodule, &nested)?;
    let (state, _) = repository_state(&submodule, &nested)?;
    // The nested scan needs the same HEAD-stability check the top-level one
    // makes: a submodule that switches commits mid-scan would otherwise pair
    // an old HEAD with a new worktree and key that tuple as a clean state.
    let head_after = match submodule.head_id() {
        Ok(head) => head.detach().to_string(),
        Err(_) => "unborn".to_string(),
    };
    if head_after != head {
        return Err(SnapshotError::Scan(
            "submodule HEAD moved during the status scan".to_string(),
        ));
    }
    Ok(format!(
        "gitlink:{head}:{}",
        fingerprint_entries(&entries, &state)
    ))
}

/// Git mode class of a worktree path: `file`, `exec`, `symlink`, `dir`, or
/// `absent`. On non-Unix targets the executable bit does not exist, so
/// `file` covers both blob modes.
fn worktree_mode_tag(repo: &gix::Repository, rela_path: &BStr) -> &'static str {
    let Some(workdir) = repo.workdir() else {
        return "absent";
    };
    let Ok(rela_path) = gix::path::try_from_bstr(rela_path) else {
        return "absent";
    };
    let Some((dir, name)) = open_parent_beneath(workdir, &rela_path).opened() else {
        return "absent";
    };
    let Ok(stat) = rfs::statat(&dir, name.as_os_str(), AtFlags::SYMLINK_NOFOLLOW) else {
        return "absent";
    };
    let file_type = rfs::FileType::from_raw_mode(stat.st_mode);
    if file_type.is_symlink() {
        return "symlink";
    }
    if file_type.is_dir() {
        return "dir";
    }
    // Git reads executability from the owner bit alone, so a
    // group-executable-only file has mode 100644.
    if stat.st_mode & 0o100 != 0 {
        return "exec";
    }
    "file"
}

/// Folds `path`'s bytes into `hash` chunk by chunk, so a large file bounds
/// neither the working set nor the digest. Anything other than a regular file
/// counts as absent, since opening a FIFO can block indefinitely.
fn fold_file(
    hash: &mut Sha256,
    path: &Path,
    ctx: &ScanCtx<'_>,
) -> Result<Option<u64>, SnapshotError> {
    // The open is the sole authority on what is there: a stat first would
    // leave a window for the path to be swapped before the read.
    let mut file = match open_regular_no_follow_at(rfs::CWD, path.as_os_str()) {
        Ok(Some(file)) => file,
        Ok(None) => {
            hash.update(b"absent\0");
            return Ok(None);
        }
        // Any other failure hides content that still governs the checkout.
        Err(error) => return Err(SnapshotError::Scan(error.to_string())),
    };
    hash.update(b"present\0");
    Ok(Some(fold_open_file(hash, &mut file, ctx)?))
}

/// A read error propagates rather than truncating: a prefix would key as a
/// genuinely shorter file.
fn fold_open_file(
    hash: &mut Sha256,
    file: &mut std::fs::File,
    ctx: &ScanCtx<'_>,
) -> Result<u64, SnapshotError> {
    let mut buffer = vec![0u8; HASH_CHUNK_BYTES];
    let mut folded = 0u64;
    loop {
        ctx.check()?;
        match file.read(&mut buffer) {
            Ok(0) => return Ok(folded),
            Ok(read) => {
                hash.update(&buffer[..read]);
                folded = folded.saturating_add(read as u64);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(SnapshotError::Scan(error.to_string())),
        }
    }
}

/// Repository state beyond HEAD and the dirty set that changes what the engine
/// can see: which paths materialize, and how far history reaches.
///
/// Sparse configuration and patterns decide materialization. The shallow
/// boundary decides whether an ancestry walk can reach a conclusion at all, so
/// unshallowing has to move the generation.
///
/// Object availability stays out of this digest: in a partial clone a fetch
/// materializes a missing blob without touching HEAD, the worktree, sparse
/// configuration, or the shallow file, and no cheap repository read separates
/// "absent" from "absent so far". A cache keyed by this generation therefore
/// must not retain an outcome that an unreadable object produced; such an
/// outcome is transient exactly as a budget-driven one is.
fn repository_state(
    repo: &gix::Repository,
    ctx: &ScanCtx<'_>,
) -> Result<([u8; 32], bool), SnapshotError> {
    let config = repo.config_snapshot();
    let mut hash = Sha256::new();
    hash.update(b"mc-repo-state-v1\0");
    hash.update([
        config.boolean("core.sparseCheckout").unwrap_or(false) as u8,
        config.boolean("core.sparseCheckoutCone").unwrap_or(false) as u8,
    ]);
    hash.update(b"sparse\0");
    fold_file(&mut hash, &repo.git_dir().join("info/sparse-checkout"), ctx)?;
    hash.update(b"shallow\0");
    // The digest and the shallow verdict come from one read, so a shallow file
    // removed between them cannot pair a shallow fingerprint with
    // `shallow == false`. A present-but-empty file is not shallow, which is
    // what gix reports too.
    let shallow = fold_file(&mut hash, &repo.shallow_file(), ctx)?;
    Ok((
        hash.finalize().into(),
        matches!(shallow, Some(bytes) if bytes > 0),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The descriptor, not the pathname, decides what a hash reads. Every
    /// case here is what a racing swap would substitute after a stat.
    #[test]
    fn open_regular_no_follow_admits_only_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let root_fd = rfs::open(
            root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            rfs::Mode::empty(),
        )
        .unwrap();

        std::fs::write(root.join("regular"), b"payload").unwrap();
        assert!(
            open_regular_no_follow_at(&root_fd, OsStr::new("regular"))
                .expect("a regular file is not a scan failure")
                .is_some(),
            "a regular file stays readable"
        );

        assert!(open_regular_no_follow_at(&root_fd, OsStr::new("missing"))
            .expect("a vanished path is not a scan failure")
            .is_none());

        std::fs::create_dir(root.join("subdir")).unwrap();
        assert!(open_regular_no_follow_at(&root_fd, OsStr::new("subdir"))
            .expect("a directory is not a scan failure")
            .is_none());

        std::os::unix::fs::symlink(root.join("regular"), root.join("link")).unwrap();
        assert!(
            open_regular_no_follow_at(&root_fd, OsStr::new("link"))
                .expect("a symlink is not a scan failure")
                .is_none(),
            "following the link would read whatever it points at"
        );

        rfs::mkfifoat(&root_fd, "fifo", rfs::Mode::RUSR | rfs::Mode::WUSR)
            .expect("mkfifo succeeds in a temp dir");
        assert!(
            open_regular_no_follow_at(&root_fd, OsStr::new("fifo"))
                .expect("a FIFO is not a scan failure")
                .is_none(),
            "a blocking open would run past the budget"
        );
    }

    /// `NOFOLLOW` guards only the final component, so ancestor containment has
    /// to survive an ancestor being replaced after the path was validated.
    ///
    /// The swap here is the race made deterministic: resolve first, substitute
    /// the ancestor, then read. A descriptor pins the directory it opened, so
    /// the later read still lands on the originally contained file; a path
    /// re-walked at open time would traverse the substituted link instead.
    #[test]
    fn a_swapped_ancestor_cannot_redirect_a_pinned_parent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let workdir = root.join("workdir");
        std::fs::create_dir(&workdir).unwrap();
        std::fs::create_dir(workdir.join("real")).unwrap();
        std::fs::write(workdir.join("real/inside"), b"contained").unwrap();

        let outside = root.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("inside"), b"escaped").unwrap();

        // Resolve while `real` is a genuine directory, as any check would.
        let ParentDir::Opened(dir_fd, name) =
            open_parent_beneath(&workdir, Path::new("real/inside"))
        else {
            panic!("a real ancestor opens");
        };
        assert_eq!(name, OsStr::new("inside"));

        // The window a path-based open leaves: swap the validated ancestor.
        std::fs::rename(workdir.join("real"), workdir.join("stashed")).unwrap();
        std::os::unix::fs::symlink(&outside, workdir.join("real")).unwrap();

        let mut file = open_regular_no_follow_at(&dir_fd, name.as_os_str())
            .expect("the pinned parent is not a scan failure")
            .expect("the original file is still a regular file");
        let mut read = Vec::new();
        file.read_to_end(&mut read).unwrap();
        assert_eq!(
            read, b"contained",
            "the pinned parent must keep the read inside the checkout"
        );

        // A path re-walked now would traverse the link, which is the escape.
        assert_eq!(
            std::fs::read(workdir.join("real/inside")).unwrap(),
            b"escaped",
            "the swap really does redirect the pathname"
        );

        // A symlinked ancestor present up front is refused outright, and
        // `Unresolvable` rather than `AncestorAbsent`: the link hides whatever
        // it points at, so nothing about the checked path is settled.
        for spelling in ["real/inside", "../outside/inside", ""] {
            assert!(
                matches!(
                    open_parent_beneath(&workdir, Path::new(spelling)),
                    ParentDir::Unresolvable
                ),
                "spelling {spelling:?} must stay unresolvable"
            );
        }
    }

    /// Resolving a known child needs search permission, not read permission,
    /// so a traversal that demanded read access would lose track of a tracked
    /// file that git still reads — and its content edits with it.
    #[test]
    fn an_execute_only_ancestor_still_resolves() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let workdir = dir.path();
        std::fs::create_dir(workdir.join("closed")).unwrap();
        std::fs::write(workdir.join("closed/tracked"), b"payload").unwrap();
        // Traversable, not readable — 0o711 would still grant the owner read.
        std::fs::set_permissions(
            workdir.join("closed"),
            std::fs::Permissions::from_mode(0o111),
        )
        .unwrap();

        let resolved = open_parent_beneath(workdir, Path::new("closed/tracked"));
        // Restore before asserting so a failure cannot leave an undeletable dir.
        std::fs::set_permissions(
            workdir.join("closed"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        let ParentDir::Opened(dir_fd, name) = resolved else {
            panic!("an execute-only ancestor is traversable");
        };
        assert!(open_regular_no_follow_at(&dir_fd, name.as_os_str())
            .expect("the file is not a scan failure")
            .is_some());
    }
}
