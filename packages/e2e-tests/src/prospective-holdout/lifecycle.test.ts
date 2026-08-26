import { describe, expect, it } from "bun:test";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { appendLifecycleEvent, invalidateLifecycle, validateLifecycle } from "./lifecycle";
import { H1, H2 } from "./test-fixtures";

describe("prospective lifecycle", () => {
    it("accepts legal append-only transitions and a trusted prefix", () => {
        const frozen = appendLifecycleEvent([], {
            epochId: "epoch-test-release",
            state: "frozen",
            occurredAt: "2026-09-01T00:00:00Z",
            artifactFingerprint: H1,
            reasonCode: null,
            approvers: ["reviewer-one"],
        });
        const open = appendLifecycleEvent(frozen, {
            epochId: "epoch-test-release",
            state: "intake-open",
            occurredAt: "2026-09-01T00:00:01Z",
            artifactFingerprint: null,
            reasonCode: null,
            approvers: ["operator-one"],
        });
        const validated = validateLifecycle(open, { trustedPrefix: frozen });
        expect(validated.state).toBe("intake-open");
        expect(open[1]!.previousEventFingerprint).toBe(canonicalFingerprint(open[0]));
    });

    it("rejects illegal transitions and preserves invalidated evidence", () => {
        const frozen = appendLifecycleEvent([], {
            epochId: "epoch-test-release",
            state: "frozen",
            occurredAt: "2026-09-01T00:00:00Z",
            artifactFingerprint: H1,
            reasonCode: null,
            approvers: ["reviewer-one"],
        });
        expect(() => appendLifecycleEvent(frozen, {
            epochId: "epoch-test-release",
            state: "reported",
            occurredAt: "2026-09-01T00:00:01Z",
            artifactFingerprint: H2,
            reasonCode: null,
            approvers: ["reviewer-one"],
        })).toThrow(/illegal-transition/);
        const invalidated = invalidateLifecycle(frozen, {
            occurredAt: "2026-09-01T00:00:01Z",
            reasonCode: "policy-drift",
            approvers: ["reviewer-one"],
        });
        expect(invalidated[0]).toEqual(frozen[0]);
        expect(invalidated.at(-1)?.state).toBe("invalidated");
    });
});
