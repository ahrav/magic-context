/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeQuietly } from "../../../plugin/src/shared/sqlite-helpers";
import { createDirectTestDatabase } from "../../../plugin/src/features/magic-context/test-database";
import { getTaskScheduleState } from "../../../plugin/src/features/magic-context/dreamer/storage-task-schedule";
import type { Database } from "../../../plugin/src/shared/sqlite";
import {
    DREAMER_EVAL_SCENARIO_SCHEMA,
    type DreamerEvalScenario,
    type DreamerTask,
    type DreamerTaskScenario,
} from "./contract";
import {
    assertFixtureFilesCommitted,
    preflightDreamerEvalTask,
    seedDreamerEvalTask,
} from "./seeder";

const VERIFIED_AT = 1_700_000_010_000;
const roots: string[] = [];
const databases: Database[] = [];

function workdir(): string {
    const root = mkdtempSync(join(tmpdir(), "dreamer-eval-seeder-"));
    roots.push(root);
    return root;
}

function database(): Database {
    const db = createDirectTestDatabase().db;
    databases.push(db);
    return db;
}

function task(taskName: DreamerTask): DreamerTaskScenario {
    const all = Array.from({ length: 10 }, (_, index) => `claim-${index}`);
    const mapped = all.slice(0, 9);
    const verifyInScope = mapped.slice(0, 8);
    const expectedInScopeClaimIds =
        taskName === "map-memories" || taskName === "classify-memories"
            ? all
            : verifyInScope;
    return {
        task: taskName,
        preconditions: {
            mappings:
                taskName === "map-memories"
                    ? []
                    : [
                          ...mapped.map((claimId) => ({ claimId, files: ["src/current.ts"] })),
                          { claimId: "claim-9", files: [] },
                      ],
            verifications:
                taskName === "verify" || taskName === "verify-broad"
                    ? [{ claimId: "claim-8", outcome: "verified", verifiedAt: VERIFIED_AT }]
                    : [],
            classifiedClaimIds: [],
        },
        expectedInScopeClaimIds,
        expectedSkippedClaimIds: all.filter((claimId) => !expectedInScopeClaimIds.includes(claimId)),
        expectedResultMode:
            taskName === "verify-broad"
                ? "broad"
                : taskName === "verify"
                  ? "incremental"
                  : null,
        gold:
            taskName === "map-memories"
                ? {
                      kind: "map",
                      claims: all.map((claimId, index) => ({
                          claimId,
                          files: index === 9 ? [] : ["src/current.ts"],
                          independent: index === 9,
                      })),
                  }
                : taskName === "classify-memories"
                  ? {
                        kind: "classify",
                        claims: all.map((claimId) => ({
                            claimId,
                            importance: { min: 40, max: 60 },
                            scope: "project",
                            shareable: false,
                        })),
                    }
                  : {
                        kind: "verify",
                        claims: verifyInScope.map((claimId) => ({
                            claimId,
                            verdict: "verified",
                            requiredUpdateAnchors: [],
                            forbiddenUpdateAnchors: [],
                        })),
                    },
    };
}

function scenario(taskName: DreamerTask): DreamerEvalScenario {
    const selectedTask = task(taskName);
    return {
        schema: DREAMER_EVAL_SCENARIO_SCHEMA,
        id: `dme-${taskName.replaceAll("-", "")}`,
        title: `${taskName} fixture`,
        pressureRoles: [],
        pool: {
            claims: Array.from({ length: 10 }, (_, index) => ({
                id: `claim-${index}`,
                content: `Distinct memory ${index} with load-bearing value ${index}.`,
                category: "ARCHITECTURE",
                importance: 50,
                memoryScope: "project",
                sharing: "private",
                hygieneVisible: true,
                fileIndependent: index === 9,
                fixtureFiles:
                    index === 9
                        ? []
                        : [{ path: "src/current.ts", content: "export const current = 2;\n" }],
            })),
        },
        tasks: [selectedTask],
    };
}

afterEach(() => {
    for (const db of databases.splice(0)) closeQuietly(db);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("dreamer eval seeder", () => {
    test("seeds distinct production claims and derives the snapshot projection", async () => {
        const result = await seedDreamerEvalTask({
            db: database(),
            scenario: scenario("verify"),
            task: task("verify"),
            workdir: workdir(),
        });

        expect(new Set(Object.values(result.publicClaimIds))).toHaveLength(10);
        expect(result.pool.claims).toHaveLength(10);
        expect(result.preflight.inScopeClaimIds).toEqual(task("verify").expectedInScopeClaimIds);
        expect(result.preflight.skippedClaimIds).toEqual(task("verify").expectedSkippedClaimIds);
        expect(result.pool.claims.find((claim) => claim.claimId === "claim-8")).toMatchObject({
            files: ["src/current.ts"],
            verificationOutcome: "verified",
        });
        expect(result.pool.claims.find((claim) => claim.claimId === "claim-9")?.files).toEqual([]);
    });

    test("fails loudly when normalized claim creation deduplicates two rows", async () => {
        const duplicate = scenario("map-memories");
        duplicate.pool.claims[1]!.content = `  ${duplicate.pool.claims[0]!.content.toUpperCase()}  `;

        await expect(
            seedDreamerEvalTask({
                db: database(),
                scenario: duplicate,
                task: duplicate.tasks[0]!,
                workdir: workdir(),
            }),
        ).rejects.toThrow("ERROR:fixture-drift: normalized claim dedup");
    });

    test("uses production map and classify selection without model calls", async () => {
        for (const taskName of ["map-memories", "classify-memories"] as const) {
            const selectedScenario = scenario(taskName);
            const result = await seedDreamerEvalTask({
                db: database(),
                scenario: selectedScenario,
                task: selectedScenario.tasks[0]!,
                workdir: workdir(),
            });
            expect(result.preflight.inScopeClaimIds).toEqual(
                selectedScenario.tasks[0]!.expectedInScopeClaimIds,
            );
            expect(result.preflight.skippedClaimIds).toEqual([]);
        }
    });

    test("keeps broad preflight lease-free and schedule-byte-stable", async () => {
        const db = database();
        const selectedScenario = scenario("verify-broad");
        const selectedTask = selectedScenario.tasks[0]!;
        const result = await seedDreamerEvalTask({
            db,
            scenario: selectedScenario,
            task: selectedTask,
            workdir: workdir(),
        });
        const before = JSON.stringify(
            getTaskScheduleState(db, result.projectIdentity, "verify-broad"),
        );

        const repeated = await preflightDreamerEvalTask({
            db,
            projectIdentity: result.projectIdentity,
            workdir: result.workdir,
            task: selectedTask,
            publicClaimIds: result.publicClaimIds,
        });

        expect(repeated.mode).toBe("broad");
        expect(JSON.stringify(getTaskScheduleState(db, result.projectIdentity, "verify-broad"))).toBe(
            before,
        );
    });

    test("reports gate mismatch before any invocation surface exists", async () => {
        const selectedScenario = scenario("verify");
        const selectedTask = selectedScenario.tasks[0]!;
        selectedTask.expectedInScopeClaimIds = selectedTask.expectedInScopeClaimIds.slice(1);
        selectedTask.expectedSkippedClaimIds = [
            ...selectedTask.expectedSkippedClaimIds,
            "claim-0",
        ];

        await expect(
            seedDreamerEvalTask({
                db: database(),
                scenario: selectedScenario,
                task: selectedTask,
                workdir: workdir(),
            }),
        ).rejects.toThrow("ERROR:gate-mismatch");
    });

    test("names a fixture file changed after its commit", async () => {
        const selectedScenario = scenario("map-memories");
        const result = await seedDreamerEvalTask({
            db: database(),
            scenario: selectedScenario,
            task: selectedScenario.tasks[0]!,
            workdir: workdir(),
        });
        writeFileSync(join(result.workdir, "src/current.ts"), "export const current = 3;\n");

        expect(() => assertFixtureFilesCommitted(result.workdir, ["src/current.ts"])).toThrow(
            "ERROR:fixture-drift: fixture file is not committed: src/current.ts",
        );
    });
});
