import { describe, expect, it } from "bun:test";
import type { ClaimMemory } from "../../lib/types";
import {
  isSelectableClaim,
  reconcileClaimSelection,
  reconcileDraft,
  selectionState,
  selectionTargets,
  toggleClaimSelection,
  toggleClaimsSelection,
  snapshotErrorFor,
} from "./claim-selection";

function claim(publicClaimId: string, revision = 1): ClaimMemory {
  const contentDigest = String(revision).repeat(64);
  return {
    publicClaimId,
    revisionLocator: `${publicClaimId}/r${revision}/${contentDigest}`,
    revision,
    content: `content ${revision}`,
    contentDigest,
    revisionCreatedAt: revision,
    projectIdentity: "git:test",
    category: "CONSTRAINTS",
    normalizedHash: "a".repeat(32),
    importance: 50,
    memoryScope: "project",
    sharing: "private",
    expiresAt: null,
    lifecycleState: "active",
    evidenceLabels: [],
    applicability: [],
    policy: {
      effectiveMaturity: "VERIFIED",
      originTaint: "USER_EXPLICIT",
      autoEligible: true,
      explicitEligible: true,
      hardHidden: false,
      policyVersion: 1,
      generation: revision,
      dispositions: {
        stale: false,
        disputed: false,
        superseded: false,
        rejected: false,
        contradicted: false,
        quarantined: false,
      },
      explicitLabel: null,
    },
    telemetry: { seenCount: 0, retrievalCount: 0 },
    mutationToken: {
      tokenVersion: 1,
      publicClaimId,
      revision,
      contentDigest,
      lifecycleSeq: 1,
      applicabilityHeadsDigest: "b".repeat(64),
      policyHeadsDigest: "c".repeat(64),
    },
  };
}

const A = "mcm_00112233445566778899aabbccddeeff";
const B = "mcm_ffeeddccbbaa99887766554433221100";

describe("claim selection", () => {
  it("preserves out-of-view selections without flagging them stale", () => {
    let selected = toggleClaimSelection(new Map(), claim(A));
    selected = toggleClaimSelection(selected, claim(B));

    const reconciled = reconcileClaimSelection(selected, [claim(A)]);

    expect([...reconciled.keys()]).toEqual([A, B]);
    expect(reconciled.get(A)).toMatchObject({ stale: false, offScope: false });
    expect(reconciled.get(B)).toMatchObject({ stale: false, offScope: true });
  });

  it("excludes out-of-view selections from a batch instead of refusing it", () => {
    // A filter change drops B out of view. Archiving must still act on A rather
    // than failing for all three, and the count must name only what it acts on.
    let selected = toggleClaimSelection(new Map(), claim(A));
    selected = toggleClaimSelection(selected, claim(B));
    const reconciled = reconcileClaimSelection(selected, [claim(A)]);

    const targets = selectionTargets(reconciled);
    expect(targets.map((target) => target.mutationToken.publicClaimId)).toEqual([A]);
  });

  it("re-admits a selection that comes back into view unchanged", () => {
    let selected = toggleClaimSelection(new Map(), claim(A));
    selected = reconcileClaimSelection(selected, []);
    expect(selected.get(A)?.offScope).toBe(true);

    selected = reconcileClaimSelection(selected, [claim(A)]);
    expect(selected.get(A)).toMatchObject({ stale: false, offScope: false });
    expect(selectionTargets(selected)).toHaveLength(1);
  });

  it("flags token drift on a selection that returns to view moved", () => {
    let selected = toggleClaimSelection(new Map(), claim(A));
    selected = reconcileClaimSelection(selected, []);
    selected = reconcileClaimSelection(selected, [claim(A, 2)]);

    expect(selected.get(A)?.stale).toBe(true);
    expect(() => selectionTargets(selected)).toThrow("Refresh stale selections");
  });

  it("preserves selection while flagging token drift", () => {
    const selected = toggleClaimSelection(new Map(), claim(A));
    const reconciled = reconcileClaimSelection(selected, [claim(A, 2)]);

    expect(reconciled.get(A)?.claim.revision).toBe(2);
    expect(reconciled.get(A)?.stale).toBe(true);
    expect(() => selectionTargets(reconciled)).toThrow("Refresh stale selections");
  });

  it("builds deduplicated targets in stable claim order", () => {
    let selected = toggleClaimSelection(new Map(), claim(B));
    selected = toggleClaimSelection(selected, claim(A));

    expect(selectionTargets(selected).map((target) => target.mutationToken.publicClaimId)).toEqual([
      A,
      B,
    ]);
  });

  it("computes and toggles visible tri-state by public claim ID", () => {
    const visible = [claim(A), claim(B)];
    let selected = new Map();
    expect(selectionState(selected, visible)).toBe("none");
    selected = toggleClaimSelection(selected, visible[0]);
    expect(selectionState(selected, visible)).toBe("some");
    selected = toggleClaimsSelection(selected, visible);
    expect(selectionState(selected, visible)).toBe("all");
    selected = toggleClaimsSelection(selected, visible);
    expect(selectionState(selected, visible)).toBe("none");
  });

  it("does not let a drifted claim block the batch once it leaves the view", () => {
    // Drift then a filter change: the entry renders no checkbox to refresh, so
    // refusing on its behalf blocks every visible selection with no way out.
    let selected = toggleClaimSelection(new Map(), claim(A));
    selected = toggleClaimSelection(selected, claim(B));
    selected = reconcileClaimSelection(selected, [claim(A, 2), claim(B)]);
    expect(selected.get(A)).toMatchObject({ stale: true, offScope: false });
    expect(() => selectionTargets(selected)).toThrow("Refresh stale selections");

    selected = reconcileClaimSelection(selected, [claim(B)]);
    expect(selected.get(A)).toMatchObject({ stale: true, offScope: true });
    expect(selectionTargets(selected).map((t) => t.mutationToken.publicClaimId)).toEqual([B]);

    // The flag is kept, not cleared, so it blocks again on return.
    selected = reconcileClaimSelection(selected, [claim(A, 2), claim(B)]);
    expect(selected.get(A)).toMatchObject({ stale: true, offScope: false });
    expect(() => selectionTargets(selected)).toThrow("Refresh stale selections");
  });

  it("refuses to select a retired claim, alone or through select-all", () => {
    // Retirement is terminal in the adapter and `bulk_archive_claims` validates
    // every target before staging any, so one retired row archives nothing.
    const active = claim(A);
    const retired = { ...claim(B), lifecycleState: "retired" as const };

    expect(isSelectableClaim(active)).toBe(true);
    expect(isSelectableClaim(retired)).toBe(false);

    expect(toggleClaimSelection(new Map(), retired).size).toBe(0);

    const all = toggleClaimsSelection(new Map(), [active, retired]);
    expect([...all.keys()]).toEqual([A]);
    // Select-all reads "all" off the selectable rows only, so it toggles off
    // rather than getting stuck because the retired row can never be selected.
    expect(selectionState(all, [active, retired])).toBe("all");
    expect(toggleClaimsSelection(all, [active, retired]).size).toBe(0);
  });

  it("reports no selectable state for a view of only retired claims", () => {
    const retired = { ...claim(A), lifecycleState: "retired" as const };
    expect(selectionState(new Map(), [retired])).toBe("none");
  });

  it("preserves draft text and reports a revision advance", () => {
    const previous = {
      publicClaimId: A,
      revisionLocator: claim(A).revisionLocator,
      mutationToken: claim(A).mutationToken,
      text: "unsaved draft",
      revisionAdvanced: false,
    };

    expect(reconcileDraft(previous, claim(A, 2))).toEqual({
      ...previous,
      revisionAdvanced: true,
    });
    expect(reconcileDraft(previous, undefined)).toEqual(previous);
  });

  it("keeps the draft pinned to the revision it was started against", () => {
    // A concurrent writer advancing the claim must not silently become the base
    // of an open draft: saving with the refreshed token would pass the adapter's
    // fence and overwrite the other revision with older text. The pinned token
    // makes that save report `stale` instead.
    const base = claim(A);
    const previous = {
      publicClaimId: A,
      revisionLocator: base.revisionLocator,
      mutationToken: base.mutationToken,
      text: "unsaved draft",
      revisionAdvanced: false,
    };

    const advanced = claim(A, 2);
    const reconciled = reconcileDraft(previous, advanced);

    expect(reconciled?.revisionAdvanced).toBe(true);
    expect(reconciled?.mutationToken).toEqual(base.mutationToken);
    expect(reconciled?.mutationToken.revision).toBe(1);
    expect(reconciled?.revisionLocator).toBe(base.revisionLocator);
    // Not the refreshed token, which is what would overwrite silently.
    expect(reconciled?.mutationToken).not.toEqual(advanced.mutationToken);
  });
});

describe("snapshotErrorFor", () => {
  it("clears the banner once a settled result supersedes a stale one", () => {
    // The stale branch set the banner and returned, so a later successful
    // refresh left it on screen indefinitely.
    expect(snapshotErrorFor({ outcome: "stale", staleReasons: ["projectGenerations"] })).toBe(
      "projectGenerations",
    );
    expect(snapshotErrorFor({ outcome: "stale", staleReasons: [] })).toBe(
      "Claim snapshot changed during refresh",
    );
    expect(snapshotErrorFor({ outcome: "ok", staleReasons: [] })).toBeNull();
    expect(snapshotErrorFor({ outcome: "ok" })).toBeNull();
  });
});
