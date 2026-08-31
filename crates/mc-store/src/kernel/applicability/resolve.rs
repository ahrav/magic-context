//! Anchor commit resolution: ancestry tests against HEAD, a version-tagged
//! patch identity, and the exact-OID → ancestry → patch-ID → tree-hash
//! fallback ladder with stop-on-ambiguity.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use gix::ObjectId;
use sha2::{Digest, Sha256};

use super::super::anchor::{AnchorCapture, GitCondition};
use super::super::scope::GraphOracle;
use super::checkout::{CheckoutSnapshot, EvalBudget};

/// Version tag for this crate's patch identity. Values are internal
/// fallback keys: whitespace-stripped per-file content hashes combined
/// order-independently, never interchangeable with `git patch-id` output.
pub const PATCH_ID_ALGORITHM: &str = "mc-patch-id-v1";

/// Fallback candidates come from the first-parent walk from HEAD, capped, so
/// resolution cost stays bounded on deep histories. A true match outside the
/// window is unresolved at that rung.
pub const CANDIDATE_WINDOW: usize = 512;

/// Ancestry walks stop after this many commits even under a generous
/// deadline, keeping a single test bounded on pathological histories.
const ANCESTRY_WALK_CAP: usize = 1 << 20;

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
    window: RefCell<Option<Vec<ObjectId>>>,
    graph_operations: Cell<u64>,
}

impl<'s> ResolutionLadder<'s> {
    pub fn new(snapshot: &'s CheckoutSnapshot, budget: &'s EvalBudget) -> Self {
        Self {
            snapshot,
            budget,
            ancestry_cache: RefCell::new(HashMap::new()),
            window: RefCell::new(None),
            graph_operations: Cell::new(0),
        }
    }

    /// Object-database operations performed so far: ancestry walks,
    /// candidate-window builds, and patch-ID computations. The zero-IO
    /// cache-hit proof asserts this stays flat on hits.
    pub fn graph_operations(&self) -> u64 {
        self.graph_operations.get()
    }

    pub fn budget_was_exhausted(&self) -> bool {
        self.budget.is_exhausted()
    }

    fn count_graph_operation(&self) {
        self.graph_operations.set(self.graph_operations.get() + 1);
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
        let stored_patch_id = capture
            .patch_id
            .as_ref()
            .filter(|patch| patch.algorithm == PATCH_ID_ALGORITHM);
        if let Some(stored) = stored_patch_id {
            match self.match_candidates(|candidate| {
                if !self.commit_touches_paths(candidate, &capture.changed_paths) {
                    return Ok(false);
                }
                Ok(
                    compute_patch_id(self.snapshot.repo(), candidate, self.budget)?
                        .is_some_and(|patch_id| patch_id == stored.value),
                )
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
        for candidate in window {
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
    fn candidate_window(&self) -> Option<Vec<ObjectId>> {
        if let Some(window) = self.window.borrow().as_ref() {
            return Some(window.clone());
        }
        self.count_graph_operation();
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
        *self.window.borrow_mut() = Some(window.clone());
        Some(window)
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
        paths.iter().any(|path| {
            let new_entry = tree
                .lookup_entry_by_path(path.as_str())
                .ok()
                .flatten()
                .map(|entry| entry.object_id());
            let old_entry = parent_tree.as_ref().and_then(|tree| {
                tree.lookup_entry_by_path(path.as_str())
                    .ok()
                    .flatten()
                    .map(|entry| entry.object_id())
            });
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
        let answer = self.walk_ancestry(ancestor, descendant);
        self.ancestry_cache
            .borrow_mut()
            .insert((ancestor, descendant), answer);
        answer
    }

    /// Ancestor walk from `descendant` looking for `ancestor`. gix uses the
    /// commit-graph file when present and falls back to the object store
    /// per commit, so a stale graph never renders a reachable commit
    /// unreachable. Budget exhaustion or missing objects answer unknown.
    fn walk_ancestry(&self, ancestor: ObjectId, descendant: ObjectId) -> Option<bool> {
        self.count_graph_operation();
        let repo = self.snapshot.repo();
        if repo.find_commit(descendant).is_err() || repo.find_commit(ancestor).is_err() {
            return None;
        }
        let walk = repo.rev_walk([descendant]).all().ok()?;
        for (steps, info) in walk.enumerate() {
            if steps >= ANCESTRY_WALK_CAP || self.budget.is_exhausted() {
                return None;
            }
            let info = info.ok()?;
            if info.id == ancestor {
                return Some(true);
            }
        }
        Some(false)
    }
}

/// Candidates that decide a fallback rung: exactly one match resolves,
/// several stop resolution, none falls through to the next rung.
enum WindowMatch {
    Exactly,
    Ambiguous,
    None,
    Budget,
}

struct Budget;

impl GraphOracle for ResolutionLadder<'_> {
    fn is_ancestor_or_equal(&self, ancestor: &str, descendant: &str) -> Option<bool> {
        let ancestor = ObjectId::from_hex(ancestor.as_bytes()).ok()?;
        let descendant = ObjectId::from_hex(descendant.as_bytes()).ok()?;
        self.is_ancestor_or_equal_oid(ancestor, descendant)
    }
}

/// Computes this crate's version-tagged patch identity for `commit`:
/// per-file hashes over (change kind, paths, whitespace-stripped content),
/// XOR-combined so file order cannot perturb the identity. Merge commits
/// have no patch identity, mirroring `git patch-id` semantics.
pub fn compute_patch_id(
    repo: &gix::Repository,
    commit: ObjectId,
    budget: &EvalBudget,
) -> Result<Option<String>, BudgetExhaustedInResolve> {
    let commit = match repo.find_commit(commit) {
        Ok(commit) => commit,
        Err(_) => return Ok(None),
    };
    let parents: Vec<_> = commit.parent_ids().collect();
    if parents.len() > 1 {
        return Ok(None);
    }
    let new_tree = match commit.tree() {
        Ok(tree) => tree,
        Err(_) => return Ok(None),
    };
    let old_tree = match parents.first() {
        Some(parent) => match repo
            .find_commit(parent.detach())
            .ok()
            .and_then(|parent| parent.tree().ok())
        {
            Some(tree) => Some(tree),
            None => return Ok(None),
        },
        None => None,
    };
    let changes = match repo.diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), None) {
        Ok(changes) => changes,
        Err(_) => return Ok(None),
    };
    if changes.is_empty() {
        return Ok(None);
    }
    let mut combined = [0u8; 32];
    for change in &changes {
        if budget.is_exhausted() {
            return Err(BudgetExhaustedInResolve);
        }
        let Some(file_hash) = file_change_hash(repo, change) else {
            return Ok(None);
        };
        for (byte, file_byte) in combined.iter_mut().zip(file_hash.iter()) {
            *byte ^= file_byte;
        }
    }
    Ok(Some(hex(&combined)))
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
    hash.update(b"mc-patch-id-v1-file\0");
    hash.update(kind.as_bytes());
    hash.update(b"\0");
    hash.update(location.as_slice());
    hash.update(b"\0");
    for id in [old_id, new_id] {
        match id {
            Some(id) if !id.is_null() => {
                let blob = repo.find_blob(id).ok()?;
                hash.update(normalized_content(&blob.data));
            }
            _ => hash.update(b"<absent>"),
        }
        hash.update(b"\0");
    }
    Some(hash.finalize().into())
}

/// Strips all ASCII whitespace so formatting-only variants of the same
/// change share a patch identity.
fn normalized_content(bytes: &[u8]) -> Vec<u8> {
    bytes
        .iter()
        .copied()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
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
    let parents: Vec<_> = commit.parent_ids().collect();
    let changed_paths = if parents.len() > 1 {
        Vec::new()
    } else {
        let new_tree = commit.tree().ok()?;
        let old_tree = match parents.first() {
            Some(parent) => Some(repo.find_commit(parent.detach()).ok()?.tree().ok()?),
            None => None,
        };
        repo.diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), None)
            .ok()?
            .iter()
            .map(|change| change.location().to_string())
            .collect()
    };
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
