
import { afterEach, describe, expect, it } from "bun:test";
import { getVisibleRevisionLocators } from "../../../plugin/src/hooks/magic-context/inject-compartments";
import { TestHarness } from "../harness";
import { openTestDb } from "../test-db";
import { mcOffOptions } from "./presets";
import { seedGoldMemories } from "./seed-gold-memories";
import { scriptedCtxSearchTurn } from "./scripted-ctx-search";

const harnesses: TestHarness[] = [];

async function createHarness(
    options: Parameters<typeof TestHarness.create>[0] = {},
): Promise<TestHarness> {
    const harness = await TestHarness.create(options);
    harnesses.push(harness);
    return harness;
}

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

describe("scriptedCtxSearchTurn", () => {
    const claimId = (suffix: string): string => `mcm_${suffix.repeat(32).slice(0, 32)}`;

    it("rejects oversized id sets before using a harness", async () => {
        await expect(
            scriptedCtxSearchTurn(null as never, "unused", [
                claimId("1"),
                claimId("2"),
                claimId("3"),
                claimId("4"),
                claimId("5"),
                claimId("6"),
            ]),
        ).rejects.toThrow("accepts at most 5 ids per turn");
    });

    it("rejects empty and invalid id sets before using a harness", async () => {
        await expect(
            scriptedCtxSearchTurn(null as never, "unused", []),
        ).rejects.toThrow("requires at least one id");
        for (const id of ["", "1", "#1", "mcm_", "mcm_notlongenough", claimId("g")]) {
            await expect(
                scriptedCtxSearchTurn(null as never, "unused", [id]),
            ).rejects.toThrow("received invalid memory id");
        }
    });

    it("accepts five candidate ids and filters visibly injected rows", async () => {
        const harness = await createHarness();
        const candidates = seedGoldMemories({
            workdir: harness.opencode.env.workdir,
            dbPath: harness.contextDbPath(),
            verification: "candidate",
            rows: [
                { category: "PROJECT_RULES", content: "Candidate oracle fact alpha." },
                { category: "CONFIG_VALUES", content: "Candidate oracle fact beta." },
                { category: "PROJECT_RULES", content: "Candidate oracle fact gamma." },
                { category: "CONFIG_VALUES", content: "Candidate oracle fact delta." },
                { category: "PROJECT_RULES", content: "Candidate oracle fact epsilon." },
            ],
        });
        const [injected] = seedGoldMemories({
            workdir: harness.opencode.env.workdir,
            dbPath: harness.contextDbPath(),
            verification: "verified",
            rows: [{ category: "PROJECT_RULES", content: "Already visible injected oracle fact." }],
        });
        if (!injected) throw new Error("verified seed returned no row");

        const candidateSession = await harness.createSession();
        const candidateResult = await scriptedCtxSearchTurn(harness, candidateSession, candidates);
        expect(candidateResult).toContain("Candidate oracle fact alpha.");
        expect(candidateResult).toContain("Candidate oracle fact beta.");
        expect(candidateResult).toContain("Candidate oracle fact gamma.");
        expect(candidateResult).toContain("Candidate oracle fact delta.");
        expect(candidateResult).toContain("Candidate oracle fact epsilon.");

        const visibleSession = await harness.createSession();
        const visibleResult = await scriptedCtxSearchTurn(harness, visibleSession, [injected]);
        const db = openTestDb(harness.contextDbPath(), { readonly: true });
        try {
            const row = db
                .prepare("SELECT memory_block_ids FROM session_meta WHERE session_id = ?")
                .get(visibleSession) as { memory_block_ids: string } | null;
            expect(row).not.toBeNull();
            // `ctx_search` hard-filters against revision locators recorded for rendered claims.
            const visibleLocators = getVisibleRevisionLocators(db, visibleSession);
            expect(visibleLocators).not.toBeNull();
            expect([...(visibleLocators ?? [])]).toContain(injected.revisionLocator);
        } finally {
            db.close();
        }
        expect(visibleResult).not.toContain("Already visible injected oracle fact.");
    }, 120_000);

    it("labels an unpublished ctx_search tool as infrastructure failure", async () => {
        const harness = await createHarness(mcOffOptions());
        const sessionId = await harness.createSession();

        await expect(scriptedCtxSearchTurn(harness, sessionId, "oracle query")).rejects.toThrow(
            "scripted tool infrastructure error: tool ctx_search was never published",
        );
    }, 120_000);
});
