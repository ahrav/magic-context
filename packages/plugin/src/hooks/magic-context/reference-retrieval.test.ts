import { describe, expect, it } from "bun:test";
import type { Compartment } from "../../features/magic-context/compartment-storage";
import {
    buildReferenceBlocks,
    renderSeedExamplesBlock,
    renderSessionReferencesBlock,
    SEED_FLOOR,
    SESSION_REF_WINDOW,
    selectSeeds,
} from "./reference-retrieval";
import { REFERENCE_SEEDS } from "./reference-seeds.generated";

function makeCompartment(over: Partial<Compartment> & { sequence: number }): Compartment {
    return {
        id: over.sequence,
        sessionId: "ses_test",
        sequence: over.sequence,
        startMessage: over.startMessage ?? over.sequence * 10 + 1,
        endMessage: over.endMessage ?? over.sequence * 10 + 9,
        startMessageId: `m${over.sequence}a`,
        endMessageId: `m${over.sequence}b`,
        title: over.title ?? `Compartment ${over.sequence}`,
        content: over.content ?? `flat content ${over.sequence}`,
        p1: over.p1 ?? null,
        p2: over.p2 ?? null,
        p3: over.p3 ?? null,
        p4: over.p4 ?? null,
        importance: over.importance ?? 50,
        episodeType: over.episodeType ?? null,
        legacy: over.legacy ?? (over.p1 ? 0 : 1),
        createdAt: 1000 + over.sequence,
    };
}

describe("reference seed corpus", () => {
    it("ships exactly 60 seeds spanning all 5 importance bands", () => {
        expect(REFERENCE_SEEDS.length).toBe(60);
        const imps = REFERENCE_SEEDS.map((s) => s.importance);
        expect(Math.min(...imps)).toBeLessThanOrEqual(9);
        expect(Math.max(...imps)).toBeGreaterThanOrEqual(85);
        // every block is a real compartment unit
        for (const s of REFERENCE_SEEDS) {
            expect(s.block.startsWith("<compartment")).toBe(true);
            expect(s.block).toContain("</compartment>");
        }
    });
});

describe("selectSeeds", () => {
    it("returns exactly SEED_FLOOR seeds by default", () => {
        expect(selectSeeds("ses_a", 1).length).toBe(SEED_FLOOR);
    });

    it("is deterministic for the same (sessionId, chunkStart)", () => {
        const a = selectSeeds("ses_a", 42).map((s) => s.importance);
        const b = selectSeeds("ses_a", 42).map((s) => s.importance);
        expect(a).toEqual(b);
    });

    it("rotates: different chunkStart yields a different combination (usually)", () => {
        // Across many chunk starts we should see more than one distinct combo.
        const combos = new Set<string>();
        for (let chunk = 1; chunk <= 30; chunk++) {
            combos.add(
                selectSeeds("ses_a", chunk)
                    .map((s) => s.importance)
                    .sort((x, y) => x - y)
                    .join(","),
            );
        }
        expect(combos.size).toBeGreaterThan(1);
    });

    it("spans the importance range every run (not 4 clustered scores)", () => {
        // Each pick comes from a distinct band, so the spread (max-min) is wide.
        for (let chunk = 1; chunk <= 20; chunk++) {
            const imps = selectSeeds("ses_x", chunk).map((s) => s.importance);
            const spread = Math.max(...imps) - Math.min(...imps);
            expect(spread).toBeGreaterThanOrEqual(40);
        }
    });

    it("never returns duplicate seeds within one selection", () => {
        for (let chunk = 1; chunk <= 20; chunk++) {
            const picks = selectSeeds("ses_dup", chunk);
            expect(new Set(picks).size).toBe(picks.length);
        }
    });

    it("different sessionIds can produce different combinations", () => {
        const a = selectSeeds("ses_aaaa", 1)
            .map((s) => s.importance)
            .join(",");
        const b = selectSeeds("ses_zzzz", 1)
            .map((s) => s.importance)
            .join(",");
        // not asserting inequality strictly (hash collisions possible), but the
        // mechanism must consider sessionId — verify by sampling several.
        const distinct = new Set<string>();
        for (const sid of ["s1", "s2", "s3", "s4", "s5", "s6"]) {
            distinct.add(
                selectSeeds(sid, 1)
                    .map((s) => s.importance)
                    .join(","),
            );
        }
        expect(distinct.size).toBeGreaterThan(1);
        void a;
        void b;
    });
});

describe("renderSeedExamplesBlock", () => {
    it("wraps seeds in the exact tag the prompt expects", () => {
        const block = renderSeedExamplesBlock(selectSeeds("ses_a", 1));
        expect(block.startsWith("<compartment_examples_from_other_projects>")).toBe(true);
        expect(block.endsWith("</compartment_examples_from_other_projects>")).toBe(true);
        expect(block).toContain("<compartment ");
    });

    it("returns empty string for zero seeds", () => {
        expect(renderSeedExamplesBlock([])).toBe("");
    });
});

describe("renderSessionReferencesBlock", () => {
    it("returns empty string for a young session (no compartments)", () => {
        expect(renderSessionReferencesBlock([])).toBe("");
    });

    it("shows only the last SESSION_REF_WINDOW compartments", () => {
        const comps = Array.from({ length: 10 }, (_, i) =>
            makeCompartment({
                sequence: i,
                p1: `tier1-${i}`,
                p2: `t2-${i}`,
                p3: `t3-${i}`,
                p4: `t4-${i}`,
            }),
        );
        const block = renderSessionReferencesBlock(comps);
        // last 6 → sequences 4..9 present, 0..3 absent
        expect(block).toContain("tier1-9");
        expect(block).toContain("tier1-4");
        expect(block).not.toContain("tier1-3");
        const count = (block.match(/<compartment /g) ?? []).length;
        expect(count).toBe(SESSION_REF_WINDOW);
    });

    it("renders v2 rows with all four tiers (p4 self-closes when empty)", () => {
        const block = renderSessionReferencesBlock([
            makeCompartment({
                sequence: 0,
                p1: "P1",
                p2: "P2",
                p3: "P3",
                p4: "",
                importance: 70,
                episodeType: "bug",
            }),
        ]);
        expect(block).toContain("<p1>\nP1\n</p1>");
        expect(block).toContain("<p2>\nP2\n</p2>");
        expect(block).toContain("<p3>\nP3\n</p3>");
        expect(block).toContain("<p4/>"); // empty p4 self-closes
        expect(block).toContain('importance="70"');
        expect(block).toContain('episode_type="bug"');
    });

    it("renders legacy rows as flat content with no tier tags", () => {
        const block = renderSessionReferencesBlock([
            makeCompartment({ sequence: 0, content: "old flat body", legacy: 1 }),
        ]);
        expect(block).toContain("old flat body");
        expect(block).not.toContain("<p1>");
    });

    it("escapes title attribute", () => {
        const block = renderSessionReferencesBlock([
            makeCompartment({
                sequence: 0,
                title: 'a "quoted" & <wild>',
                p1: "x",
                p2: "y",
                p3: "z",
                p4: "",
            }),
        ]);
        expect(block).not.toContain('title="a "quoted"');
        expect(block).toContain("&quot;");
    });
});

describe("buildReferenceBlocks", () => {
    it("always produces seed examples; session refs empty when young", () => {
        const blocks = buildReferenceBlocks({
            sessionId: "ses_a",
            chunkStart: 1,
            sessionCompartments: [],
        });
        expect(blocks.seedExamples).toContain("<compartment_examples_from_other_projects>");
        expect(blocks.sessionReferences).toBe("");
    });

    it("produces both blocks for a mature session", () => {
        const comps = [makeCompartment({ sequence: 0, p1: "a", p2: "b", p3: "c", p4: "" })];
        const blocks = buildReferenceBlocks({
            sessionId: "ses_a",
            chunkStart: 200,
            sessionCompartments: comps,
        });
        expect(blocks.seedExamples).toContain("<compartment_examples_from_other_projects>");
        expect(blocks.sessionReferences).toContain("<session_references>");
    });

    it("is fully deterministic (no embedding/clock/db)", () => {
        const comps = [makeCompartment({ sequence: 0, p1: "a", p2: "b", p3: "c", p4: "d" })];
        const a = buildReferenceBlocks({
            sessionId: "ses_z",
            chunkStart: 5,
            sessionCompartments: comps,
        });
        const b = buildReferenceBlocks({
            sessionId: "ses_z",
            chunkStart: 5,
            sessionCompartments: comps,
        });
        expect(a).toEqual(b);
    });
});

describe("seed corpus matches the historian's required event fields", () => {
    // The seeds are runtime examples: `selectSeeds` puts them in front of the
    // historian to calibrate output shape. A seed that omits a field the prompt
    // marks required teaches the model to omit it too, and for
    // `reason_for_change` the consequence is silent — `mappedPayload` skips such
    // an event and receipts it, so the anti-memory is never created and never
    // retried.
    const REQUIRED_TRAJECTORY_FIELDS = [
        "summary",
        "before_strategy",
        "correction_source",
        "correction_signal",
        "after_strategy",
        "reason_for_change",
        "evidence",
    ] as const;

    const trajectoryBlocks = REFERENCE_SEEDS.flatMap((seed) => [
        ...seed.block.matchAll(/<trajectory_correction[^>]*>([\s\S]*?)<\/trajectory_correction>/g),
    ]).map((match) => match[1] ?? "");

    it("has trajectory corrections to check", () => {
        expect(trajectoryBlocks.length).toBeGreaterThan(0);
    });

    it("gives every trajectory correction every required field", () => {
        const missing = trajectoryBlocks.flatMap((block, index) =>
            REQUIRED_TRAJECTORY_FIELDS.filter((field) => !block.includes(`<${field}>`)).map(
                (field) => `seed trajectory_correction #${index + 1} is missing <${field}>`,
            ),
        );
        expect(missing).toEqual([]);
    });

    it("keeps the rejection reason distinct from the evidence quote", () => {
        // `evidence` proves the pivot happened; `reason_for_change` must say why
        // the old strategy was wrong. A seed that repeats one as the other
        // demonstrates exactly the conflation the harvest refuses to persist.
        const conflated = trajectoryBlocks.flatMap((block, index) => {
            const field = (tag: string) =>
                block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();
            const reason = field("reason_for_change");
            const evidence = field("evidence");
            return reason && evidence && reason === evidence
                ? [`seed trajectory_correction #${index + 1} reuses evidence as the reason`]
                : [];
        });
        expect(conflated).toEqual([]);
    });
});
