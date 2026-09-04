import { describe, expect, test } from "bun:test";
import { renderAntiMemoryContent } from "../../features/magic-context/memory/anti-memory-content";
import { ANTI_MEMORY_CATEGORY } from "../../features/magic-context/memory/constants";
import type { ReadRow } from "../../shared/kernel-client";
import { memoryResultFromRow, searchKernelMemoryRows } from "./kernel-memory-search";

const OBJECT_A = `mem_${"a".repeat(32)}`;
const OBJECT_B = `mem_${"b".repeat(32)}`;

function readRow(input: {
    objectId: string;
    decisionKind: string;
    summary: string;
    rationale?: string;
    seq?: number;
    labeled?: boolean;
}): ReadRow {
    const seq = input.seq ?? 1;
    return {
        object: {
            object_id: input.objectId,
            object_kind: "decision",
            domain_id: "memory",
            source_kind: "assistant",
            source_id: "ctx_memory",
            source_revision: 1,
            created_commit_seq: seq,
            invalidated_commit_seq: null,
            superseded_by: null,
            sensitivity: "normal",
        },
        visibility: "labeled",
        labeled: input.labeled ?? true,
        scope_id: null,
        token: { object_id: input.objectId, known_as_of: seq },
        decision: {
            decision_kind: input.decisionKind,
            payload: { summary: input.summary, rationale: input.rationale ?? "" },
        },
    };
}

describe("memoryResultFromRow", () => {
    test("a rejected-approach row surfaces as an anti-memory warning with the parsed fields", () => {
        const summary = renderAntiMemoryContent({
            trigger: "session caching",
            rejectedStrategy: "Redis",
            rejectionReason: "it creates split ownership",
            saferAlternative: "use SQLite",
        });
        const row = readRow({
            objectId: OBJECT_A,
            decisionKind: ANTI_MEMORY_CATEGORY,
            summary,
            seq: 7,
        });
        const result = memoryResultFromRow(row, 0.9, "exact");
        expect(result.source).toBe("anti_memory");
        if (result.source !== "anti_memory") return;
        expect(result.trigger).toBe("session caching");
        expect(result.rejectedStrategy).toBe("Redis");
        expect(result.rejectionReason).toBe("it creates split ownership");
        expect(result.saferAlternative).toBe("use SQLite");
        expect(result.score).toBe(0.9);
        expect(result.publicClaimId).toBe(OBJECT_A);
        expect(result.revisionLocator).toBe(`${OBJECT_A}@7`);
        expect(result.matchType).toBe("exact");
        expect(result.policyLabel).toBe("labeled");
        expect(result.contentDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(result.normalizedHash).toBe(result.contentDigest);
        expect(result.claimId).toBe(-1);
    });

    test("a rejected-approach row with an unparseable summary falls back to the memory shape", () => {
        const row = readRow({
            objectId: OBJECT_A,
            decisionKind: ANTI_MEMORY_CATEGORY,
            summary: "free-form text without labeled anti-memory fields",
        });
        const result = memoryResultFromRow(row, 0.5, "lexical");
        expect(result.source).toBe("memory");
        if (result.source !== "memory") return;
        expect(result.content).toBe("free-form text without labeled anti-memory fields");
        expect(result.category).toBe(ANTI_MEMORY_CATEGORY);
        expect(result.matchType).toBe("lexical");
    });

    test("an ordinary decision row keeps the memory shape", () => {
        const row = readRow({
            objectId: OBJECT_A,
            decisionKind: "PROJECT_RULES",
            summary: "the historian runs on a lease",
        });
        const result = memoryResultFromRow(row, 1, "exact");
        expect(result.source).toBe("memory");
    });
});

describe("searchKernelMemoryRows match labeling and domain fence", () => {
    test("an object-id query labels hits exact; a text query labels hits lexical", () => {
        const rows = [
            readRow({
                objectId: OBJECT_A,
                decisionKind: "PROJECT_RULES",
                summary: "the historian runs on a lease",
            }),
        ];
        const byId = searchKernelMemoryRows({ rows, query: OBJECT_A, limit: 5 });
        expect(byId?.map((hit) => hit.matchType)).toEqual(["exact"]);
        const byText = searchKernelMemoryRows({ rows, query: "historian lease", limit: 5 });
        expect(byText?.map((hit) => hit.matchType)).toEqual(["lexical"]);
    });

    test("a text-ranked anti-memory hit is labeled lexical", () => {
        const rows = [
            readRow({
                objectId: OBJECT_A,
                decisionKind: ANTI_MEMORY_CATEGORY,
                summary: renderAntiMemoryContent({
                    trigger: "session caching",
                    rejectedStrategy: "Redis",
                    rejectionReason: "it creates split ownership",
                }),
            }),
        ];
        const hits = searchKernelMemoryRows({ rows, query: "session caching", limit: 5 });
        expect(hits?.map((hit) => [hit.source, hit.matchType])).toEqual([
            ["anti_memory", "lexical"],
        ]);
    });

    test("a decision row outside the memory domain never matches", () => {
        const foreign = readRow({
            objectId: OBJECT_A,
            decisionKind: "PROJECT_RULES",
            summary: "alpha beta",
        });
        foreign.object.domain_id = "notes";
        expect(searchKernelMemoryRows({ rows: [foreign], query: "alpha beta", limit: 5 })).toBe(
            null,
        );
        expect(searchKernelMemoryRows({ rows: [foreign], query: OBJECT_A, limit: 5 })).toBe(null);
    });
});

describe("searchKernelMemoryRows tie-breaking", () => {
    test("rows with equal score, seq, and object id keep their input order", () => {
        const rows = [
            readRow({
                objectId: OBJECT_A,
                decisionKind: "PROJECT_RULES",
                summary: "alpha beta one",
                seq: 3,
            }),
            readRow({
                objectId: OBJECT_A,
                decisionKind: "PROJECT_RULES",
                summary: "alpha beta two",
                seq: 3,
            }),
        ];
        const hits = searchKernelMemoryRows({ rows, query: "alpha beta", limit: 5 });
        expect(hits).not.toBeNull();
        expect(hits?.map((hit) => (hit.source === "memory" ? hit.content : hit.trigger))).toEqual([
            "alpha beta one",
            "alpha beta two",
        ]);
    });

    test("rows with equal score and seq sort ascending by object id", () => {
        const rows = [
            readRow({
                objectId: OBJECT_B,
                decisionKind: "PROJECT_RULES",
                summary: "alpha beta",
                seq: 3,
            }),
            readRow({
                objectId: OBJECT_A,
                decisionKind: "PROJECT_RULES",
                summary: "alpha beta",
                seq: 3,
            }),
        ];
        const hits = searchKernelMemoryRows({ rows, query: "alpha beta", limit: 5 });
        expect(hits?.map((hit) => hit.publicClaimId)).toEqual([OBJECT_A, OBJECT_B]);
    });
});
