import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDirectTestDatabase } from "../../../plugin/src/features/magic-context/test-database";
import { closeQuietly } from "../../../plugin/src/shared/sqlite-helpers";
import { parseScenario, type DreamerEvalScenario } from "./contract";
import { seedDreamerEvalTask } from "./seeder";

const CORPUS_DIR = join(import.meta.dir, "../../dreamer-eval/dev");

function corpusFiles(): string[] {
    return readdirSync(CORPUS_DIR)
        .filter((file) => file.endsWith(".json"))
        .sort();
}

function parseCorpus(): DreamerEvalScenario[] {
    return corpusFiles().map((file) => parseScenario(JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")), file));
}

describe("dreamer eval dev corpus", () => {
    test("every scenario validates and its filename matches its id", () => {
        const scenarios = parseCorpus();
        expect(scenarios.length).toBeGreaterThan(0);
        expect(corpusFiles()).toEqual(scenarios.map((scenario) => `${scenario.id}.json`).sort());
    });

    test("core pool covers every required maintenance pressure", () => {
        const core = parseCorpus().find((scenario) => scenario.id === "dme-core-pool");
        expect(core).toBeDefined();
        const contents = core!.pool.claims.map((claim) => claim.content.toLowerCase()).join("\n");
        for (const marker of [
            "semantic duplicate",
            "near duplicate",
            "stale fixture",
            "contradiction",
            "false but fluent",
            "file-independent",
            "rejected alternative",
            "branch-specific",
        ]) {
            expect(contents).toContain(marker);
        }
        expect(core!.tasks.map((task) => task.task).sort()).toEqual(["classify-memories", "map-memories", "verify"]);
    });

    test("verify-broad has seeded history and a declared broad partition", () => {
        const broad = parseCorpus().find((scenario) => scenario.id === "dme-verify-broad-history");
        expect(broad?.tasks).toHaveLength(1);
        const task = broad!.tasks[0]!;
        expect(task.task).toBe("verify-broad");
        expect(task.expectedResultMode).toBe("broad");
        expect(task.preconditions.verifications.length).toBeGreaterThan(0);
        expect(task.expectedInScopeClaimIds.length + task.expectedSkippedClaimIds.length).toBe(
            broad!.pool.claims.length,
        );
    });

    test("production preflight accepts every declared scenario task", async () => {
        for (const scenario of parseCorpus()) {
            for (const task of scenario.tasks) {
                const database = createDirectTestDatabase().db;
                const workdir = mkdtempSync(join(tmpdir(), "dreamer-eval-corpus-"));
                try {
                    const seeded = await seedDreamerEvalTask({ db: database, scenario, task, workdir });
                    expect(seeded.preflight.inScopeClaimIds.sort()).toEqual([...task.expectedInScopeClaimIds].sort());
                } finally {
                    closeQuietly(database);
                    rmSync(workdir, { recursive: true, force: true });
                }
            }
        }
    });
});
