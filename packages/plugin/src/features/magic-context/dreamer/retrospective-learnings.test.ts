import { afterEach, describe, expect, test } from "bun:test";

import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import type { AutonomousManifestIdentity } from "../memory/storage-claim-autonomous";
import {
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "../memory/storage-claim-current-state";
import { createClaimReaderTestDatabase } from "../test-claim-database";
import { getUserMemoryCandidates } from "../user-memory/storage-user-memory";
import {
    applyRetrospectiveLearnings,
    hasHighSourceOverlap,
    parseRetrospectiveLearnings,
    validateRetrospectiveLearningText,
} from "./retrospective-learnings";
import { claimEffectMemoryChanges } from "./storage-dream-runs";

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

const PROJECT = "git:retro-test";

function identity(runId = "retro-run", batchId = "window-1"): AutonomousManifestIdentity {
    return {
        producer: "dreamer-retrospective",
        task: "retrospective",
        runId,
        leaseKey: `memory:${PROJECT}`,
        leaseGeneration: 1,
        batchId,
    };
}

function claims(database: Database) {
    const result = readProjectMemoryCurrentState(database, {
        projectIds: resolveProjectIdsForIdentities(database, [PROJECT]),
        lifecycleStates: ["active"],
        surface: "maintenance_hygiene",
        workspaceEpoch: "retro-test",
    });
    if (result.status !== "ok") throw new Error(result.reasons.join(", "));
    return result.items;
}

function apply(
    database: Database,
    args: Omit<Parameters<typeof applyRetrospectiveLearnings>[0], "db" | "identity">,
    manifestIdentity = identity(),
) {
    return database
        .transaction(() =>
            applyRetrospectiveLearnings({
                db: database,
                identity: manifestIdentity,
                ...args,
            }),
        )
        .immediate();
}

describe("parseRetrospectiveLearnings", () => {
    test("parses memory and observation routes", () => {
        const learnings = parseRetrospectiveLearnings(`<learnings>
            <learning route="memory" category="PROJECT_RULES">Verify tool availability before claiming support.</learning>
            <learning route="observation">Prefers evidence-backed root-cause analysis.</learning>
            <learning route="memory" category="NOT_A_CATEGORY">dropped</learning>
        </learnings>`);
        expect(learnings).toHaveLength(2);
        expect(learnings[0]).toEqual({
            route: "memory",
            category: "PROJECT_RULES",
            content: "Verify tool availability before claiming support.",
        });
        expect(learnings[1]?.route).toBe("observation");
    });

    test("returns an empty manifest when the root is absent", () => {
        expect(parseRetrospectiveLearnings("no xml here")).toEqual([]);
    });
});

describe("retrospective privacy validation", () => {
    test("rejects quotes, dates, frustration markers, and near-transcriptions", () => {
        expect(validateRetrospectiveLearningText('They said "do it now please"')).toBe("raw_quote");
        expect(validateRetrospectiveLearningText("Broke on 2026-06-20 release")).toBe("date");
        expect(validateRetrospectiveLearningText("that's wrong again")).toBe("frustration_marker");
        expect(
            validateRetrospectiveLearningText(
                "Avoid using bash to search the codebase instead of the dedicated search tool.",
                ["you keep using bash to search the codebase instead of the dedicated search tool"],
            ),
        ).toBe("source_overlap");
    });

    test("scans source text beyond the old leading window", () => {
        const filler = Array.from({ length: 500 }, (_, index) => `filler${index}`).join(" ");
        const tail = "delete the production database without any backup whatsoever";
        expect(hasHighSourceOverlap(`Note: ${tail}.`, [`${filler} ${tail}`])).toBe(true);
    });
});

describe("applyRetrospectiveLearnings", () => {
    test("writes an inference-tainted claim and gates profile observations", () => {
        db = createClaimReaderTestDatabase();
        const learnings = parseRetrospectiveLearnings(`<learnings>
            <learning route="memory" category="CONSTRAINTS">External rate limits apply to bulk provider calls.</learning>
            <learning route="observation">Wants tradeoffs discussed before structural changes.</learning>
        </learnings>`);
        const result = apply(db, {
            projectIdentity: PROJECT,
            sourceSessionId: "ses-1",
            learnings,
            userMemoryCollectionEnabled: true,
        });

        expect(result).toMatchObject({
            memoryWritten: 1,
            observationsInserted: 1,
            observationsDropped: 0,
            rejected: [],
        });
        expect(claims(db)).toHaveLength(1);
        expect(claims(db)[0]?.policy.originTaint).toBe("DREAMER_INFERENCE");
        expect(getUserMemoryCandidates(db)).toHaveLength(1);
    });

    test("returns the claim effects a run needs for its memory-change telemetry", () => {
        // Route-`memory` learnings are claim-native, so a caller diffing the
        // legacy `memories` table sees nothing and records NULL changes for a
        // run that did create claims. The effects have to come back here.
        db = createClaimReaderTestDatabase();
        const learnings = parseRetrospectiveLearnings(`<learnings>
            <learning route="memory" category="CONSTRAINTS">Bulk provider calls are rate limited.</learning>
        </learnings>`);
        const result = apply(db, {
            projectIdentity: PROJECT,
            sourceSessionId: "ses-effects",
            learnings,
            userMemoryCollectionEnabled: false,
        });

        expect(result.memoryWritten).toBe(1);
        expect(result.effects.length).toBeGreaterThan(0);
        const changes = claimEffectMemoryChanges(result.effects);
        expect(changes).not.toBeNull();
        expect(changes?.claimUpsertedIds ?? []).toHaveLength(1);
    });

    test("replays one window without duplicate claims, observations, or generations", () => {
        db = createClaimReaderTestDatabase();
        const learnings = parseRetrospectiveLearnings(`<learnings>
            <learning route="memory" category="PROJECT_RULES">Run focused tests before declaring completion.</learning>
            <learning route="observation">Prefers concise root-cause summaries.</learning>
        </learnings>`);
        const args = {
            projectIdentity: PROJECT,
            sourceSessionId: "ses-1",
            learnings,
            userMemoryCollectionEnabled: true,
        };
        const first = apply(db, args);
        const generation = claims(db)[0]?.policy.generation;
        const second = apply(db, args);

        expect(second).toEqual(first);
        expect(claims(db)).toHaveLength(1);
        expect(claims(db)[0]?.revision).toBe(1);
        expect(claims(db)[0]?.policy.generation).toBe(generation);
        expect(getUserMemoryCandidates(db)).toHaveLength(1);
        expect(
            (
                db.prepare("SELECT COUNT(*) AS count FROM claim_operation_receipts").get() as {
                    count: number;
                }
            ).count,
        ).toBe(1);
    });

    test("rejects source overlap before any semantic write", () => {
        db = createClaimReaderTestDatabase();
        const result = apply(db, {
            projectIdentity: PROJECT,
            sourceSessionId: "ses-1",
            learnings: parseRetrospectiveLearnings(`<learnings>
                <learning route="memory" category="PROJECT_RULES">Stop reinventing the search tool that was purpose built for this.</learning>
            </learnings>`),
            userMemoryCollectionEnabled: false,
            sourceUserTexts: ["stop reinventing the search tool that was purpose built for this"],
        });
        expect(result.memoryWritten).toBe(0);
        expect(result.rejected[0]?.reason).toBe("source_overlap");
        expect(claims(db)).toHaveLength(0);
    });

    test("outer failure rolls back claim graph, receipt, candidate, and generation", () => {
        db = createClaimReaderTestDatabase();
        const learnings = parseRetrospectiveLearnings(`<learnings>
            <learning route="memory" category="ARCHITECTURE">Claims and evidence commit together.</learning>
            <learning route="observation">Prefers atomic publication.</learning>
        </learnings>`);
        expect(() =>
            db
                ?.transaction(() => {
                    applyRetrospectiveLearnings({
                        db: db as Database,
                        projectIdentity: PROJECT,
                        sourceSessionId: "ses-1",
                        learnings,
                        identity: identity(),
                        userMemoryCollectionEnabled: true,
                    });
                    throw new Error("window write failed");
                })
                .immediate(),
        ).toThrow("window write failed");

        expect(claims(db)).toHaveLength(0);
        expect(getUserMemoryCandidates(db)).toHaveLength(0);
        for (const table of [
            "observations",
            "claim_operation_receipts",
            "claim_operation_effects",
            "claim_project_generations",
        ]) {
            const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
                count: number;
            };
            expect(row.count).toBe(0);
        }
    });
});
