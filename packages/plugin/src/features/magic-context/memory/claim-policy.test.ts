
import { describe, expect, test } from "bun:test";
import {
    automaticLadderSteps,
    automaticMaturityTarget,
    classifyFineTaint,
    kindIsDirectiveStrength,
    taintMayOriginateDirective,
} from "./claim-policy";

describe("fine taint classifier", () => {
    test("explicit user maps to USER_EXPLICIT unless declared user-inferred", () => {
        expect(classifyFineTaint({ sourceTrustClass: "explicit_user" })).toBe("USER_EXPLICIT");
        expect(classifyFineTaint({ sourceTrustClass: "explicit_user", userInferred: true })).toBe(
            "USER_INFERRED",
        );
    });

    test("locally trusted channels stay untrusted without host-validated evidence", () => {
        expect(classifyFineTaint({ sourceTrustClass: "trusted_local_code" })).toBe(
            "REPO_UNTRUSTED_TEXT",
        );
        expect(classifyFineTaint({ sourceTrustClass: "trusted_tool_result" })).toBe(
            "TOOL_UNTRUSTED_OUTPUT",
        );
        expect(
            classifyFineTaint({
                sourceTrustClass: "trusted_local_code",
                hostValidatedArtifact: "code",
            }),
        ).toBe("CURRENT_CODE");
        expect(
            classifyFineTaint({
                sourceTrustClass: "trusted_local_code",
                hostValidatedArtifact: "test",
            }),
        ).toBe("CURRENT_TEST");
        expect(
            classifyFineTaint({
                sourceTrustClass: "trusted_tool_result",
                hostValidatedArtifact: "config",
            }),
        ).toBe("CURRENT_CONFIG");
    });

    test("web, repo, and model channels fall to conservative classes", () => {
        expect(classifyFineTaint({ sourceTrustClass: "untrusted_repo_text" })).toBe(
            "REPO_UNTRUSTED_TEXT",
        );
        expect(classifyFineTaint({ sourceTrustClass: "untrusted_web" })).toBe(
            "TOOL_UNTRUSTED_OUTPUT",
        );
        expect(classifyFineTaint({ sourceTrustClass: "model_inference" })).toBe(
            "ASSISTANT_INFERENCE",
        );
        expect(
            classifyFineTaint({ sourceTrustClass: "model_inference", extractor: "dreamer-task" }),
        ).toBe("DREAMER_INFERENCE");
    });
});

describe("maturity transition predicates", () => {
    test("repository and tool taints cannot originate a directive-strength claim", () => {
        expect(taintMayOriginateDirective("REPO_UNTRUSTED_TEXT")).toBeFalse();
        expect(taintMayOriginateDirective("TOOL_UNTRUSTED_OUTPUT")).toBeFalse();
        for (const taint of [
            "USER_EXPLICIT",
            "USER_INFERRED",
            "ASSISTANT_INFERENCE",
            "DREAMER_INFERENCE",
            "CURRENT_CODE",
            "CURRENT_TEST",
            "CURRENT_CONFIG",
        ] as const) {
            expect(taintMayOriginateDirective(taint)).toBeTrue();
        }
        expect(kindIsDirectiveStrength("unknown")).toBeTrue();
        expect(kindIsDirectiveStrength("directive")).toBeTrue();
        expect(kindIsDirectiveStrength("descriptive")).toBeFalse();
    });

    test("a directive-strength claim with untrusted origin stays CANDIDATE despite support", () => {
        expect(
            automaticMaturityTarget({
                kind: "unknown",
                originTaint: "REPO_UNTRUSTED_TEXT",
                independentGroups: 3,
                verified: true,
                explicitUserEvidence: false,
            }),
        ).toBe("CANDIDATE");
        // Explicit-user evidence unlocks the automatic ladder.
        expect(
            automaticMaturityTarget({
                kind: "unknown",
                originTaint: "REPO_UNTRUSTED_TEXT",
                independentGroups: 3,
                verified: true,
                explicitUserEvidence: true,
            }),
        ).toBe("VERIFIED");
    });

    test("a descriptive claim promotes by evidence and stops at the automatic ceiling", () => {
        const base = {
            kind: "descriptive" as const,
            originTaint: "ASSISTANT_INFERENCE" as const,
            explicitUserEvidence: false,
        };
        expect(automaticMaturityTarget({ ...base, independentGroups: 1, verified: false })).toBe(
            "CANDIDATE",
        );
        expect(automaticMaturityTarget({ ...base, independentGroups: 2, verified: false })).toBe(
            "CORROBORATED",
        );
        expect(automaticMaturityTarget({ ...base, independentGroups: 2, verified: true })).toBe(
            "VERIFIED",
        );
    });

    test("ladder steps append only supported rungs and never exceed VERIFIED", () => {
        const verifiedNoGroups = {
            kind: "descriptive" as const,
            originTaint: "USER_EXPLICIT" as const,
            independentGroups: 1,
            verified: true,
            explicitUserEvidence: true,
        };
        expect(automaticLadderSteps(null, verifiedNoGroups)).toEqual(["CANDIDATE", "VERIFIED"]);
        expect(automaticLadderSteps("CANDIDATE", verifiedNoGroups)).toEqual(["VERIFIED"]);
        expect(automaticLadderSteps("VERIFIED", verifiedNoGroups)).toEqual([]);
        const corroborated = { ...verifiedNoGroups, independentGroups: 2 };
        expect(automaticLadderSteps(null, corroborated)).toEqual([
            "CANDIDATE",
            "CORROBORATED",
            "VERIFIED",
        ]);
    });
});
