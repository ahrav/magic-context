import { describe, expect, it } from "bun:test";
import { assertNoIdentityCue, buildBlindedPacket, createConcealedMap, verifyConcealedMap } from "./blinding";

describe("subjective comparison blinding", () => {
    it("binds randomized assignments to secret material", () => {
        const secret = new TextEncoder().encode("s".repeat(32));
        const map = createConcealedMap([
            `case-${"a".repeat(32)}`,
            `case-${"b".repeat(32)}`,
        ], secret, "1".repeat(32));
        expect(() => verifyConcealedMap(map, secret, map.commitment)).not.toThrow();
        expect(() => verifyConcealedMap(
            map,
            new TextEncoder().encode("x".repeat(32)),
            map.commitment,
        )).toThrow(/commitment-mismatch/);
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
        });
        expect(packet.buildA.status).toBe("pass");
        expect(() => assertNoIdentityCue({ ...packet, releasePath: "/private/build" }, ["check-context"])).toThrow(
            /identity-cue-or-schema-invalid/,
        );
    });
});
