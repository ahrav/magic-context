import { describe, expect, it } from "bun:test";
import type { ClaimMemory } from "../../lib/types";
import {
  reconcileClaimSelection,
  reconcileDraft,
  selectionState,
  selectionTargets,
  toggleClaimsSelection,
  toggleClaimSelection,
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
  it("preserves missing selections and flags them stale", () => {
    let selected = toggleClaimSelection(new Map(), claim(A));
    selected = toggleClaimSelection(selected, claim(B));

    const reconciled = reconcileClaimSelection(selected, [claim(A)]);

    expect([...reconciled.keys()]).toEqual([A, B]);
    expect(reconciled.get(A)?.stale).toBe(false);
    expect(reconciled.get(B)?.stale).toBe(true);
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

  it("preserves draft text and reports a revision advance", () => {
    const previous = {
      publicClaimId: A,
      revisionLocator: claim(A).revisionLocator,
      text: "unsaved draft",
      revisionAdvanced: false,
    };

    expect(reconcileDraft(previous, claim(A, 2))).toEqual({
      ...previous,
      revisionAdvanced: true,
    });
    expect(reconcileDraft(previous, undefined)).toEqual(previous);
  });
});
