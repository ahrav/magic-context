import { afterEach, describe, expect, test } from "bun:test";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { getMemoriesByProject } from "../memory";
import { getCurrentMemoryClaimByLegacyMemoryId } from "../memory/storage-memory-claims";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { getUserMemoryCandidates } from "../user-memory/storage-user-memory";
import {
    applyRetrospectiveLearnings,
    hasHighSourceOverlap,
    parseRetrospectiveLearnings,
    validateRetrospectiveLearningText,
} from "./retrospective-learnings";

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

const PROJECT = "git:retro-test";

describe("parseRetrospectiveLearnings", () => {
    test("parses memory + observation learnings and ignores invalid routes/categories", () => {
        const xml = `<learnings>
            <learning route="memory" category="PROJECT_RULES">Verify a tool is callable before claiming support.</learning>
            <learning route="observation">Prefers evidence-backed root-cause analysis.</learning>
            <learning route="memory" category="NOT_A_CATEGORY">dropped</learning>
            <learning route="bogus">dropped</learning>
        </learnings>`;
        const learnings = parseRetrospectiveLearnings(xml);
        expect(learnings.length).toBe(2);
        expect(learnings[0]).toEqual({
            route: "memory",
            category: "PROJECT_RULES",
            content: "Verify a tool is callable before claiming support.",
        });
        expect(learnings[1].route).toBe("observation");
    });

    test("returns [] when there is no <learnings> block", () => {
        expect(parseRetrospectiveLearnings("no xml here")).toEqual([]);
    });
});

describe("validateRetrospectiveLearningText", () => {
    test("rejects quotes, dates, frustration markers", () => {
        expect(validateRetrospectiveLearningText('They said "do it now please"')).toBe("raw_quote");
        expect(validateRetrospectiveLearningText("Broke on 2026-06-20 release")).toBe("date");
        expect(validateRetrospectiveLearningText("that's wrong again")).toBe("frustration_marker");
    });

    test("accepts a clean third-person rule", () => {
        expect(
            validateRetrospectiveLearningText(
                "Run the focused test suite before declaring a fix complete.",
            ),
        ).toBeNull();
    });

    test("rejects a near-transcription of a source user line (source_overlap)", () => {
        const source = [
            "you keep using bash to search the codebase instead of the dedicated search tool",
        ];
        // Lightly reworded but echoes a long verbatim run.
        const transcription =
            "Avoid using bash to search the codebase instead of the dedicated search tool.";
        expect(validateRetrospectiveLearningText(transcription, source)).toBe("source_overlap");
        // A genuine distillation shares no long run.
        expect(
            validateRetrospectiveLearningText(
                "Prefer indexed search tools over shell scans for code lookups.",
                source,
            ),
        ).toBeNull();
    });
});

describe("hasHighSourceOverlap", () => {
    test("flags a long shared word run, ignores short incidental overlap", () => {
        const source = ["the historian must never run during an active tool call window"];
        expect(
            hasHighSourceOverlap(
                "Ensure the historian must never run during an active tool call window.",
                source,
            ),
        ).toBe(true);
        expect(hasHighSourceOverlap("Keep the historian idle during tool use.", source)).toBe(
            false,
        );
    });

    test("catches a verbatim run buried PAST the old 400-word leading window", () => {
        // Privacy regression: the old guard truncated each source to its leading
        // 400 words, so a verbatim run from word 401+ slipped through. Build a
        // source with 500 filler words then the sensitive run at the tail.
        const filler = Array.from({ length: 500 }, (_, i) => `filler${i}`).join(" ");
        const tail = "delete the production database without any backup whatsoever";
        const source = [`${filler} ${tail}`];
        expect(hasHighSourceOverlap(`Note: ${tail}.`, source)).toBe(true);
    });
});

describe("applyRetrospectiveLearnings", () => {
    test("writes memory learnings, gates observations on userMemoryCollectionEnabled", () => {
        db = freshDb();
        const learnings = parseRetrospectiveLearnings(`<learnings>
            <learning route="memory" category="CONSTRAINTS">External rate limits apply when calling the provider in bulk.</learning>
            <learning route="observation">Wants tradeoffs discussed before structural changes.</learning>
        </learnings>`);

        // Gate OFF → observation dropped.
        const off = applyRetrospectiveLearnings({
            db,
            projectIdentity: PROJECT,
            sourceSessionId: "ses-1",
            learnings,
            userMemoryCollectionEnabled: false,
        });
        expect(off.memoryWritten).toBe(1);
        expect(off.observationsInserted).toBe(0);
        expect(off.observationsDropped).toBe(1);
        expect(getUserMemoryCandidates(db).length).toBe(0);
        expect(getMemoriesByProject(db, PROJECT).length).toBe(1);
    });

    test("gate ON inserts observation candidates", () => {
        db = freshDb();
        const learnings = parseRetrospectiveLearnings(`<learnings>
            <learning route="observation">Prefers the smallest effective fix first.</learning>
        </learnings>`);
        const on = applyRetrospectiveLearnings({
            db,
            projectIdentity: PROJECT,
            sourceSessionId: "ses-1",
            learnings,
            userMemoryCollectionEnabled: true,
        });
        expect(on.observationsInserted).toBe(1);
        expect(getUserMemoryCandidates(db).length).toBe(1);
    });

    test("is idempotent: a re-emitted identical memory is skipped, not a fatal throw", () => {
        db = freshDb();
        const xml = `<learnings><learning route="memory" category="PROJECT_RULES">Always rebuild dists after a server-side change.</learning></learnings>`;
        const first = applyRetrospectiveLearnings({
            db,
            projectIdentity: PROJECT,
            sourceSessionId: "ses-1",
            learnings: parseRetrospectiveLearnings(xml),
            userMemoryCollectionEnabled: false,
        });
        expect(first.memoryWritten).toBe(1);
        // Same content again — must not throw on UNIQUE, must skip.
        const second = applyRetrospectiveLearnings({
            db,
            projectIdentity: PROJECT,
            sourceSessionId: "ses-2",
            learnings: parseRetrospectiveLearnings(xml),
            userMemoryCollectionEnabled: false,
        });
        expect(second.memoryWritten).toBe(0);
        expect(getMemoriesByProject(db, PROJECT).length).toBe(1);
        // The duplicate write leaves the claim at revision 1.
        const memoryId = getMemoriesByProject(db, PROJECT)[0]?.id as number;
        const claim = getCurrentMemoryClaimByLegacyMemoryId(db, memoryId);
        expect(claim?.revision).toBe(1);
        expect(claim?.content).toBe("Always rebuild dists after a server-side change.");
        expect(claim?.state).toBe("active");
    });

    test("rejects a near-transcription learning via sourceUserTexts", () => {
        db = freshDb();
        const learnings = parseRetrospectiveLearnings(`<learnings>
            <learning route="memory" category="PROJECT_RULES">Stop reinventing the search tool that was purpose built for this.</learning>
        </learnings>`);
        const applied = applyRetrospectiveLearnings({
            db,
            projectIdentity: PROJECT,
            sourceSessionId: "ses-1",
            learnings,
            userMemoryCollectionEnabled: false,
            sourceUserTexts: ["stop reinventing the search tool that was purpose built for this"],
        });
        expect(applied.memoryWritten).toBe(0);
        expect(applied.rejected[0]?.reason).toBe("source_overlap");
        expect(getMemoriesByProject(db, PROJECT).length).toBe(0);
    });
});
