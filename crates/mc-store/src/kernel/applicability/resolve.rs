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

/// Version tag for this crate's patch identity. Values are internal
/// fallback keys: whitespace-stripped per-file content hashes combined
/// order-independently, never interchangeable with `git patch-id` output.
pub const PATCH_ID_ALGORITHM: &str = "mc-patch-id-v2";

/// Fallback candidates come from the first-parent walk from HEAD, capped, so
/// resolution cost stays bounded on deep histories. A true match outside the
/// window is unresolved at that rung.
pub const CANDIDATE_WINDOW: usize = 512;

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
    ancestry_cache: RefCell<HashMap<(ObjectId, ObjectId), Option<bool>>>,
    window: RefCell<Option<Rc<[ObjectId]>>>,
    /// A candidate's patch identity depends only on its commit.
    patch_id_cache: RefCell<HashMap<ObjectId, Option<String>>>,
}

impl<'s> ResolutionLadder<'s> {
    pub fn new(snapshot: &'s CheckoutSnapshot, budget: &'s EvalBudget) -> Self {
        Self {
            snapshot,
            budget,
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
                    (CommitResolution::Uncertain, _) | (_, CommitResolution::Uncertain) => {
                        GitConditionOutcome::Uncertain
                    }
                    (CommitResolution::NotReachable, _) => {
                        GitConditionOutcome::DoesNotHold { historical: false }
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
            WindowMatch::None if anchor_present => CommitResolution::NotReachable,
            WindowMatch::None => CommitResolution::Uncertain,
        }
    }

    /// Patch-ID rung, then tree-hash rung, over the bounded candidate
    /// window. Multiple matches at either rung stop resolution (KTD2:
    /// ambiguity is uncertain, never current).
    fn match_in_window(&self, capture: Option<&AnchorCapture>) -> WindowMatch {
        let Some(capture) = capture else {
            return WindowMatch::None;
        };
        // Patch IDs from a different algorithm cannot establish anchor movement.
        if capture
            .patch_id
            .as_ref()
            .is_some_and(|patch| patch.algorithm != PATCH_ID_ALGORITHM)
        {
            return WindowMatch::Unreadable;
        }
        let stored_patch_id = capture.patch_id.as_ref();
        if let Some(stored) = stored_patch_id {
            match self.match_candidates(|candidate| {
                if !self.commit_touches_paths(candidate, &capture.changed_paths) {
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
        let Some(tree_oid) = capture.tree_oid.as_deref() else {
            return WindowMatch::None;
        };
        let Ok(tree) = ObjectId::from_hex(tree_oid.as_bytes()) else {
            return WindowMatch::None;
        };
        self.match_candidates(|candidate| {
            let commit = self
                .snapshot
                .repo()
                .find_commit(candidate)
                .map_err(|_| Budget)?;
            Ok(commit.tree_id().map_err(|_| Budget)?.detach() == tree)
        })
    }

    fn match_candidates(
        &self,
        mut matches: impl FnMut(ObjectId) -> Result<bool, Budget>,
    ) -> WindowMatch {
        let Some(window) = self.candidate_window() else {
            return WindowMatch::Budget;
        };
        let mut found = None;
        for candidate in window.iter().copied() {
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
                Err(Budget) => return WindowMatch::Budget,
            }
        }
        match found {
            Some(_) => WindowMatch::Exactly,
            None => WindowMatch::None,
        }
    }

    /// First-parent commits from HEAD, capped at [`CANDIDATE_WINDOW`],
    /// computed once per request.
    fn candidate_window(&self) -> Option<Rc<[ObjectId]>> {
        if let Some(window) = self.window.borrow().as_ref() {
            return Some(Rc::clone(window));
        }
        let repo = self.snapshot.repo();
        let head = ObjectId::from_hex(self.snapshot.head().as_bytes()).ok()?;
        let walk = repo.rev_walk([head]).first_parent_only().all().ok()?;
        let mut window = Vec::new();
        for info in walk.take(CANDIDATE_WINDOW) {
            if self.budget.is_exhausted() {
                return None;
            }
            window.push(info.ok()?.id);
        }
        let window: Rc<[ObjectId]> = window.into();
        *self.window.borrow_mut() = Some(Rc::clone(&window));
        Some(window)
    }

    fn cached_patch_id(&self, candidate: ObjectId) -> Result<Option<String>, Budget> {
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
    fn commit_touches_paths(&self, commit: ObjectId, paths: &[String]) -> bool {
        if paths.is_empty() {
            return true;
        }
        let repo = self.snapshot.repo();
        let Ok(commit) = repo.find_commit(commit) else {
            return false;
        };
        let Ok(tree) = commit.tree() else {
            return false;
        };
        let parent_tree = commit
            .parent_ids()
            .next()
            .and_then(|parent| repo.find_commit(parent.detach()).ok())
            .and_then(|parent| parent.tree().ok());
        // Mode is part of the comparison, since a diff reports a mode-only
        // change while the entry ids stay equal.
        let entry_at = |tree: &gix::Tree<'_>, path: &str| {
            tree.lookup_entry_by_path(path)
                .ok()
                .flatten()
                .map(|entry| (entry.object_id(), entry.mode().kind()))
        };
        paths.iter().any(|path| {
            let new_entry = entry_at(&tree, path.as_str());
            let old_entry = parent_tree
                .as_ref()
                .and_then(|tree| entry_at(tree, path.as_str()));
            new_entry != old_entry
        })
    }

    fn is_ancestor_or_equal_oid(&self, ancestor: ObjectId, descendant: ObjectId) -> Option<bool> {
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
    fn test_ancestry(&self, ancestor: ObjectId, descendant: ObjectId) -> Option<bool> {
        let repo = self.snapshot.repo();
        if repo.find_commit(descendant).is_err() || repo.find_commit(ancestor).is_err() {
            return None;
        }
        let bases = repo.merge_bases_many(ancestor, &[descendant]).ok()?;
        Some(bases.iter().any(|base| base.detach() == ancestor))
    }
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

struct Budget;

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
) -> Result<Option<String>, BudgetExhaustedInResolve> {
    let Some(changes) = first_parent_blob_changes(repo, commit) else {
        return Ok(None);
    };
    if changes.is_empty() {
        return Ok(None);
    }
    let mut file_hashes = Vec::with_capacity(changes.len());
    for change in &changes {
        if budget.is_exhausted() {
            return Err(BudgetExhaustedInResolve);
        }
        let Some(file_hash) = file_change_hash(repo, change) else {
            return Ok(None);
        };
        file_hashes.push(file_hash);
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
/// Default diff options keep repository `diff.renames` out of the identity.
fn first_parent_blob_changes(
    repo: &gix::Repository,
    commit: ObjectId,
) -> Option<Vec<gix::object::tree::diff::ChangeDetached>> {
    let commit = repo.find_commit(commit).ok()?;
    let parents: Vec<_> = commit.parent_ids().collect();
    if parents.len() > 1 {
        return None;
    }
    let new_tree = commit.tree().ok()?;
    let old_tree = match parents.first() {
        Some(parent) => Some(repo.find_commit(parent.detach()).ok()?.tree().ok()?),
        None => None,
    };
    let changes = repo
        .diff_tree_to_tree(
            old_tree.as_ref(),
            Some(&new_tree),
            Some(gix::diff::Options::default()),
        )
        .ok()?
        .into_iter()
        .filter(|change| !change.entry_mode().is_tree())
        .collect();
    Some(changes)
}

/// Typed budget signal raised from inside patch-ID computation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetExhaustedInResolve;

impl From<BudgetExhaustedInResolve> for Budget {
    fn from(_: BudgetExhaustedInResolve) -> Self {
        Budget
    }
}

fn file_change_hash(
    repo: &gix::Repository,
    change: &gix::object::tree::diff::ChangeDetached,
) -> Option<[u8; 32]> {
    use gix::object::tree::diff::ChangeDetached as Change;
    let (kind, location, old_id, new_id): (&str, _, Option<ObjectId>, Option<ObjectId>) =
        match change {
            Change::Addition { location, id, .. } => ("add", location, None, Some(*id)),
            Change::Deletion { location, id, .. } => ("delete", location, Some(*id), None),
            Change::Modification {
                location,
                previous_id,
                id,
                ..
            } => ("modify", location, Some(*previous_id), Some(*id)),
            Change::Rewrite {
                location,
                source_id,
                id,
                ..
            } => ("rewrite", location, Some(*source_id), Some(*id)),
        };
    let mut hash = Sha256::new();
    // Derived from the version tag, so a hash change forces a tag change.
    hash.update(PATCH_ID_ALGORITHM.as_bytes());
    hash.update(b"-file\0");
    hash.update(kind.as_bytes());
    hash.update(b"\0");
    hash.update(location.as_slice());
    hash.update(b"\0");
    for id in [old_id, new_id] {
        match id {
            Some(id) if !id.is_null() => {
                let blob = repo.find_blob(id).ok()?;
                hash_normalized_content(&mut hash, &blob.data);
            }
            _ => hash.update(b"<absent>"),
        }
        hash.update(b"\0");
    }
    Some(hash.finalize().into())
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
    let changed_paths = first_parent_blob_changes(repo, commit_oid)
        .unwrap_or_default()
        .iter()
        .map(|change| change.location().to_string())
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
