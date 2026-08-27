import { describe, expect, it } from "bun:test";

import {
    buildClassifyPrompt,
    parseClassifyManifest,
    validateClassifyManifest,
} from "./classify-prompt";

const A = `mcm_${"a".repeat(32)}`;
const B = `mcm_${"b".repeat(32)}`;

function promptMemory(publicClaimId = A) {
    const contentDigest = "1".repeat(64);
    return {
        publicClaimId,
        revisionLocator: `${publicClaimId}/r1/${contentDigest}`,
        contentDigest,
        category: "ARCHITECTURE",
        content: "Claim content",
        importance: 50,
        scope: "project" as const,
        shareable: false,
    };
}

describe("classify manifest", () => {
    it("parses public claim ids and classification fields", () => {
        expect(
            parseClassifyManifest(
                `<classify><memory claim="${A}" importance="75" scope="project" shareable="true"/><memory claim="${B}" importance="200" scope="universe" shareable="false"/></classify>`,
            ),
        ).toEqual([
            { publicClaimId: A, importance: 75, scope: "project", shareable: true },
            { publicClaimId: B, importance: 100, scope: "universe", shareable: false },
        ]);
    });

    it("rejects malformed, duplicate, missing, and extra public claim ids", () => {
        expect(() =>
            parseClassifyManifest(`<classify><memory importance="50"/></classify>`),
        ).toThrow(/public claim id/);
        expect(() =>
            parseClassifyManifest(
                `<classify><memory claim="${A}" importance="50"/><memory claim="${A}" shareable="true"/></classify>`,
            ),
        ).toThrow(/duplicate id/);
        expect(() =>
            validateClassifyManifest(
                `<classify><memory claim="${A}" importance="50"/></classify>`,
                new Set([A, B]),
            ),
        ).toThrow(/missing id/);
        expect(() =>
            validateClassifyManifest(
                `<classify><memory claim="${A}" importance="50"/><memory claim="${B}" importance="20"/></classify>`,
                new Set([A]),
            ),
        ).toThrow(/unknown id/);
        expect(() =>
            parseClassifyManifest(`<classify><memory claim="${A}" importance="50"/>`),
        ).toThrow(/closing root/);
    });
});

describe("buildClassifyPrompt", () => {
    it("renders public locator and digest while keeping anchors out of output coverage", () => {
        const prompt = buildClassifyPrompt({
            projectPath: "git:abc",
            memories: [promptMemory()],
            anchors: [
                { publicClaimId: B, category: "CONSTRAINTS", content: "Anchor", importance: 80 },
            ],
        });
        expect(prompt).toContain(`[${A}] ARCHITECTURE`);
        expect(prompt).toContain(promptMemory().revisionLocator);
        expect(prompt).toContain(promptMemory().contentDigest);
        expect(prompt).toContain(`[${B}] CONSTRAINTS importance=80`);
        expect(prompt).toContain("do NOT re-score them");
    });
});
