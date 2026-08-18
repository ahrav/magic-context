import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalFingerprint } from "./canonical-json";
import { ContractError } from "./contract";
import { loadReviewedRelease } from "./index";
import { buildReleaseTuple, promoteRelease } from "./promote";
import { makeValidRelease } from "./test-support";

function approvalsFor(artifacts: {
    corpus: unknown;
    judgments: unknown;
    syntheticProfiles: unknown;
}) {
    const fingerprint = canonicalFingerprint(buildReleaseTuple(artifacts));
    return [
        { kind: "privacy", approver: "op-privacy", releaseTupleFingerprint: fingerprint },
        {
            kind: "relevance-intent",
            approver: "op-relevance",
            releaseTupleFingerprint: fingerprint,
        },
    ];
}

function releasesRoot(): string {
    return mkdtempSync(join(tmpdir(), "promote-test-"));
}

function promotableInput(root: string) {
    const { corpus, judgments, syntheticProfiles } = makeValidRelease();
    const artifacts = { corpus, judgments, syntheticProfiles };
    return {
        ...artifacts,
        approvals: approvalsFor(artifacts),
        releasesRoot: root,
        releaseVersion: "v1",
    };
}

describe("promoteRelease", () => {
    it("installs a loadable immutable release directory", () => {
        const root = releasesRoot();
        const { releaseDir } = promoteRelease(promotableInput(root));
        expect(releaseDir).toBe(join(root, "v1"));
        const release = loadReviewedRelease(releaseDir);
        expect(release.manifest.releaseVersion).toBe("v1");
        expect(readdirSync(root)).toEqual(["v1"]);
    });

    it("rejects a single approval, duplicate kinds, and promoter-shaped approvals", () => {
        const root = releasesRoot();
        const input = promotableInput(root);
        expect(() =>
            promoteRelease({ ...input, approvals: input.approvals.slice(0, 1) }),
        ).toThrow(ContractError);
        expect(() =>
            promoteRelease({
                ...input,
                approvals: [input.approvals[0], { ...input.approvals[0] }],
            }),
        ).toThrow(ContractError);
        expect(() =>
            promoteRelease({
                ...input,
                approvals: input.approvals.map((approval) => ({
                    ...approval,
                    releaseTupleFingerprint: canonicalFingerprint({ minted: true }),
                })),
            }),
        ).toThrow(ContractError);
        expect(readdirSync(root)).toEqual([]);
    });

    it("rejects approvals bound to different content or policy versions", () => {
        const root = releasesRoot();
        const input = promotableInput(root);
        const edited = JSON.parse(JSON.stringify(input.corpus));
        edited.queries[0].queryText = "edited after approval";
        expect(() => promoteRelease({ ...input, corpus: edited })).toThrow(ContractError);
        expect(readdirSync(root)).toEqual([]);
    });

    it("rejects free-form approval metadata", () => {
        const root = releasesRoot();
        const input = promotableInput(root);
        expect(() =>
            promoteRelease({
                ...input,
                approvals: input.approvals.map((approval) => ({ ...approval, note: "lgtm" })),
            }),
        ).toThrow(ContractError);
    });

    it("rejects a mixed artifact set with stale approvals", () => {
        const root = releasesRoot();
        const input = promotableInput(root);
        const other = makeValidRelease();
        const otherJudgments = JSON.parse(JSON.stringify(other.judgments));
        otherJudgments.judgments[0].provenance.pooledFrom = ["shadow"];
        expect(() => promoteRelease({ ...input, judgments: otherJudgments })).toThrow(
            ContractError,
        );
        expect(readdirSync(root)).toEqual([]);
    });

    it("preserves the prior release byte-identically on failure and interruption", () => {
        const root = releasesRoot();
        const { releaseDir } = promoteRelease(promotableInput(root));
        // The tampered marker detects a promoter that replaces an existing
        // release instead of rejecting it.
        const tamperPath = join(releaseDir, "corpus.json");
        const tampered = `${readFileSync(tamperPath, "utf8")}\n`;
        writeFileSync(tamperPath, tampered);
        const before = new Map(
            readdirSync(releaseDir).map((name) => [
                name,
                readFileSync(join(releaseDir, name), "utf8"),
            ]),
        );

        expect(() => promoteRelease(promotableInput(root))).toThrow(ContractError);

        for (const [name, content] of before) {
            expect(readFileSync(join(releaseDir, name), "utf8")).toBe(content);
        }
        expect(readFileSync(tamperPath, "utf8")).toBe(tampered);
        expect(readdirSync(root)).toEqual(["v1"]);
    });

    it("fails closed on artifacts that do not validate", () => {
        const root = releasesRoot();
        const input = promotableInput(root);
        const badJudgments = JSON.parse(JSON.stringify(input.judgments));
        badJudgments.judgments[0].grade = 3;
        expect(() => promoteRelease({ ...input, judgments: badJudgments })).toThrow(
            ContractError,
        );
        expect(readdirSync(root)).toEqual([]);
    });
});
