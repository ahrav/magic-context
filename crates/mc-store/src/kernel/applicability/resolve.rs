//! Anchor commit resolution: ancestry tests against HEAD, a version-tagged
//! patch identity, and the exact-OID → ancestry → patch-ID → tree-hash
//! fallback ladder with stop-on-ambiguity.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gix::ObjectId;
use sha2::{Digest, Sha256};

use super::super::anchor::{AnchorCapture, GitCondition};
use super::super::scope::GraphOracle;
use super::checkout::{CheckoutSnapshot, EvalBudget};

/// Identities are internal fallback keys, not `git patch-id` output.
pub const PATCH_ID_ALGORITHM: &str = "mc-patch-id-v4";

/// `CANDIDATE_WINDOW` bounds fallback resolution cost on deep histories.
/// A true match outside the window is unresolved at that rung.
pub const CANDIDATE_WINDOW: usize = 512;

const MAX_PATCH_BLOB_BYTES: u64 = 32 * 1024 * 1024;

/// Verdict for one git anchor condition against one checkout snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitConditionOutcome {
    Holds,
    /// `historical` marks a `reachable_between` whose end commit has been
    /// reached: the condition's validity window was exited.
    DoesNotHold {
        historical: bool,
    },
    /// Ambiguous fallback match, unresolvable commit, or exhausted budget.
    Uncertain,
}

/// How one anchored commit resolved against HEAD.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommitResolution {
    /// The commit (or its fallback-resolved rewrite) is reachable from HEAD.
    Reachable,
    /// Definitely not reachable: the ancestry verdict stands.
    NotReachable,
    /// No rung could decide the commit.
    Uncertain,
}

/// Per-request resolver over one checkout snapshot. Also serves as the
/// graph oracle for `git_reachable` scope terms, so scope predicates get
/// real DAG semantics wherever a snapshot exists.
pub struct ResolutionLadder<'s> {
    snapshot: &'s CheckoutSnapshot,
    budget: &'s EvalBudget,
    /// A shallow boundary truncates every graph walk, so a negative ancestry commentlint: allow(JUDGE)
    /// result cannot be trusted. Read once per request. commentlint: allow(JUDGE)
    shallow: bool,
    ancestry_cache: RefCell<HashMap<(ObjectId, ObjectId), Option<bool>>>,
    window: RefCell<Option<CandidateWindow>>,
    /// A candidate's patch identity depends only on its commit.
    patch_id_cache: RefCell<HashMap<ObjectId, Option<String>>>,
}

impl<'s> ResolutionLadder<'s> {
    pub fn new(snapshot: &'s CheckoutSnapshot, budget: &'s EvalBudget) -> Self {
        Self {
            snapshot,
            budget,
            shallow: snapshot.repo().is_shallow(),
            ancestry_cache: RefCell::new(HashMap::new()),
            window: RefCell::new(None),
            patch_id_cache: RefCell::new(HashMap::new()),
        }
    }

    /// Evaluates a git anchor condition via independent ancestry tests —
    /// never a selected merge base.
    pub fn evaluate(&self, condition: &GitCondition) -> GitConditionOutcome {
        match condition {
            GitCondition::ReachableFrom { oid, captures } => {
                match self.resolve_commit(oid, captures.get(oid)) {
                    CommitResolution::Reachable => GitConditionOutcome::Holds,
                    CommitResolution::NotReachable => {
                        GitConditionOutcome::DoesNotHold { historical: false }
                    }
                    CommitResolution::Uncertain => GitConditionOutcome::Uncertain,
                }
            }
            GitCondition::ReachableBetween {
                start_oid,
                end_oid,
                captures,
            } => {
                let start = self.resolve_commit(start_oid, captures.get(start_oid));
                let end = self.resolve_commit(end_oid, captures.get(end_oid));
                match (start, end) {
                    // An unreachable start falsifies the half-open window
                    // whatever the end resolves to: false dominates unknown.
                    (CommitResolution::NotReachable, _) => {
                        GitConditionOutcome::DoesNotHold { historical: false }
                    }
                    (CommitResolution::Uncertain, _) | (_, CommitResolution::Uncertain) => {
                        GitConditionOutcome::Uncertain
                    }
                    (CommitResolution::Reachable, CommitResolution::NotReachable) => {
                        GitConditionOutcome::Holds
                    }
                    (CommitResolution::Reachable, CommitResolution::Reachable) => {
                        GitConditionOutcome::DoesNotHold { historical: true }
                    }
                }
            }
        }
    }

    /// The exact-OID → ancestry → patch-ID → tree-hash ladder for one
    /// anchored commit. Fallback rungs fire when the commit is absent from
    /// the object database *or present but unreachable from HEAD* — the
    /// normal post-rebase state, since rewritten commits stay in the odb via
    /// the reflog.
    fn resolve_commit(&self, oid_hex: &str, capture: Option<&AnchorCapture>) -> CommitResolution {
        let repo = self.snapshot.repo();
        let Ok(head) = ObjectId::from_hex(self.snapshot.head().as_bytes()) else {
            return CommitResolution::Uncertain;
        };
        let anchor = ObjectId::from_hex(oid_hex.as_bytes()).ok();
        let anchor_present = anchor.is_some_and(|oid| repo.find_commit(oid).is_ok());
        if anchor_present {
            match self.is_ancestor_or_equal_oid(anchor.expect("present implies parsed"), head) {
                Some(true) => return CommitResolution::Reachable,
                Some(false) => {}
                None => return CommitResolution::Uncertain,
            }
        }
        match self.match_in_window(capture) {
            WindowMatch::Exactly => CommitResolution::Reachable,
            WindowMatch::Ambiguous => CommitResolution::Uncertain,
            WindowMatch::Budget => CommitResolution::Uncertain,
            WindowMatch::Unreadable => CommitResolution::Uncertain,
            WindowMatch::None if anchor_present && self.window_scan_complete(capture) => {
                CommitResolution::NotReachable
            }
            WindowMatch::None => CommitResolution::Uncertain,
        }
    }

    /// A fallback miss is only conclusive when every reachable commit was
    /// scanned; a window truncated at [`CANDIDATE_WINDOW`] can hide the
    /// rewrite a capture would have matched.
    fn window_scan_complete(&self, capture: Option<&AnchorCapture>) -> bool {
        let has_fallback_data =
            capture.is_some_and(|capture| capture.patch_id.is_some() || capture.tree_oid.is_some());
        if !has_fallback_data {
            return true;
        }
        self.candidate_window()
            .is_some_and(|window| !window.truncated)
    }

    /// Patch-ID rung, then tree-hash rung, over the bounded candidate
    /// window. Multiple matches at either rung stop resolution (KTD2:
    /// ambiguity is uncertain, never current).
    fn match_in_window(&self, capture: Option<&AnchorCapture>) -> WindowMatch {
        let Some(capture) = capture else {
            return WindowMatch::None;
        };
        // A patch ID using a different algorithm cannot establish anchor movement.
        // The algorithm-independent tree rung can still establish anchor movement.
        let patch_unreadable = capture
            .patch_id
            .as_ref()
            .is_some_and(|patch| patch.algorithm != PATCH_ID_ALGORITHM);
        let stored_patch_id = capture
            .patch_id
            .as_ref()
            .filter(|patch| patch.algorithm == PATCH_ID_ALGORITHM);
        if let Some(stored) = stored_patch_id {
            match self.match_candidates(|candidate| {
                if !self.commit_touches_paths(candidate, &capture.changed_paths)? {
                    return Ok(false);
                }
                Ok(self
                    .cached_patch_id(candidate)?
                    .is_some_and(|patch_id| patch_id == stored.value))
            }) {
                WindowMatch::None => {}
                decided => return decided,
            }
        }
        // With an unreadable patch ID, a tree miss cannot rule out a
        // patch-rung match.
        let unmatched = if patch_unreadable {
            WindowMatch::Unreadable
        } else {
            WindowMatch::None
        };
        let Some(tree_oid) = capture.tree_oid.as_deref() else {
            return unmatched;
        };
        let Ok(tree) = ObjectId::from_hex(tree_oid.as_bytes()) else {
            return unmatched;
        };
        match self.match_candidates(|candidate| {
            let commit = self
                .snapshot
                .repo()
                .find_commit(candidate)
                .map_err(|_| ResolveObstacle::UnreadableObject)?;
            Ok(commit
                .tree_id()
                .map_err(|_| ResolveObstacle::UnreadableObject)?
                .detach()
                == tree)
        }) {
            WindowMatch::None => unmatched,
            decided => decided,
        }
    }

    fn match_candidates(
        &self,
        mut matches: impl FnMut(ObjectId) -> Result<bool, ResolveObstacle>,
    ) -> WindowMatch {
        let Some(window) = self.candidate_window() else {
            return WindowMatch::Budget;
        };
        let mut found = None;
        for candidate in window.commits.iter().copied() {
            if self.budget.is_exhausted() {
                return WindowMatch::Budget;
            }
            match matches(candidate) {
                Ok(true) => {
                    if found.replace(candidate).is_some() {
                        return WindowMatch::Ambiguous;
                    }
                }
                Ok(false) => {}
                Err(ResolveObstacle::BudgetExhausted) => return WindowMatch::Budget,
                Err(ResolveObstacle::UnreadableObject) => return WindowMatch::Unreadable,
            }
        }
        match found {
            _ if self.budget.is_exhausted() => WindowMatch::Budget,
            Some(_) => WindowMatch::Exactly,
            None => WindowMatch::None,
        }
    }

    /// Returns up to [`CANDIDATE_WINDOW`] commits cached in `self.window`.
    fn candidate_window(&self) -> Option<CandidateWindow> {
        if let Some(window) = self.window.borrow().as_ref() {
            return Some(window.clone());
        }
        let repo = self.snapshot.repo();
        let head = ObjectId::from_hex(self.snapshot.head().as_bytes()).ok()?;
        // The walk follows all parents: a rewrite reachable only through a
        // merge's non-first parent is still a fallback candidate.
        let walk = repo.rev_walk([head]).all().ok()?;
        let mut commits = Vec::new();
        let mut walk = walk.into_iter();
        for info in walk.by_ref().take(CANDIDATE_WINDOW) {
            if self.budget.is_exhausted() {
                return None;
            }
            commits.push(info.ok()?.id);
        }
        let window = CandidateWindow {
            truncated: commits.len() == CANDIDATE_WINDOW && walk.next().is_some(),
            commits: commits.into(),
        };
        *self.window.borrow_mut() = Some(window.clone());
        Some(window)
    }

    fn cached_patch_id(&self, candidate: ObjectId) -> Result<Option<String>, ResolveObstacle> {
        if let Some(cached) = self.patch_id_cache.borrow().get(&candidate) {
            return Ok(cached.clone());
        }
        let patch_id = compute_patch_id(self.snapshot.repo(), candidate, self.budget)?;
        self.patch_id_cache
            .borrow_mut()
            .insert(candidate, patch_id.clone());
        Ok(patch_id)
    }

    /// Whether `commit` changes any of `paths` relative to its first
    /// parent, by comparing tree entries at those paths — no content diff.
    fn commit_touches_paths(
        &self,
        commit: ObjectId,
        paths: &[String],
    ) -> Result<bool, ResolveObstacle> {
        if paths.is_empty() {
            return Ok(true);
        }
        let repo = self.snapshot.repo();
        let Ok(commit) = repo.find_commit(commit) else {
            return Err(ResolveObstacle::UnreadableObject);
        };
        let Ok(tree) = commit.tree() else {
            return Err(ResolveObstacle::UnreadableObject);
        };
        let parent_tree = match commit.parent_ids().next() {
            Some(parent) => {
                let Some(tree) = repo
                    .find_commit(parent.detach())
                    .ok()
                    .and_then(|parent| parent.tree().ok())
                else {
                    return Err(ResolveObstacle::UnreadableObject);
                };
                Some(tree)
            }
            None => None,
        };
        // Mode is part of the comparison, since a diff reports a mode-only
        // change while the entry ids stay equal.
        //
        // A lookup that fails is not an absent entry: in a partial clone the commentlint: allow(JUDGE)
        // subtree holding `path` can be missing, and reading both sides as commentlint: allow(JUDGE)
        // absent would call the candidate untouched and drop it from the commentlint: allow(JUDGE)
        // rung, turning a present-but-unreachable anchor into a verdict. commentlint: allow(JUDGE)
        let entry_at = |tree: &gix::Tree<'_>, path: &str| {
            tree.lookup_entry_by_path(path)
                .map(|entry| entry.map(|entry| (entry.object_id(), entry.mode().kind())))
                .map_err(|_| ResolveObstacle::UnreadableObject)
        };
        for path in paths {
            // The loop checks the budget for each path so a large path
            // list can return `BudgetExhausted`.
            if self.budget.is_exhausted() {
                return Err(ResolveObstacle::BudgetExhausted);
            }
            let new_entry = entry_at(&tree, path.as_str())?;
            let old_entry = match parent_tree.as_ref() {
                Some(tree) => entry_at(tree, path.as_str())?,
                None => None,
            };
            if new_entry != old_entry {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn is_ancestor_or_equal_oid(&self, ancestor: ObjectId, descendant: ObjectId) -> Option<bool> {
        // Cancellation makes even equal OIDs uncertain.
        if self.budget.is_exhausted() {
            return None;
        }
        if ancestor == descendant {
            return Some(true);
        }
        if let Some(answer) = self.ancestry_cache.borrow().get(&(ancestor, descendant)) {
            return *answer;
        }
        let answer = self.test_ancestry(ancestor, descendant);
        self.ancestry_cache
            .borrow_mut()
            .insert((ancestor, descendant), answer);
        answer
    }

    /// `ancestor` is an ancestor of `descendant` exactly when it appears among
    /// their merge bases. Disjoint histories yield no base; lookup failures
    /// return `None`.
    ///
    /// A shallow clone also yields no base once the walk reaches a grafted commentlint: allow(JUDGE)
    /// boundary, which is indistinguishable from disjoint history, so a commentlint: allow(JUDGE)
    /// negative result there stays unknown. commentlint: allow(JUDGE)
    fn test_ancestry(&self, ancestor: ObjectId, descendant: ObjectId) -> Option<bool> {
        let repo = self.snapshot.repo();
        if repo.find_commit(descendant).is_err() || repo.find_commit(ancestor).is_err() {
            return None;
        }
        let bases = repo.merge_bases_many(ancestor, &[descendant]).ok()?;
        // Do not return a graph result after the budget expires.
        if self.budget.is_exhausted() {
            return None;
        }
        let reachable = bases.iter().any(|base| base.detach() == ancestor);
        if !reachable && self.shallow {
            return None;
        }
        Some(reachable)
    }
}

/// Reachable commits scanned by the fallback rungs. `truncated` records
/// that more history existed beyond [`CANDIDATE_WINDOW`].
#[derive(Clone)]
struct CandidateWindow {
    commits: Rc<[ObjectId]>,
    truncated: bool,
}

/// Candidates that decide a fallback rung: exactly one match resolves,
/// several stop resolution, none falls through to the next rung.
enum WindowMatch {
    Exactly,
    Ambiguous,
    None,
    Budget,
    /// Stored fallback data this build cannot interpret.
    Unreadable,
}

impl GraphOracle for ResolutionLadder<'_> {
    fn is_ancestor_or_equal(&self, ancestor: &str, descendant: &str) -> Option<bool> {
        let ancestor = ObjectId::from_hex(ancestor.as_bytes()).ok()?;
        let descendant = ObjectId::from_hex(descendant.as_bytes()).ok()?;
        self.is_ancestor_or_equal_oid(ancestor, descendant)
    }
}

/// File order does not affect the identity; merge commits have no patch
/// identity.
pub fn compute_patch_id(
    repo: &gix::Repository,
    commit: ObjectId,
    budget: &EvalBudget,
) -> Result<Option<String>, ResolveObstacle> {
    let Some(changes) = first_parent_blob_changes(repo, commit, budget)? else {
        return Ok(None);
    };
    if changes.is_empty() {
        return Ok(None);
    }
    let mut file_hashes = Vec::with_capacity(changes.len());
    for change in &changes {
        if budget.is_exhausted() {
            return Err(ResolveObstacle::BudgetExhausted);
        }
        let Some(file_hash) = file_change_hash(repo, change, budget)? else {
            return Ok(None);
        };
        file_hashes.push(file_hash);
    }
    // Loading, decompressing, and hashing the last blob runs after the final commentlint: allow(JUDGE)
    // poll, and callers persist or cache what this returns. commentlint: allow(JUDGE)
    if budget.is_exhausted() {
        return Err(ResolveObstacle::BudgetExhausted);
    }
    // Hashing all file hashes together prevents linear cancellation.
    file_hashes.sort_unstable();
    let mut combined = Sha256::new();
    combined.update(PATCH_ID_ALGORITHM.as_bytes());
    combined.update(b"\0");
    combined.update((file_hashes.len() as u64).to_le_bytes());
    for file_hash in &file_hashes {
        combined.update(file_hash);
    }
    Ok(Some(format!("{:x}", combined.finalize())))
}

/// Tree changes do not identify blobs; excluding them prevents blob lookup
/// failures.
///
/// Default diff options prevent repository `diff.renames` from changing the identity.
fn first_parent_blob_changes(
    repo: &gix::Repository,
    commit: ObjectId,
    budget: &EvalBudget,
) -> Result<Option<Vec<gix::object::tree::diff::ChangeDetached>>, ResolveObstacle> {
    let Ok(commit) = repo.find_commit(commit) else {
        return Err(ResolveObstacle::UnreadableObject);
    };
    let parents: Vec<_> = commit.parent_ids().collect();
    if parents.len() > 1 {
        return Ok(None);
    }
    let Ok(new_tree) = commit.tree() else {
        return Err(ResolveObstacle::UnreadableObject);
    };
    let old_tree = match parents.first() {
        Some(parent) => {
            let Some(tree) = repo
                .find_commit(parent.detach())
                .ok()
                .and_then(|parent| parent.tree().ok())
            else {
                return Err(ResolveObstacle::UnreadableObject);
            };
            tree
        }
        None => repo.empty_tree(),
    };
    let Ok(mut platform) = old_tree.changes() else {
        return Err(ResolveObstacle::UnreadableObject);
    };
    platform.options(|options| *options = gix::diff::Options::default());
    let mut changes = Vec::new();
    let outcome = platform.for_each_to_obtain_tree(&new_tree, |change| {
        if budget.is_exhausted() {
            return Err(ResolveObstacle::BudgetExhausted);
        }
        if !change.entry_mode().is_tree() {
            changes.push(change.detach());
        }
        Ok(gix::object::tree::diff::Action::Continue(()))
    });
    match outcome {
        Ok(_) => Ok(Some(changes)),
        // The callback's budget signal surfaces wrapped in either layer.
        Err(gix::object::tree::diff::for_each::Error::ForEach(_))
        | Err(gix::object::tree::diff::for_each::Error::Diff(
            gix::diff::tree_with_rewrites::Error::ForEach(_),
        )) => Err(ResolveObstacle::BudgetExhausted),
        Err(_) => Err(ResolveObstacle::UnreadableObject),
    }
}

/// Typed non-answers raised from inside patch-ID computation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveObstacle {
    /// Deadline exceeded or interrupt raised.
    BudgetExhausted,
    /// A required object could not be read from the object database.
    UnreadableObject,
}

impl std::fmt::Display for ResolveObstacle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BudgetExhausted => {
                f.write_str("evaluation budget exhausted during anchor resolution")
            }
            Self::UnreadableObject => {
                f.write_str("required object unreadable during anchor resolution")
            }
        }
    }
}

impl std::error::Error for ResolveObstacle {}

fn file_change_hash(
    repo: &gix::Repository,
    change: &gix::object::tree::diff::ChangeDetached,
    budget: &EvalBudget,
) -> Result<Option<[u8; 32]>, ResolveObstacle> {
    use gix::object::tree::diff::ChangeDetached as Change;
    use gix::objs::tree::{EntryKind, EntryMode};
    type Side = Option<(ObjectId, EntryMode)>;
    let (kind, location, old, new): (&str, _, Side, Side) = match change {
        Change::Addition {
            location,
            entry_mode,
            id,
            ..
        } => ("add", location, None, Some((*id, *entry_mode))),
        Change::Deletion {
            location,
            entry_mode,
            id,
            ..
        } => ("delete", location, Some((*id, *entry_mode)), None),
        Change::Modification {
            location,
            previous_entry_mode,
            previous_id,
            entry_mode,
            id,
        } => (
            "modify",
            location,
            Some((*previous_id, *previous_entry_mode)),
            Some((*id, *entry_mode)),
        ),
        Change::Rewrite {
            location,
            source_entry_mode,
            source_id,
            entry_mode,
            id,
            ..
        } => (
            "rewrite",
            location,
            Some((*source_id, *source_entry_mode)),
            Some((*id, *entry_mode)),
        ),
    };
    let mut hash = Sha256::new();
    // Derived from the version tag, so a hash change forces a tag change.
    hash.update(PATCH_ID_ALGORITHM.as_bytes());
    hash.update(b"-file\0");
    hash.update(kind.as_bytes());
    hash.update(b"\0");
    hash.update(location.as_slice());
    hash.update(b"\0");
    for side in [old, new] {
        match side {
            Some((id, mode)) if !id.is_null() => {
                // Entry kind makes opposite mode-only transitions hash
                // differently.
                hash.update((mode.kind() as u16).to_le_bytes());
                if mode.is_commit() {
                    hash.update(b"gitlink\0");
                    hash.update(id.as_slice());
                } else {
                    if budget.is_exhausted() {
                        return Err(ResolveObstacle::BudgetExhausted);
                    }
                    let Ok(header) = repo.find_header(id) else {
                        return Err(ResolveObstacle::UnreadableObject);
                    };
                    if header.size() > MAX_PATCH_BLOB_BYTES {
                        return Ok(None);
                    }
                    let Ok(blob) = repo.find_blob(id) else {
                        return Err(ResolveObstacle::UnreadableObject);
                    };
                    // Fixed-width inner digests keep content boundaries
                    // unambiguous.
                    let mut content = Sha256::new();
                    if mode.kind() == EntryKind::Link {
                        // A symlink blob holds a target path, where a space commentlint: allow(JUDGE)
                        // is part of the name and no NUL marks it binary, so commentlint: allow(JUDGE)
                        // normalization would fold `a b` into `ab`. commentlint: allow(JUDGE)
                        content.update(b"symlink\0");
                        content.update(&blob.data);
                    } else if is_binary(&blob.data) {
                        content.update(b"binary\0");
                        content.update(&blob.data);
                    } else {
                        hash_normalized_content(&mut content, &blob.data);
                    }
                    hash.update(b"blob\0");
                    hash.update(content.finalize());
                }
            }
            _ => hash.update(b"absent\0"),
        }
        hash.update(b"\0");
    }
    Ok(Some(hash.finalize().into()))
}

/// Git's binary heuristic: a NUL byte within the leading window. Binary
/// bytes are all data, so whitespace normalization only applies to text.
fn is_binary(bytes: &[u8]) -> bool {
    const BINARY_SNIFF_BYTES: usize = 8000;
    bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

/// Feeds `bytes` to `hash` without ASCII whitespace, so formatting-only
/// variants of the same change share a patch identity. Runs go straight to the
/// hasher instead of building a stripped copy.
fn hash_normalized_content(hash: &mut Sha256, bytes: &[u8]) {
    for run in bytes.split(|byte| byte.is_ascii_whitespace()) {
        if !run.is_empty() {
            hash.update(run);
        }
    }
}

/// Builds the capture-time representation of `commit` that anchor authoring
/// stores in the anchor payload: commit OID, root-tree OID, version-tagged
/// patch identity (absent for merge commits), and changed paths relative to
/// the first parent.
pub fn capture_anchor_representation(
    repo: &gix::Repository,
    commit_oid: ObjectId,
    budget: &EvalBudget,
) -> Option<AnchorCapture> {
    let commit = repo.find_commit(commit_oid).ok()?;
    let tree_oid = commit.tree_id().ok()?.detach();
    // A lossily converted path would miss real tree entries in
    // `commit_touches_paths`, so non-UTF-8 locations are dropped.
    let changed_paths = first_parent_blob_changes(repo, commit_oid, budget)
        .ok()?
        .unwrap_or_default()
        .iter()
        .filter_map(|change| std::str::from_utf8(change.location()).ok())
        .map(str::to_owned)
        .collect();
    let patch_id = compute_patch_id(repo, commit_oid, budget)
        .ok()?
        .map(|value| super::super::anchor::PatchIdCapture {
            algorithm: PATCH_ID_ALGORITHM.to_string(),
            value,
        });
    Some(AnchorCapture {
        commit_oid: commit_oid.to_string(),
        tree_oid: Some(tree_oid.to_string()),
        patch_id,
        changed_paths,
    })
}
