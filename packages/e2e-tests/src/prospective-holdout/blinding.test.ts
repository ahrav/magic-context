import { describe, expect, it } from "bun:test";
import { assertNoIdentityCue, buildBlindedPacket, createConcealedMap, verifyConcealedMap } from "./blinding";

describe("subjective comparison blinding", () => {
    it("binds randomized assignments to secret material", () => {
        const secret = new TextEncoder().encode("s".repeat(32));
        const map = createConcealedMap([
            `case-${"a".repeat(32)}`,
            `case-${"b".repeat(32)}`,
        ], secret, "1".repeat(32));
        const caseIds = map.assignments.map((assignment) => assignment.caseId);
        expect(() => verifyConcealedMap(map, secret, map.commitment, caseIds)).not.toThrow();
        expect(() => verifyConcealedMap(
            map,
            new TextEncoder().encode("x".repeat(32)),
            map.commitment,
            caseIds,
        )).toThrow(/commitment-mismatch/);
        expect(() => verifyConcealedMap(map, secret, map.commitment, caseIds.slice(0, 1))).toThrow(
            /subjective-cases-mismatch/,
        );
        expect(() => verifyConcealedMap({
            ...map,
            assignments: [map.assignments[0]!, map.assignments[0]!],
        }, secret, map.commitment, caseIds)).toThrow(/duplicate-case/);
        expect(() => verifyConcealedMap({
            ...map,
            assignments: [{ ...map.assignments[0]!, buildB: map.assignments[0]!.buildA }],
        }, secret, map.commitment, [caseIds[0]!])).toThrow(/roles-not-complementary/);
    });

    it("emits only build-A/build-B bounded packets and rejects identity cues", () => {
        const caseId = `case-${"a".repeat(32)}`;
        const assignment = { caseId, buildA: "release-n" as const, buildB: "release-n-minus-1" as const };
        const packet = buildBlindedPacket({
            caseId,
            assignment,
            observations: {
                "release-n": { status: "pass", checkIds: [] },
                "release-n-minus-1": { status: "fail", checkIds: ["check-context"] },
            },
            allowedCheckIds: ["check-context"],
            secret: new TextEncoder().encode("p".repeat(32)),
        });
        expect(packet.buildA.status).toBe("pass");
        expect(() => buildBlindedPacket({
            caseId,
            assignment: { ...assignment, buildB: assignment.buildA },
            observations: {
                "release-n": { status: "pass", checkIds: [] },
                "release-n-minus-1": { status: "fail", checkIds: [] },
            },
            allowedCheckIds: [],
            secret: new TextEncoder().encode("p".repeat(32)),
        })).toThrow(/assignment-role-duplicate/);
        expect(() => buildBlindedPacket({
            caseId,
            assignment,
            observations: {
                "release-n": { status: "pass", checkIds: [] },
                "release-n-minus-1": { status: "fail", checkIds: [] },
            },
            allowedCheckIds: [],
            secret: new Uint8Array(31),
        })).toThrow(/too-short/);
        expect(() => assertNoIdentityCue({ ...packet, releasePath: "/private/build" }, ["check-context"])).toThrow(
            /identity-cue-or-schema-invalid/,
        );
    });
});
