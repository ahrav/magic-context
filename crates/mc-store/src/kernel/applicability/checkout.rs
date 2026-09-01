//! Checkout snapshots: worktree-aware open, HEAD resolution, and a
//! content-addressed dirty fingerprint, taken once per request.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use sha2::{Digest, Sha256};

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

    /// Absolute path of a repo-relative worktree file.
    pub fn worktree_path(&self, rela_path: &str) -> Option<PathBuf> {
        self.repo.workdir().map(|workdir| workdir.join(rela_path))
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
    let repo = open_isolated(path)?;
    let identity = checkout_identity(&repo)?;
    let head = repo
        .head_id()
        .map_err(|_| SnapshotError::NoHead)?
        .detach()
        .to_string();
    let dirty_entries = scan_dirty_entries(&repo, budget)?;
    let dirty_fingerprint = fingerprint_entries(&dirty_entries);
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
    Ok(git_dir.to_string_lossy().into_owned())
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
        // Each untracked file is emitted individually: a collapsed
        // directory entry would keep one fingerprint across edits beneath
        // it.
        .untracked_files(gix::status::UntrackedFiles::Files)
        // Rename tracking would fold a delete+add pair into one entry;
        // the fingerprint wants the raw path set.
        .index_worktree_rewrites(None)
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
            let path = rela_path.to_string();
            let entry = match status {
                EntryStatus::Conflict { .. } => Some(DirtyEntry {
                    content_hash: worktree_content_hash(repo, &path, budget)?,
                    path,
                    status: "conflicted",
                }),
                EntryStatus::Change(Change::Removed) => Some(DirtyEntry {
                    path,
                    status: "removed",
                    content_hash: "absent".to_string(),
                }),
                EntryStatus::Change(_) => Some(DirtyEntry {
                    content_hash: worktree_content_hash(repo, &path, budget)?,
                    path,
                    status: "modified",
                }),
                EntryStatus::IntentToAdd => Some(DirtyEntry {
                    content_hash: worktree_content_hash(repo, &path, budget)?,
                    path,
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
                // The walk emits untracked files individually; a directory
                // entry can still appear when it is empty and carries no
                // content of its own.
                return Ok(Some(DirtyEntry {
                    path: entry.rela_path.to_string(),
                    status: "untracked",
                    content_hash: "empty-directory".to_string(),
                }));
            }
            let path = entry.rela_path.to_string();
            Ok(Some(DirtyEntry {
                content_hash: worktree_content_hash(repo, &path, budget)?,
                path,
                status: "untracked",
            }))
        }
        // Rewrites are disabled in the scan configuration.
        Item::Rewrite { .. } => Ok(None),
    }
}

fn tree_index_entry(change: &gix::diff::index::Change) -> DirtyEntry {
    use gix::diff::index::Change;
    let (status, location, id): (&'static str, _, _) = match change {
        Change::Addition { location, id, .. } => {
            ("staged_added", location, id.as_ref().to_string())
        }
        Change::Deletion { location, .. } => ("staged_removed", location, "absent".to_string()),
        Change::Modification { location, id, .. } => {
            ("staged_modified", location, id.as_ref().to_string())
        }
        Change::Rewrite {
            location,
            entry_mode: _,
            id,
            ..
        } => ("staged_rewritten", location, id.as_ref().to_string()),
    };
    DirtyEntry {
        path: location.to_string(),
        status,
        content_hash: id,
    }
}

/// Content hash of a worktree file, so the fingerprint changes exactly when
/// content changes (stat-only churn keeps the same key).
fn worktree_content_hash(
    repo: &gix::Repository,
    rela_path: &str,
    budget: &EvalBudget,
) -> Result<String, SnapshotError> {
    budget.check()?;
    let Some(workdir) = repo.workdir() else {
        return Ok("no-worktree".to_string());
    };
    let path = workdir.join(rela_path);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let mut hash = Sha256::new();
            hash.update(&bytes);
            Ok(format!("{:x}", hash.finalize()))
        }
        // The file can race away between the walk and the hash; the entry
        // stays dirty under a distinct token.
        Err(_) => Ok("unreadable".to_string()),
    }
}

fn fingerprint_entries(entries: &[DirtyEntry]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"mc-dirty-fingerprint-v1\0");
    for entry in entries {
        hash.update(entry.path.as_bytes());
        hash.update(b"\0");
        hash.update(entry.status.as_bytes());
        hash.update(b"\0");
        hash.update(entry.content_hash.as_bytes());
        hash.update(b"\n");
    }
    format!("{:x}", hash.finalize())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{fingerprint_entries, DirtyEntry};

    fn fingerprint(discovered: Vec<DirtyEntry>) -> (String, BTreeSet<String>) {
        let entries: Vec<DirtyEntry> = discovered
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let paths = entries.iter().map(|entry| entry.path.clone()).collect();
        (fingerprint_entries(&entries), paths)
    }

    #[test]
    fn dirty_fingerprint_is_permutation_invariant_and_field_sensitive() {
        let first = DirtyEntry {
            path: "a.txt".to_string(),
            status: "modified",
            content_hash: "aaa".to_string(),
        };
        let second = DirtyEntry {
            path: "b.txt".to_string(),
            status: "untracked",
            content_hash: "bbb".to_string(),
        };
        let (forward, paths) = fingerprint(vec![first.clone(), second.clone()]);
        let (reverse, reverse_paths) = fingerprint(vec![second.clone(), first.clone()]);
        assert_eq!(forward, reverse);
        assert_eq!(paths, reverse_paths);
        assert_eq!(
            paths,
            BTreeSet::from(["a.txt".to_string(), "b.txt".to_string()])
        );

        for changed in [
            DirtyEntry {
                path: "c.txt".to_string(),
                ..first.clone()
            },
            DirtyEntry {
                status: "staged_modified",
                ..first.clone()
            },
            DirtyEntry {
                content_hash: "ccc".to_string(),
                ..first.clone()
            },
        ] {
            assert_ne!(forward, fingerprint(vec![changed, second.clone()]).0);
        }
        assert_ne!(forward, fingerprint(vec![first]).0);
    }
}
