import type { ClaimMemory, ClaimMutationTarget } from "../../lib/types";

export type SelectionState = ReadonlyMap<string, SelectionEntry>;

export interface SelectionEntry {
  claim: ClaimMemory;
  /**
   * The claim is still in view but its token moved underneath the selection, so
   * the cached token no longer describes it. Fail closed: acting on the batch
   * would act on a revision the user never saw.
   */
  stale: boolean;
  /**
   * The claim is no longer in the current view — a filter, project, or page
   * change dropped it. Not a concurrency signal, so it does not block the
   * batch; it is simply excluded from it.
   */
  offScope: boolean;
}

export interface ClaimDraft {
  publicClaimId: string;
  /**
   * Locator and token of the revision this draft was started against, pinned at
   * the first keystroke and never refreshed.
   *
   * A save must fence against the base the user actually edited. Submitting the
   * refreshed token would make the adapter accept a write whose text predates a
   * concurrent revision, silently discarding it; submitting the original lets
   * the token fence report `stale`, which is the outcome the fence exists for.
   */
  revisionLocator: string;
  mutationToken: ClaimMemory["mutationToken"];
  text: string;
  revisionAdvanced: boolean;
}

export type TriState = "none" | "some" | "all";

function tokenChanged(previous: ClaimMemory, current: ClaimMemory): boolean {
  const before = previous.mutationToken;
  const after = current.mutationToken;
  return (
    previous.revisionLocator !== current.revisionLocator ||
    before.revision !== after.revision ||
    before.contentDigest !== after.contentDigest ||
    before.lifecycleSeq !== after.lifecycleSeq ||
    before.applicabilityHeadsDigest !== after.applicabilityHeadsDigest ||
    before.policyHeadsDigest !== after.policyHeadsDigest
  );
}

/**
 * Whether a bulk action can address this claim at all.
 *
 * Retirement is terminal in the adapter: `validate_target` refuses every
 * mutation of a retired claim, and `bulk_archive_claims` validates every target
 * before staging any of them. So one retired row in a batch archives nothing.
 * The Retired and all-lifecycle views both return such claims, so they are
 * excluded from selection rather than allowed to poison a batch.
 */
export function isSelectableClaim(claim: ClaimMemory): boolean {
  return claim.lifecycleState !== "retired";
}

/**
 * Re-bind a selection to a freshly fetched claim list.
 *
 * Off-scope and stale are tracked apart because only one of them is a hazard.
 * A claim that left the view carries no evidence either way, so it is marked
 * off-scope and excluded from batches; if it returns, its token is compared
 * again and it participates normally when unchanged. Token drift is sticky: once
 * a selected claim has moved, the cached token stays untrustworthy until the
 * user reselects it.
 */
export function reconcileClaimSelection(
  previous: SelectionState,
  claims: readonly ClaimMemory[],
): Map<string, SelectionEntry> {
  const current = new Map(claims.map((claim) => [claim.publicClaimId, claim]));
  const next = new Map<string, SelectionEntry>();
  for (const [publicClaimId, entry] of previous) {
    const refreshed = current.get(publicClaimId);
    next.set(publicClaimId, {
      claim: refreshed ?? entry.claim,
      stale: entry.stale || (refreshed !== undefined && tokenChanged(entry.claim, refreshed)),
      offScope: refreshed === undefined,
    });
  }
  return next;
}

export function toggleClaimSelection(
  previous: SelectionState,
  claim: ClaimMemory,
): Map<string, SelectionEntry> {
  const next = new Map(previous);
  if (next.has(claim.publicClaimId)) next.delete(claim.publicClaimId);
  else if (isSelectableClaim(claim))
    next.set(claim.publicClaimId, { claim, stale: false, offScope: false });
  return next;
}

export function selectionState(selected: SelectionState, claims: readonly ClaimMemory[]): TriState {
  const selectable = claims.filter(isSelectableClaim);
  if (selectable.length === 0) return "none";
  const selectedCount = selectable.filter((claim) => selected.has(claim.publicClaimId)).length;
  if (selectedCount === 0) return "none";
  return selectedCount === selectable.length ? "all" : "some";
}

export function toggleClaimsSelection(
  previous: SelectionState,
  claims: readonly ClaimMemory[],
): Map<string, SelectionEntry> {
  const next = new Map(previous);
  const state = selectionState(previous, claims);
  for (const claim of claims.filter(isSelectableClaim)) {
    if (state === "all") next.delete(claim.publicClaimId);
    else next.set(claim.publicClaimId, { claim, stale: false, offScope: false });
  }
  return next;
}

/**
 * Mutation targets for the current selection.
 *
 * Off-scope entries are dropped rather than refused: they are outside the view
 * the user is acting on, and every mutation is token-guarded anyway, so
 * including them could only produce rejections. Token drift on a VISIBLE entry
 * still refuses the whole batch — a partial apply against a revision the user
 * never saw is the outcome worth blocking.
 *
 * Off-scope wins over stale for the gate, and only for the gate. A claim can go
 * stale and then leave the view, and refusing on its behalf would block every
 * visible selection over an entry that renders no checkbox to refresh — the
 * dead end this function exists to remove. The flag stays on the entry, so the
 * same claim blocks again the moment it returns to view still drifted.
 */
export function selectionTargets(selected: SelectionState): ClaimMutationTarget[] {
  const stale = [...selected.entries()]
    .filter(([, entry]) => entry.stale && !entry.offScope)
    .map(([publicClaimId]) => publicClaimId)
    .sort();
  if (stale.length > 0) {
    throw new Error(`Refresh stale selections before continuing: ${stale.join(", ")}`);
  }
  return [...selected.values()]
    .filter((entry) => !entry.offScope)
    .map(({ claim }) => ({
      revisionLocator: claim.revisionLocator,
      mutationToken: claim.mutationToken,
    }))
    .sort((left, right) =>
      left.mutationToken.publicClaimId.localeCompare(right.mutationToken.publicClaimId),
    );
}

export function reconcileDraft(
  previous: ClaimDraft | null,
  claim: ClaimMemory | undefined,
): ClaimDraft | null {
  if (previous === null || claim === undefined || claim.publicClaimId !== previous.publicClaimId) {
    return previous;
  }
  return {
    ...previous,
    revisionAdvanced:
      previous.revisionAdvanced || previous.revisionLocator !== claim.revisionLocator,
  };
}

/**
 * The snapshot-error banner text for a settled read result.
 *
 * A stale result reports why it could not be published; any settled non-stale
 * result supersedes that report and must clear it. Returning the value rather
 * than only setting it on the stale branch is what keeps a transient concurrent
 * write from leaving the banner up through every later successful refresh.
 */
export function snapshotErrorFor(result: {
  outcome: string;
  staleReasons?: readonly string[];
}): string | null {
  if (result.outcome !== "stale") return null;
  return (result.staleReasons ?? []).join("; ") || "Claim snapshot changed during refresh";
}
