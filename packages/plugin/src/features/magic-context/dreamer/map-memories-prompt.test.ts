import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ClaimMutationToken } from "../memory/claim-operation-contract";
import {
    buildMapMemoriesPrompt,
    extractMemoryCandidatePaths,
    parseMapMemoriesManifest,
    validateMapMemoriesManifest,
} from "./map-memories-prompt";

const A = `mcm_${"a".repeat(32)}`;
const B = `mcm_${"b".repeat(32)}`;

function token(publicClaimId: string): ClaimMutationToken {
    return {
        tokenVersion: 1,
        publicClaimId,
        revision: 1,
        contentDigest: "1".repeat(64),
        lifecycleSeq: 1,
        applicabilityHeadsDigest: "2".repeat(64),
        policyHeadsDigest: "3".repeat(64),
    };
}

describe("map manifest", () => {
    it("parses public claim ids, files, independent sentinels, and nested files", () => {
        expect(
            parseMapMemoriesManifest(
                `<mappings><memory claim="${A}" files="a/b.ts,c/d.ts"/><memory claim="${B}" independent="true"/></mappings>`,
            ),
        ).toEqual([
            { publicClaimId: A, files: ["a/b.ts", "c/d.ts"], independent: false },
            { publicClaimId: B, files: [], independent: true },
        ]);
        expect(
            parseMapMemoriesManifest(
                `<mappings><memory claim="${A}"><file path="src/a.ts"/></memory></mappings>`,
            ),
        ).toEqual([{ publicClaimId: A, files: ["src/a.ts"], independent: false }]);
    });

    it("rejects malformed, duplicate, missing, and extra entries", () => {
        expect(() =>
            parseMapMemoriesManifest(`<mappings><memory claim="${A}"/></mappings>`),
        ).toThrow(/neither files nor independent/);
        expect(() =>
            parseMapMemoriesManifest(
                `<mappings><memory claim="${A}" files="a.ts"/><memory claim="${A}" independent="true"/></mappings>`,
            ),
        ).toThrow(/duplicate id/);
        expect(() =>
            validateMapMemoriesManifest(
                `<mappings><memory claim="${A}" files="a.ts"/></mappings>`,
                new Set([A, B]),
            ),
        ).toThrow(/missing id/);
        expect(() =>
            validateMapMemoriesManifest(
                `<mappings><memory claim="${A}" files="a.ts"/><memory claim="${B}" independent="true"/></mappings>`,
                new Set([A]),
            ),
        ).toThrow(/unknown id/);
    });
});

describe("map prompt", () => {
    it("renders exact claim snapshot and candidate paths", () => {
        const contentDigest = "1".repeat(64);
        const prompt = buildMapMemoriesPrompt("git:abc", [
            {
                publicClaimId: A,
                revisionLocator: `${A}/r1/${contentDigest}`,
                contentDigest,
                mutationToken: token(A),
                category: "ARCHITECTURE",
                content: "Fact in src/fact.ts",
                candidates: ["src/fact.ts"],
            },
        ]);
        expect(prompt).toContain(`[${A}] ARCHITECTURE`);
        expect(prompt).toContain(`${A}/r1/${contentDigest}`);
        expect(prompt).toContain(`digest=${contentDigest}`);
        expect(prompt).toContain(
            "Likely files (named in the memory, confirmed to exist): src/fact.ts",
        );
    });

    it("extracts only existing in-repository paths on every call", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "mc-map-prompt-"));
        try {
            mkdirSync(path.join(dir, "pkg"));
            writeFileSync(path.join(dir, "pkg", "file.ts"), "x");
            expect(extractMemoryCandidatePaths("pkg/file.ts and missing/ghost.ts", dir)).toEqual([
                "pkg/file.ts",
            ]);
            expect(extractMemoryCandidatePaths("pkg/file.ts", dir)).toEqual(["pkg/file.ts"]);
            expect(extractMemoryCandidatePaths("../escape/file.ts", dir)).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
