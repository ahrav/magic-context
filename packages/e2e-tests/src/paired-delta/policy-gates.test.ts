import { describe, expect, it } from "bun:test";
import { PAIRED_DELTA_POLICY_GATES } from "./contract";

/**
 * The policy's `gates` field is validated against this list exactly, and the runner enforces each
 * gate through its own code rather than by reading the field. That leaves one drift direction the
 * parser cannot catch: a name added to the list, or to the policy document, with no mechanism
 * behind it. Naming the mechanism for each gate here makes that addition fail a test.
 */
type DeclaredGate = (typeof PAIRED_DELTA_POLICY_GATES)[number];

const ENFORCED_BY: Record<DeclaredGate, string> = {
    "all-primary-arms-completed":
        "buildAnalysis requires every PRIMARY_ARM_ID cell to be completed before a coordinate " +
        "contributes a delta, and runLive compares healthy against planned coordinates",
    "absence-precondition-held":
        "the live observation sets absencePreconditionHeld from the structural ballast condition, " +
        "and deriveRecord excludes the cell as absence-precondition-unmet when it is false",
    "arm-identity-matched":
        "configMatchesArm plus the context-database and R1 wire requirements set " +
        "armIdentityMatches, which deriveRecord turns into arm-identity-mismatch",
    "pinned-model-echo-matched":
        "the observation reports the first off-pin route from the authored responses or the " +
        "session ledger, which deriveRecord compares against the pinned provider and snapshot",
};

describe("paired-delta policy gates", () => {
    it("names the mechanism enforcing every declared gate", () => {
        expect([...PAIRED_DELTA_POLICY_GATES].sort().join(","))
            .toBe(Object.keys(ENFORCED_BY).sort().join(","));
    });

    it("keeps the declared order stable, because the parser compares position by position", () => {
        expect([...PAIRED_DELTA_POLICY_GATES].join(",")).toBe([
            "all-primary-arms-completed",
            "absence-precondition-held",
            "arm-identity-matched",
            "pinned-model-echo-matched",
        ].join(","));
    });
});
