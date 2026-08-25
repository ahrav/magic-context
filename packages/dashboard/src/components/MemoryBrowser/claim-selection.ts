import type { ClaimMemory, ClaimMutationTarget } from "../../lib/types";

export type SelectionState = ReadonlyMap<string, SelectionEntry>;

export interface SelectionEntry {
  claim: ClaimMemory;
  stale: boolean;
}

export interface ClaimDraft {
  publicClaimId: string;
  revisionLocator: string;
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
      stale: entry.stale || refreshed === undefined || tokenChanged(entry.claim, refreshed),
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
  else next.set(claim.publicClaimId, { claim, stale: false });
  return next;
}

export function selectionState(selected: SelectionState, claims: readonly ClaimMemory[]): TriState {
  if (claims.length === 0) return "none";
  const selectedCount = claims.filter((claim) => selected.has(claim.publicClaimId)).length;
  if (selectedCount === 0) return "none";
  return selectedCount === claims.length ? "all" : "some";
}

export function toggleClaimsSelection(
  previous: SelectionState,
  claims: readonly ClaimMemory[],
): Map<string, SelectionEntry> {
  const next = new Map(previous);
  const state = selectionState(previous, claims);
  for (const claim of claims) {
    if (state === "all") next.delete(claim.publicClaimId);
    else next.set(claim.publicClaimId, { claim, stale: false });
  }
  return next;
}

export function selectionTargets(selected: SelectionState): ClaimMutationTarget[] {
  const stale = [...selected.entries()]
    .filter(([, entry]) => entry.stale)
    .map(([publicClaimId]) => publicClaimId)
    .sort();
  if (stale.length > 0) {
    throw new Error(`Refresh stale selections before continuing: ${stale.join(", ")}`);
  }
  return [...selected.values()]
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
