import { describe, expect, it } from "bun:test";

import type { ClaimMutationToken } from "../memory/claim-operation-contract";
import {
    buildVerifyPrompt,
    parseVerifyManifest,
    VERIFY_SYSTEM_PROMPT,
    validateVerifyManifest,
} from "./verify-prompt";

const A = `mcm_${"a".repeat(32)}`;
const B = `mcm_${"b".repeat(32)}`;
const C = `mcm_${"c".repeat(32)}`;

function token(): ClaimMutationToken {
    return {
        tokenVersion: 1,
        publicClaimId: A,
        revision: 1,
        contentDigest: "1".repeat(64),
        lifecycleSeq: 1,
        applicabilityHeadsDigest: "2".repeat(64),
        policyHeadsDigest: "3".repeat(64),
    };
}

describe("verify manifest", () => {
    it("parses claim-bound verified, update, and archive entries", () => {
        const parsed = parseVerifyManifest(
            `<verify><verified claim="${A}" files="a.ts,b.ts"/><update claim="${B}" files="b.ts">New fact</update><archive claim="${C}" reason="removed"/></verify>`,
        );
        expect(parsed).toEqual({
            verified: [{ publicClaimId: A, files: ["a.ts", "b.ts"] }],
            updated: [{ publicClaimId: B, files: ["b.ts"], content: "New fact" }],
            archived: [{ publicClaimId: C, reason: "removed" }],
        });
    });

    it("rejects missing files, duplicates, truncation, and coverage mismatch", () => {
        expect(() => parseVerifyManifest(`<verify><verified claim="${A}"/></verify>`)).toThrow(
            /missing backing files/,
        );
        expect(() =>
            parseVerifyManifest(
                `<verify><verified claim="${A}" files="a.ts"/><archive claim="${A}" reason="r"/></verify>`,
            ),
        ).toThrow(/duplicate id/);
        expect(() => parseVerifyManifest(`<verify><archive claim="${A}" reason="r"/>`)).toThrow(
            /closing root/,
        );
        expect(() =>
            validateVerifyManifest(
                `<verify><verified claim="${A}" files="a.ts"/></verify>`,
                new Set([A, B]),
            ),
        ).toThrow(/missing id/);
    });

    it("allows file-independent anti-memory outcomes only when selected as such", () => {
        const text = `<verify><verified claim="${A}" files=""/></verify>`;
        expect(() => validateVerifyManifest(text, new Set([A]))).toThrow(/missing backing files/);
        expect(validateVerifyManifest(text, new Set([A]), new Set([A])).verified).toEqual([
            { publicClaimId: A, files: [] },
        ]);
    });
});

describe("verify prompt", () => {
    it("renders exact public locator, digest, and backing files", () => {
        const contentDigest = "1".repeat(64);
        const prompt = buildVerifyPrompt("git:abc", [
            {
                publicClaimId: A,
                revisionLocator: `${A}/r1/${contentDigest}`,
                contentDigest,
                mutationToken: token(),
                category: "ARCHITECTURE",
                content: "Fact",
                mappedFiles: ["a.ts", "b.ts"],
            },
        ]);
        expect(prompt).toContain(`[${A}] ARCHITECTURE`);
        expect(prompt).toContain(`Revision: ${A}/r1/${contentDigest}`);
        expect(prompt).toContain(`Content digest: ${contentDigest}`);
        expect(prompt).toContain("Backing files: a.ts, b.ts");
    });

    it("labels file-independent anti-memories and explains archive-to-stale semantics", () => {
        const prompt = buildVerifyPrompt("git:abc", [
            {
                publicClaimId: A,
                revisionLocator: `${A}/r1/${"1".repeat(64)}`,
                contentDigest: "1".repeat(64),
                mutationToken: token(),
                category: "REJECTED_APPROACH",
                content: "Rejected strategy: Redis",
                mappedFiles: [],
            },
        ]);
        expect(prompt).toContain("Backing files: (none; inspect current project evidence)");
        expect(VERIFY_SYSTEM_PROMPT).toContain("anti-memory");
        expect(VERIFY_SYSTEM_PROMPT).toContain("ARCHIVE");
        expect(VERIFY_SYSTEM_PROMPT).toContain("stale");
        expect(VERIFY_SYSTEM_PROMPT).toContain(
            "Use ARCHIVE when the rejection no longer clearly holds; the host preserves it as labeled stale history rather than deleting it.",
        );
    });
});
