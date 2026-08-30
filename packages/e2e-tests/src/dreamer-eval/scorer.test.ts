import { describe, expect, test } from "bun:test";
import { sep } from "node:path";

import {
    DREAMER_EVAL_POOL_SCHEMA,
    DREAMER_EVAL_REPORT_SCHEMA,
    dreamerEvalExitCode,
    type ClassifyGoldClaim,
    type MapGoldClaim,
    type PoolDescriptor,
    type VerifyGoldClaim,
} from "./contract";
import { VERIFY_UPDATE_CONTENT_MAX_LENGTH } from "../../../plugin/src/features/magic-context/dreamer/verify";
import {
    scoreClassifyManifest,
    scoreMapManifest,
    scoreVerifyManifest,
    type ManifestScore,
} from "./scorer";

const pool: PoolDescriptor = {
    schema: DREAMER_EVAL_POOL_SCHEMA,
    scenarioId: "dme-core",
    claims: [
        {
            claimId: "claim-true",
            publicClaimId: "mcm_true",
            revisionLocator: "mcm_true@1",
            content: "The cache limit is 4096 entries.",
            category: "PROJECT_FACT",
            importance: 70,
            memoryScope: "project",
            sharing: "shareable",
            lifecycleState: "active",
            files: ["src/cache.ts", "src/config.ts"],
            verificationOutcome: null,
        },
        {
            claimId: "claim-update",
            publicClaimId: "mcm_update",
            revisionLocator: "mcm_update@1",
            content: "The cache limit is 2048 entries.",
            category: "PROJECT_FACT",
            importance: 50,
            memoryScope: "project",
            sharing: "private",
            lifecycleState: "active",
            files: ["src/cache.ts"],
            verificationOutcome: null,
        },
        {
            claimId: "claim-false",
            publicClaimId: "mcm_false",
            revisionLocator: "mcm_false@1",
            content: "The removed queue still exists.",
            category: "PROJECT_FACT",
            importance: 20,
            memoryScope: "project",
            sharing: "private",
            lifecycleState: "active",
            files: ["src/queue.ts"],
            verificationOutcome: null,
        },
        {
            claimId: "claim-independent",
            publicClaimId: "mcm_independent",
            revisionLocator: "mcm_independent@1",
            content: "Provider requests use TLS.",
            category: "PROJECT_CONSTRAINT",
            importance: 85,
            memoryScope: "universe",
            sharing: "shareable",
            lifecycleState: "active",
            files: [],
            verificationOutcome: null,
        },
    ],
};

// Every path the fixture repository tracks. The scorers resolve an observed
// mapping path against this the way production resolves it against `git ls-files`.
const tracked = [...new Set(pool.claims.flatMap((claim) => claim.files))];

const verifyGold = { kind: "verify" as const, claims: [
    {
        claimId: "claim-true",
        verdict: "verified",
        expectedFiles: ["src/cache.ts", "src/config.ts"],
        requiredUpdateAnchors: [],
        forbiddenUpdateAnchors: [],
    },
    {
        claimId: "claim-update",
        verdict: "update",
        expectedFiles: ["src/cache.ts"],
        requiredUpdateAnchors: ["4096 entries", "bounded cache"],
        forbiddenUpdateAnchors: ["2048 entries"],
    },
    {
        claimId: "claim-false",
        verdict: "archive",
        expectedFiles: [],
        requiredUpdateAnchors: [],
        forbiddenUpdateAnchors: [],
    },
] satisfies VerifyGoldClaim[] };

const mapGold = { kind: "map" as const, claims: [
    { claimId: "claim-true", files: ["src/cache.ts", "src/config.ts"], independent: false },
    { claimId: "claim-independent", files: [], independent: true },
] satisfies MapGoldClaim[] };

const classifyGold = { kind: "classify" as const, claims: [
    { claimId: "claim-true", importance: { min: 65, max: 75 }, scope: "project", shareable: true },
    { claimId: "claim-independent", importance: { min: 80, max: 90 }, scope: "universe", shareable: true },
] satisfies ClassifyGoldClaim[] };

const correctVerify = `<verify>
<verified claim="mcm_true" files="src/cache.ts,src/config.ts"/>
<update claim="mcm_update" files="src/cache.ts">Uses a BOUNDED CACHE with 4096 ENTRIES.</update>
<archive claim="mcm_false" reason="queue removed"/>
</verify>`;

const correctMap = `<mappings>
<memory claim="mcm_true" files="src/cache.ts,src/config.ts"/>
<memory claim="mcm_independent" independent="true"/>
</mappings>`;

const correctClassify = `<classify>
<memory claim="mcm_true" importance="70" scope="project" shareable="true"/>
<memory claim="mcm_independent" importance="85" scope="universe" shareable="true"/>
</classify>`;

export function exitCodeForScore(result: ManifestScore): 0 | 1 | 2 {
    return dreamerEvalExitCode({
        schema: DREAMER_EVAL_REPORT_SCHEMA,
        scenarioId: pool.scenarioId,
        task: "verify",
        runId: "run-test",
        nowMs: 1,
        status: result.status,
        reason: result.reason,
        runFatal: result.runFatal,
        system: {
            repoCommitSha: "0".repeat(40),
            bunVersion: "test",
            opencodeVersion: "test",
            modelId: "test/model",
            parserImpl: "ts",
            pluginEntry: "src",
            runtimeDigest: "d".repeat(64),
        },
        trackedFiles: [],
        poolBefore: [],
        poolAfter: [],
        rawManifest: null,
        parsedManifest: null,
        receiptOutcomes: [],
    });
}

describe("dreamer manifest scorers", () => {
    test("correct verify, map, and classify manifests pass", () => {
        expect(scoreVerifyManifest(correctVerify, pool, verifyGold, tracked)).toMatchObject({ stage: "scored", status: "PASS" });
        expect(scoreMapManifest(correctMap, pool, mapGold, tracked)).toMatchObject({ stage: "scored", status: "PASS" });
        expect(scoreClassifyManifest(correctClassify, pool, classifyGold)).toMatchObject({ stage: "scored", status: "PASS" });
    });

    test("a case variant of a tracked path scores as the tracked path", () => {
        // gitTrackedPath falls back to a case-insensitive match and
        // normalizeVerificationFiles stores the tracked spelling, so production
        // applies exactly the gold mapping for this manifest.
        expect(
            scoreMapManifest(
                correctMap.replace('files="src/cache.ts,src/config.ts"', 'files="SRC/CACHE.ts,src/config.ts"'),
                pool,
                mapGold, tracked,
            ),
        ).toMatchObject({ stage: "scored", status: "PASS" });
        expect(
            scoreVerifyManifest(
                correctVerify.replace('<verified claim="mcm_true" files="src/cache.ts,src/config.ts"/>', '<verified claim="mcm_true" files="SRC/CACHE.ts,src/config.ts"/>'),
                pool,
                verifyGold, tracked,
            ),
        ).toMatchObject({ stage: "scored", status: "PASS" });
    });

    test("an untracked extra path is dropped, a tracked one is not", () => {
        // normalizeVerificationFiles skips a path it cannot bind to a tracked
        // file, so the applied mapping is exactly gold and the run passes.
        expect(
            scoreMapManifest(
                correctMap.replace('files="src/cache.ts,src/config.ts"', 'files="src/cache.ts,src/config.ts,docs/notes.md"'),
                pool,
                mapGold,
                tracked,
            ),
        ).toMatchObject({ stage: "scored", status: "PASS" });
        // A tracked extra IS applied, so the mapping really differs from gold.
        expect(
            scoreMapManifest(
                correctMap.replace('files="src/cache.ts,src/config.ts"', 'files="src/cache.ts,src/config.ts,src/queue.ts"'),
                pool,
                mapGold,
                tracked,
            ),
        ).toMatchObject({ stage: "scored", status: "FAIL", reason: "wrong-mapping" });
    });

    test("a case variant matching no tracked path still fails", () => {
        expect(
            scoreMapManifest(
                correctMap.replace('files="src/cache.ts,src/config.ts"', 'files="SRC/MISSING.ts,src/config.ts"'),
                pool,
                mapGold, tracked,
            ),
        ).toMatchObject({ stage: "scored", status: "FAIL", reason: "wrong-mapping" });
    });

    test("wrong archival of a gold-true claim is run-fatal", () => {
        const result = scoreVerifyManifest(
            correctVerify.replace('<verified claim="mcm_true" files="src/cache.ts,src/config.ts"/>', '<archive claim="mcm_true" reason="wrong"/>'),
            pool,
            verifyGold, tracked,
        );
        expect(result).toMatchObject({ stage: "scored", status: "FAIL", reason: "wrong-archival", runFatal: true });
        expect(exitCodeForScore(result)).toBe(2);
    });

    test("missed archival and wrong verify verdict remain ordinary failures", () => {
        expect(
            scoreVerifyManifest(
                correctVerify.replace('<archive claim="mcm_false" reason="queue removed"/>', '<verified claim="mcm_false" files="src/queue.ts"/>'),
                pool,
                verifyGold, tracked,
            ),
        ).toMatchObject({ status: "FAIL", reason: "missed-archival", runFatal: false });
        expect(
            scoreVerifyManifest(
                correctVerify.replace('<verified claim="mcm_true" files="src/cache.ts,src/config.ts"/>', '<update claim="mcm_true" files="src/cache.ts,src/config.ts">still true</update>'),
                pool,
                verifyGold, tracked,
            ),
        ).toMatchObject({ status: "FAIL", reason: "wrong-verdict", runFatal: false });
    });

    test("missed archival outranks a wrong verdict regardless of gold order", () => {
        const manifest = correctVerify
            .replace('<archive claim="mcm_false" reason="queue removed"/>', '<verified claim="mcm_false" files="src/queue.ts"/>')
            .replace('<update claim="mcm_update" files="src/cache.ts">Uses a BOUNDED CACHE with 4096 ENTRIES.</update>', '<verified claim="mcm_update" files="src/cache.ts"/>');
        const reordered = {
            kind: "verify" as const,
            claims: [...verifyGold.claims].reverse() satisfies VerifyGoldClaim[],
        };
        expect(scoreVerifyManifest(manifest, pool, verifyGold, tracked)).toMatchObject({ reason: "missed-archival" });
        expect(scoreVerifyManifest(manifest, pool, reordered, tracked)).toMatchObject({ reason: "missed-archival" });
    });

    test("a narrowed backing set on a retained claim is a wrong mapping", () => {
        expect(
            scoreVerifyManifest(
                correctVerify.replace('<verified claim="mcm_true" files="src/cache.ts,src/config.ts"/>', '<verified claim="mcm_true" files="src/cache.ts"/>'),
                pool,
                verifyGold, tracked,
            ),
        ).toMatchObject({ stage: "scored", status: "FAIL", reason: "wrong-mapping", runFatal: false });
        expect(
            scoreVerifyManifest(
                correctVerify.replace('<update claim="mcm_update" files="src/cache.ts">', '<update claim="mcm_update" files="src/other.ts">'),
                pool,
                verifyGold, tracked,
            ),
        ).toMatchObject({ status: "FAIL", reason: "wrong-mapping" });
    });

    test("update anchors are case-insensitive and reject missing or stale content", () => {
        expect(
            scoreVerifyManifest(correctVerify.replace("4096 ENTRIES", "8192 entries"), pool, verifyGold, tracked),
        ).toMatchObject({ status: "FAIL", reason: "wrong-update-content" });
        expect(
            scoreVerifyManifest(correctVerify.replace("4096 ENTRIES.", "4096 entries; formerly 2048 entries."), pool, verifyGold, tracked),
        ).toMatchObject({ status: "FAIL", reason: "wrong-update-content" });
    });

    test("an update body production would refuse never scores PASS", () => {
        // With no required anchor to miss, only the production content bound
        // separates a scoreable update from one applyVerifyManifest rejects
        // outright, which would report a successful experiment for output the
        // host would have thrown away.
        const gold = {
            kind: "verify" as const,
            claims: verifyGold.claims.map((claim) =>
                claim.claimId === "claim-update"
                    ? { ...claim, requiredUpdateAnchors: [], forbiddenUpdateAnchors: [] }
                    : claim,
            ) satisfies VerifyGoldClaim[],
        };
        const updateEntry = '<update claim="mcm_update" files="src/cache.ts">Uses a BOUNDED CACHE with 4096 ENTRIES.</update>';
        expect(scoreVerifyManifest(correctVerify, pool, gold, tracked)).toMatchObject({ stage: "scored", status: "PASS" });
        for (const body of ["", "   \n  ", "x".repeat(VERIFY_UPDATE_CONTENT_MAX_LENGTH + 1)]) {
            expect(
                scoreVerifyManifest(
                    correctVerify.replace(updateEntry, `<update claim="mcm_update" files="src/cache.ts">${body}</update>`),
                    pool,
                    gold, tracked,
                ),
            ).toMatchObject({ stage: "scored", status: "FAIL", reason: "wrong-update-content" });
        }
        expect(
            scoreVerifyManifest(
                correctVerify.replace(
                    updateEntry,
                    `<update claim="mcm_update" files="src/cache.ts">${"x".repeat(VERIFY_UPDATE_CONTENT_MAX_LENGTH)}</update>`,
                ),
                pool,
                gold, tracked,
            ),
        ).toMatchObject({ stage: "scored", status: "PASS" });
    });

    test("mapping compares file sets and independence separately", () => {
        expect(
            scoreMapManifest(correctMap.replace('files="src/cache.ts,src/config.ts"', 'independent="true"'), pool, mapGold, tracked),
        ).toMatchObject({ status: "FAIL", reason: "wrong-independence" });
        expect(
            scoreMapManifest(correctMap.replace('files="src/cache.ts,src/config.ts"', 'files="src/cache.ts"'), pool, mapGold, tracked),
        ).toMatchObject({ status: "FAIL", reason: "wrong-mapping" });
    });

    test("classification scores the applied value and clamps parsed importance", () => {
        expect(scoreClassifyManifest(correctClassify.replace('importance="70"', 'importance="64"'), pool, classifyGold)).toMatchObject({ status: "FAIL", reason: "wrong-classification" });
        expect(scoreClassifyManifest(correctClassify.replace('scope="project"', 'scope="ecosystem"'), pool, classifyGold)).toMatchObject({ status: "FAIL", reason: "wrong-classification" });
        expect(scoreClassifyManifest(correctClassify.replace('shareable="true"', 'shareable="false"'), pool, classifyGold)).toMatchObject({ status: "FAIL", reason: "wrong-classification" });
        // Production preserves a field the entry omits, so the applied
        // importance stays the claim's current 70 — inside the 65-75 band, which
        // is a pass rather than a wrong classification.
        expect(scoreClassifyManifest(correctClassify.replace(' importance="70"', ""), pool, classifyGold)).toMatchObject({
            stage: "scored",
            status: "PASS",
            reason: null,
        });
        // The omission only passes because the preserved value satisfies gold. A
        // band that excludes it still fails, on the preserved value.
        const narrowGold = {
            kind: "classify" as const,
            claims: classifyGold.claims.map((claim) =>
                claim.claimId === "claim-true" ? { ...claim, importance: { min: 10, max: 20 } } : claim,
            ),
        };
        expect(scoreClassifyManifest(correctClassify.replace(' importance="70"', ""), pool, narrowGold)).toMatchObject({
            stage: "scored",
            status: "FAIL",
            reason: "wrong-classification",
        });
        expect(scoreClassifyManifest(correctClassify.replace('importance="70"', 'importance="101"'), pool, classifyGold)).toMatchObject({ status: "FAIL", reason: "wrong-classification" });
    });

    test("the applied shareability override decides a sensitive claim's score", () => {
        // applyClassifications forces a reported `true` to false for sensitive
        // content, so the pool ends up matching `shareable: false` gold and the
        // run passes on the applied value rather than the raw report.
        const sensitivePool = {
            ...pool,
            claims: pool.claims.map((claim) =>
                claim.claimId === "claim-true"
                    ? { ...claim, content: "The box answers on 127.0.0.1:8080 for local runs." }
                    : claim,
            ),
        };
        const privateGold = {
            kind: "classify" as const,
            claims: classifyGold.claims.map((claim) =>
                claim.claimId === "claim-true" ? { ...claim, shareable: false } : claim,
            ),
        };
        expect(scoreClassifyManifest(correctClassify, sensitivePool, privateGold)).toMatchObject({
            status: "PASS",
            reason: null,
        });
        // The override fires only for sensitive content: the same manifest and
        // gold against non-sensitive content is a genuine wrong classification.
        expect(scoreClassifyManifest(correctClassify, pool, privateGold)).toMatchObject({
            status: "FAIL",
            reason: "wrong-classification",
        });
    });

    test("update appliability is judged across the batch, not against the snapshot", () => {
        // Production stages updates in order, each taking its new identity for the
        // rest of the batch, so two converging on one identity fail on the second
        // even though neither collides with the unchanged pool.
        const twoUpdates = {
            kind: "verify" as const,
            claims: [
                { ...verifyGold.claims[0]!, verdict: "update" as const, requiredUpdateAnchors: ["shared"], forbiddenUpdateAnchors: [] },
                { ...verifyGold.claims[1]!, requiredUpdateAnchors: ["shared"], forbiddenUpdateAnchors: [] },
                verifyGold.claims[2]!,
            ],
        };
        const converging = `<verify>
<update claim="mcm_true" files="src/cache.ts,src/config.ts">one shared body</update>
<update claim="mcm_update" files="src/cache.ts">one shared body</update>
<archive claim="mcm_false" reason="queue removed"/>
</verify>`;
        expect(scoreVerifyManifest(converging, pool, twoUpdates, tracked)).toMatchObject({
            status: "FAIL",
            reason: "wrong-update-content",
        });
        // Distinct bodies satisfying the same anchor stay appliable.
        const distinct = converging.replace(
            '<update claim="mcm_update" files="src/cache.ts">one shared body</update>',
            '<update claim="mcm_update" files="src/cache.ts">another shared body</update>',
        );
        expect(scoreVerifyManifest(distinct, pool, twoUpdates, tracked)).toMatchObject({ status: "PASS", reason: null });
        // An update may take an identity an earlier update in the same batch
        // vacated, which a snapshot-only check would have refused.
        const handoff = `<verify>
<update claim="mcm_true" files="src/cache.ts,src/config.ts">shared moved along</update>
<update claim="mcm_update" files="src/cache.ts">The cache limit is 4096 entries.  shared</update>
<archive claim="mcm_false" reason="queue removed"/>
</verify>`;
        expect(scoreVerifyManifest(handoff, pool, twoUpdates, tracked)).toMatchObject({ status: "PASS", reason: null });
    });

    test("an update colliding with another live claim is not appliable", () => {
        // Revision asserts the (category, normalized content) identity is free,
        // exempting only the claim being revised, so content equal to a sibling's
        // throws rather than applying.
        const collidingGold = {
            kind: "verify" as const,
            claims: verifyGold.claims.map((claim) =>
                claim.claimId === "claim-update"
                    ? { ...claim, requiredUpdateAnchors: ["removed queue"], forbiddenUpdateAnchors: [] }
                    : claim,
            ),
        };
        // claim-false is active, same category, content "The removed queue still exists."
        const collision = correctVerify.replace(
            "Uses a BOUNDED CACHE with 4096 ENTRIES.",
            "  the REMOVED QUEUE still exists.  ",
        );
        expect(scoreVerifyManifest(collision, pool, collidingGold, tracked)).toMatchObject({
            status: "FAIL",
            reason: "wrong-update-content",
        });
        // The same content is appliable once that sibling is no longer live, so
        // the identity is free and the run passes.
        const archivedSibling = {
            ...pool,
            claims: pool.claims.map((claim) =>
                claim.claimId === "claim-false" ? { ...claim, lifecycleState: "archived" as const } : claim,
            ),
        };
        expect(scoreVerifyManifest(collision, archivedSibling, collidingGold, tracked)).toMatchObject({
            status: "PASS",
            reason: null,
        });
    });

    test("a canonicalizable alias of a gold path scores as that path", () => {
        // Production resolves the path before matching it against a tracked file,
        // so a manifest naming a gold file through an alias applies exactly the
        // gold path and must not read as a wrong mapping.
        expect(
            scoreVerifyManifest(correctVerify.replace("src/cache.ts,src/config.ts", "src/./cache.ts,src/sub/../config.ts"), pool, verifyGold, tracked),
        ).toMatchObject({ status: "PASS", reason: null });
        expect(
            scoreMapManifest(correctMap.replace("src/cache.ts,src/config.ts", "src/./cache.ts,src/sub/../config.ts"), pool, mapGold, tracked),
        ).toMatchObject({ status: "PASS", reason: null });
        // A path that leaves the project is dropped by production rather than
        // resolved inward, so it must not collapse onto a tracked path here.
        expect(
            scoreMapManifest(correctMap.replace("src/cache.ts", "../src/cache.ts"), pool, mapGold, tracked),
        ).toMatchObject({ status: "FAIL", reason: "wrong-mapping" });
        expect(
            scoreMapManifest(correctMap.replace("src/cache.ts", "/src/cache.ts"), pool, mapGold, tracked),
        ).toMatchObject({ status: "FAIL", reason: "wrong-mapping" });
        // Separator handling follows the platform, because production's does. On
        // a POSIX host a backslash is an ordinary filename character, so this
        // path is untracked and production drops it — folding it here would
        // credit output the host would not apply. The win32 branch cannot be
        // exercised from this runner.
        if (sep === "/") {
            expect(
                scoreMapManifest(correctMap.replace("src/cache.ts", "src\\cache.ts"), pool, mapGold, tracked),
            ).toMatchObject({ status: "FAIL", reason: "wrong-mapping" });
        }
    });

    test("production validation rejects malformed coverage as invalid model output", () => {
        for (const manifest of [
            correctVerify.replace("</verify>", ""),
            correctVerify.replace(' claim="mcm_true"', ""),
            correctVerify.replace("mcm_true", "mcm_unknown"),
            correctVerify.replace("</verify>", '<verified claim="mcm_true" files="src/cache.ts,src/config.ts"/></verify>'),
        ]) {
            expect(scoreVerifyManifest(manifest, pool, verifyGold, tracked)).toMatchObject({
                stage: "validation-rejected",
                status: "FAIL",
                reason: "invalid-output",
            });
        }
    });

    test("production infra predicates run before model-quality scoring", () => {
        const lengthCapped = [{ finish_reason: "length" }];
        expect(scoreVerifyManifest(correctVerify, pool, verifyGold, tracked, { messages: lengthCapped })).toMatchObject({
            stage: "infra-rejected",
            status: "ERROR",
            reason: "output-length-capped",
        });

        const providerCompletion = [{
            info: {
                role: "assistant",
                time: { created: 1 },
                finish: "stop",
                error: null,
                tokens: { output: 8, reasoning: 0 },
            },
        }];
        expect(scoreVerifyManifest("provider outage", pool, verifyGold, tracked, { messages: providerCompletion })).toMatchObject({
            stage: "infra-rejected",
            status: "ERROR",
            reason: "provider-failure",
        });
        expect(scoreVerifyManifest("provider outage", pool, verifyGold, tracked)).toMatchObject({
            stage: "validation-rejected",
            status: "FAIL",
            reason: "invalid-output",
        });
        expect(scoreVerifyManifest("", pool, verifyGold, tracked)).toMatchObject({
            stage: "infra-rejected",
            status: "ERROR",
            reason: "provider-failure",
        });
    });
});

export const dreamerScorerFixture = { pool, verifyGold, mapGold, classifyGold };
