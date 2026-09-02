//! Anchor commit resolution: ancestry tests against HEAD, a version-tagged
//! patch identity, and the exact-OID → ancestry → patch-ID → tree-hash
//! fallback ladder with stop-on-ambiguity.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
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
    /// A shallow boundary truncates every graph walk, so a negative ancestry
    /// result cannot be trusted. Read once per request.
    shallow: bool,
    ancestry_cache: RefCell<HashMap<(ObjectId, ObjectId), Option<bool>>>,
    graph: RefCell<Option<gix::revwalk::Graph<'s, 's, gix::revwalk::graph::Commit<u64>>>>,
    graph_query: Cell<u64>,
    window: RefCell<Option<CandidateWindow>>,
    /// A candidate's patch identity depends only on its commit.
    patch_id_cache: RefCell<HashMap<ObjectId, Option<String>>>,
    graph_operations: Cell<u64>,
    /// Whether any resolution needed an object the database did not hold.
    saw_unreadable_object: Cell<bool>,
    /// Sticky once movement is seen. Only that direction is memoized: a
    /// boundary that matched before one walk says nothing about the boundary a
    /// later walk ran under.
    repository_state_moved: Cell<bool>,
}

impl<'s> ResolutionLadder<'s> {
    pub fn new(snapshot: &'s CheckoutSnapshot, budget: &'s EvalBudget) -> Self {
        Self {
            snapshot,
            budget,
            shallow: snapshot.is_shallow(),
            ancestry_cache: RefCell::new(HashMap::new()),
            graph: RefCell::new(None),
            graph_query: Cell::new(0),
            window: RefCell::new(None),
            patch_id_cache: RefCell::new(HashMap::new()),
            graph_operations: Cell::new(0),
            saw_unreadable_object: Cell::new(false),
            repository_state_moved: Cell::new(false),
        }
    }

    pub(super) fn snapshot(&self) -> &CheckoutSnapshot {
        self.snapshot
    }

    pub(super) fn budget(&self) -> &EvalBudget {
        self.budget
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

    /// Whether any resolution this request performed needed an object the
    /// database did not hold.
    ///
    /// Object availability is deliberately outside the snapshot generation,
    /// because a fetch can supply a missing commit without moving HEAD, the
    /// worktree, sparse configuration, or the shallow file. An outcome that
    /// rests on an absent object is therefore transient exactly as a
    /// budget-driven one is, and is not retained.
    ///
    /// This is a request-wide predicate rather than a per-evaluation delta on
    /// purpose. The ancestry, window, and patch-ID memos serve later
    /// candidates from the first candidate's work, so a delta would credit the
    /// absent object only to whichever candidate happened to read it first and
    /// let every other candidate retain the same uncertainty. An incomplete
    /// object database is a property of the request, not of one lookup.
    pub fn saw_unreadable_object(&self) -> bool {
        self.saw_unreadable_object.get()
    }

    fn note_unreadable_object(&self) {
        self.saw_unreadable_object.set(true);
    }

    /// Whether sparse or shallow state moved out from under the graph work this
    /// request performed.
    ///
    /// Unlike an absent object, this invalidates every outcome rather than only
    /// an uncertain one: a walk that ran under a deepened boundary can report
    /// `Holds` where the boundary the key names would truncate it, and
    /// re-truncating to that same boundary makes the key match again. Callers
    /// therefore ask before retaining any graph-derived verdict. Only
    /// movement is memoized, so an unchanged boundary is re-read on every
    /// call: a match established before one walk says nothing about the
    /// boundary a later walk ran under.
    pub fn repository_state_moved(&self) -> bool {
        if self.repository_state_moved.get() {
            return true;
        }
        let moved = !self.snapshot.repository_state_still_current(self.budget);
        if moved {
            self.repository_state_moved.set(true);
        }
        moved
    }

    /// Whether movement was already seen, without re-reading.
    ///
    /// A verdict that reused this request's graph work — through the anchor
    /// memo or the anchor cache — inherits whatever the walk behind it ran
    /// under, and performs no graph operations of its own to reveal it.
    pub fn repository_state_movement_seen(&self) -> bool {
        self.repository_state_moved.get()
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
                    // Reaching the end exits the validity window, which is
                    // exactly what `historical` records, so this side is
                    // tested first: a start the ladder could not place must
                    // not downgrade an end that is demonstrably reached.
                    // `WallClockInterval` orders its bounds the same way.
                    (_, CommitResolution::Reachable) => {
                        GitConditionOutcome::DoesNotHold { historical: true }
                    }
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
        // A parsed OID the database does not hold is the availability case: a
        // fetch can supply it later without moving anything the key covers.
        if anchor.is_some() && !anchor_present {
            self.note_unreadable_object();
        }
        // An undecided ancestry test still permits a positive fallback match.
        // Every window candidate is reachable from HEAD, so a match proves
        // reachability; it only bars the negative conclusion below.
        let mut ancestry_undecided = false;
        if anchor_present {
            match self.is_ancestor_or_equal_oid(anchor.expect("present implies parsed"), head) {
                Some(true) => return CommitResolution::Reachable,
                Some(false) => {}
                None => ancestry_undecided = true,
            }
        }
        match self.match_in_window(capture) {
            WindowMatch::Exactly => CommitResolution::Reachable,
            WindowMatch::Ambiguous => CommitResolution::Uncertain,
            WindowMatch::Budget => CommitResolution::Uncertain,
            WindowMatch::Unreadable => CommitResolution::Uncertain,
            WindowMatch::None
                if anchor_present && !ancestry_undecided && self.window_scan_complete(capture) =>
            {
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
        let mut patch_unreadable = capture
            .patch_id
            .as_ref()
            .is_some_and(|patch| patch.algorithm != PATCH_ID_ALGORITHM);
        let stored_patch_id = capture
            .patch_id
            .as_ref()
            .filter(|patch| patch.algorithm == PATCH_ID_ALGORITHM)
            // A current-tag value this build cannot have produced is
            // uninterpretable fallback data, exactly like a malformed
            // `tree_oid`: no candidate can ever equal it, so treating it as
            // readable would turn a corrupt capture into an ordinary miss
            // and let the scan conclude `NotReachable`.
            .filter(|patch| {
                let well_formed = is_sha256_hex(&patch.value);
                patch_unreadable |= !well_formed;
                well_formed
            });
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
                // The tree rung needs only a commit and its root tree, so an
                // unreadable blob here does not bar an independent match
                // there; it only rules out concluding a miss.
                WindowMatch::Unreadable => patch_unreadable = true,
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
        // A stored tree id this build cannot parse is uninterpretable fallback
        // data, exactly like an unsupported patch algorithm, and
        // `window_scan_complete` counts the field as present either way.
        let Ok(tree) = ObjectId::from_hex(tree_oid.as_bytes()) else {
            return WindowMatch::Unreadable;
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
            // `matches` performs graph operations not counted internally.
            self.count_graph_operation();
            match matches(candidate) {
                Ok(true) => {
                    if found.replace(candidate).is_some() {
                        return WindowMatch::Ambiguous;
                    }
                }
                Ok(false) => {}
                Err(ResolveObstacle::BudgetExhausted) => return WindowMatch::Budget,
                Err(ResolveObstacle::UnreadableObject) => {
                    self.note_unreadable_object();
                    return WindowMatch::Unreadable;
                }
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
        self.count_graph_operation();
        let repo = self.snapshot.repo();
        let head = ObjectId::from_hex(self.snapshot.head().as_bytes()).ok()?;
        // The walk follows all parents: a rewrite reachable only through a
        // merge's non-first parent is still a fallback candidate.
        //
        // A walk that cannot start, or that stops advancing partway, wanted a
        // commit the database does not hold. That is the availability case,
        // not budget exhaustion: without recording it, the caller reports the
        // same `Uncertain` a deadline produces while both transience
        // predicates read false, so the verdict is retained and a fetch
        // supplying the missing commit cannot dislodge it until eviction.
        let walk = match repo.rev_walk([head]).all() {
            Ok(walk) => walk,
            Err(_) => {
                self.note_unreadable_object();
                return None;
            }
        };
        let mut commits = Vec::new();
        let mut walk = walk.into_iter();
        for info in walk.by_ref().take(CANDIDATE_WINDOW) {
            if self.budget.is_exhausted() {
                return None;
            }
            match info {
                Ok(info) => commits.push(info.id),
                Err(_) => {
                    self.note_unreadable_object();
                    return None;
                }
            }
        }
        // `is_some` cannot separate a real next commit from a walk that failed
        // to reach one. Scanned commits stay candidates either way, since each
        // is reachable from HEAD and a positive match resolves regardless of
        // what lies beyond the window; truncation withholds only the negative
        // conclusion, while the absent object keeps the uncertainty a miss
        // produces out of both caches.
        let mut truncated = false;
        if commits.len() == CANDIDATE_WINDOW {
            match walk.next() {
                Some(Ok(_)) => truncated = true,
                Some(Err(_)) => {
                    self.note_unreadable_object();
                    truncated = true;
                }
                None => {}
            }
        }
        let window = CandidateWindow {
            truncated,
            commits: commits.into(),
        };
        *self.window.borrow_mut() = Some(window.clone());
        Some(window)
    }

    fn cached_patch_id(&self, candidate: ObjectId) -> Result<Option<String>, ResolveObstacle> {
        if let Some(cached) = self.patch_id_cache.borrow().get(&candidate) {
            return Ok(cached.clone());
        }
        self.count_graph_operation();
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
        // A lookup that fails is not an absent entry: in a partial clone the
        // subtree holding `path` can be missing, and reading both sides as
        // absent would call the candidate untouched and drop it from the
        // rung, turning a present-but-unreachable anchor into a verdict.
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
    /// A shallow clone also yields no base once the walk reaches a grafted
    /// boundary, which is indistinguishable from disjoint history, so a
    /// negative result there stays unknown.
    fn test_ancestry(&self, ancestor: ObjectId, descendant: ObjectId) -> Option<bool> {
        self.count_graph_operation();
        let repo = self.snapshot.repo();
        if repo.find_commit(descendant).is_err() || repo.find_commit(ancestor).is_err() {
            self.note_unreadable_object();
            return None;
        }
        if !self.shallow {
            return self.test_ancestry_graph(ancestor, descendant);
        }
        // Both endpoints exist, so a failure here is a missing object further
        // in: an intermediate parent a later fetch can supply.
        let bases = match repo.merge_bases_many(ancestor, &[descendant]) {
            Ok(bases) => bases,
            Err(_) => {
                self.note_unreadable_object();
                return None;
            }
        };
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

    fn test_ancestry_graph(&self, ancestor: ObjectId, descendant: ObjectId) -> Option<bool> {
        let mut graph = self.graph.borrow_mut();
        let graph = graph.get_or_insert_with(|| self.snapshot.revision_graph());
        let ancestor_generation = match graph.get_or_insert_commit(ancestor, |_| {}) {
            Ok(Some(commit)) => commit.generation,
            Ok(None) | Err(_) => {
                self.note_unreadable_object();
                return None;
            }
        };
        let mut query = self.graph_query.get().wrapping_add(1);
        if query == 0 {
            graph.clear_commit_data(|seen| *seen = 0);
            query = 1;
        }
        self.graph_query.set(query);

        let mut pending = VecDeque::from([descendant]);
        let mut steps = 0usize;
        while let Some(id) = pending.pop_front() {
            if self.budget.is_exhausted() || steps >= ANCESTRY_WALK_CAP {
                return None;
            }
            let mut seen = false;
            let commit = match graph.get_or_insert_commit(id, |last_query| {
                seen = *last_query == query;
                *last_query = query;
            }) {
                Ok(Some(commit)) => commit,
                Ok(None) | Err(_) => {
                    self.note_unreadable_object();
                    return None;
                }
            };
            if seen {
                continue;
            }
            steps += 1;
            if id == ancestor {
                return Some(true);
            }
            if commit
                .generation
                .zip(ancestor_generation)
                .is_some_and(|(generation, ancestor)| generation < ancestor)
            {
                continue;
            }
            pending.extend(commit.parents.iter().copied());
        }
        Some(false)
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
    budget_gate(budget)?;
    let changes = first_parent_blob_changes(repo, commit, budget)?;
    patch_id_from_changes(repo, changes.as_deref(), budget)
}

/// Computes the identity from an already-computed first-parent diff to avoid a
/// second tree walk.
fn patch_id_from_changes(
    repo: &gix::Repository,
    changes: Option<&[gix::object::tree::diff::ChangeDetached]>,
    budget: &EvalBudget,
) -> Result<Option<String>, ResolveObstacle> {
    let changes = match changes {
        Some(changes) if !changes.is_empty() => changes,
        // A merge returns before the diff callback and an empty diff invokes
        // none, so neither path has polled since the caller's gate.
        _ => {
            budget_gate(budget)?;
            return Ok(None);
        }
    };
    let mut file_hashes = Vec::with_capacity(changes.len());
    for change in changes {
        budget_gate(budget)?;
        let Some(file_hash) = file_change_hash(repo, change, budget)? else {
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
    // The last blob's load and hash, the sort, and this fold all run after the
    // final per-change poll, and callers persist or cache what comes back, so
    // the gate sits at the exit rather than ahead of the aggregation.
    budget_gate(budget)?;
    Ok(Some(format!("{:x}", combined.finalize())))
}

/// The exact rendering [`compute_patch_id`] emits: 64 lowercase hex digits.
fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
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

fn budget_gate(budget: &EvalBudget) -> Result<(), ResolveObstacle> {
    if budget.is_exhausted() {
        Err(ResolveObstacle::BudgetExhausted)
    } else {
        Ok(())
    }
}

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
                        // A symlink blob holds a target path, where a space
                        // is part of the name and no NUL marks it binary, so
                        // normalization would fold `a b` into `ab`.
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
    budget_gate(budget).ok()?;
    // A tree a parent already carries cannot show this commit was replayed, so
    // the tree rung would match that parent instead. Empty commits and merges
    // whose result equals a side are the cases that produce one.
    let tree_distinguishes = !parent_shares_tree(repo, &commit, tree_oid);
    // An unreadable object costs the patch rung, not the capture: the commit
    // and tree ids are already resolved, and the tree rung runs on those
    // alone. An empty path list also disables the prefilter, which is the
    // safe direction. Cancellation is different — a capture assembled after
    // the budget expired would persist a partial view as if complete.
    let changes = match first_parent_blob_changes(repo, commit_oid, budget) {
        Ok(changes) => changes,
        Err(ResolveObstacle::BudgetExhausted) => return None,
        Err(ResolveObstacle::UnreadableObject) => None,
    };
    // A lossily converted path would miss real tree entries in
    // `commit_touches_paths`, so non-UTF-8 locations are dropped.
    let changed_paths = changes
        .iter()
        .flatten()
        .filter_map(|change| std::str::from_utf8(change.location()).ok())
        .map(str::to_owned)
        .collect();
    let patch_id = match patch_id_from_changes(repo, changes.as_deref(), budget) {
        Ok(value) => value,
        Err(ResolveObstacle::BudgetExhausted) => return None,
        Err(ResolveObstacle::UnreadableObject) => None,
    }
    .map(|value| super::super::anchor::PatchIdCapture {
        algorithm: PATCH_ID_ALGORITHM.to_string(),
        value,
    });
    Some(AnchorCapture {
        commit_oid: commit_oid.to_string(),
        tree_oid: tree_distinguishes.then(|| tree_oid.to_string()),
        patch_id,
        changed_paths,
    })
}

/// Whether any parent of `commit` already carries `tree_oid`.
///
/// An unreadable parent answers `true`: withholding a fallback costs a rung,
/// while offering one that cannot distinguish the commit risks calling an
/// anchor current on the strength of its parent.
fn parent_shares_tree(
    repo: &gix::Repository,
    commit: &gix::Commit<'_>,
    tree_oid: ObjectId,
) -> bool {
    commit.parent_ids().any(|parent| {
        repo.find_commit(parent.detach())
            .ok()
            .and_then(|parent| parent.tree_id().ok())
            .is_none_or(|parent_tree| parent_tree.detach() == tree_oid)
    })
}
