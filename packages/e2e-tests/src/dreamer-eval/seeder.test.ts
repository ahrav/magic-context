/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    // Broad re-sweeps verified mapped claims.
    // Incremental skips the freshly verified claim.
    const expectedInScopeClaimIds =
        taskName === "map-memories" || taskName === "classify-memories"
            ? all
            : taskName === "verify-broad"
              ? mapped
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
                        claims: expectedInScopeClaimIds.map((claimId) => ({
                            claimId,
                            verdict: "verified",
                            expectedFiles: ["src/current.ts"],
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
        // Incremental skips the seeded verification.
        // Broad re-sweeps the seeded verification; incremental skips it.
        // Broad orders candidates by verifiedAt then public id, so compare sets.
        expect(repeated.inScopeClaimIds).toContain("claim-8");
        expect([...repeated.inScopeClaimIds].sort()).toEqual(
            [...task("verify-broad").expectedInScopeClaimIds].sort(),
        );
        expect(repeated.inScopeClaimIds.length).toBeGreaterThan(
            task("verify").expectedInScopeClaimIds.length,
        );
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

    test("ignores unrelated untracked harness files", async () => {
        const selectedScenario = scenario("map-memories");
        const result = await seedDreamerEvalTask({
            db: database(),
            scenario: selectedScenario,
            task: selectedScenario.tasks[0]!,
            workdir: workdir(),
        });
        writeFileSync(join(result.workdir, "harness-output.log"), "unrelated\n");
        expect(() => assertFixtureFilesCommitted(result.workdir, ["src/current.ts"])).not.toThrow();
    });

    test("refuses fixture paths that target the git control directory", async () => {
        const selectedScenario = scenario("map-memories");
        selectedScenario.pool.claims[0]!.fixtureFiles = [
            { path: ".git/hooks/pre-commit", content: "#!/bin/sh\nexit 1\n" },
        ];

        await expect(
            seedDreamerEvalTask({
                db: database(),
                scenario: selectedScenario,
                task: selectedScenario.tasks[0]!,
                workdir: workdir(),
            }),
        ).rejects.toThrow("ERROR:fixture-drift: fixture path targets the git control directory");
    });

    test("refuses an alias of a fixture path already declared by another claim", async () => {
        // Path normalization makes `src/current.ts` and `src/./current.ts` aliases.
        // Two claims could declare different evidence for the same normalized path.
        const selectedScenario = scenario("map-memories");
        selectedScenario.pool.claims[1]!.fixtureFiles = [
            { path: "src/./current.ts", content: "export const current = 99;\n" },
        ];

        await expect(
            seedDreamerEvalTask({
                db: database(),
                scenario: selectedScenario,
                task: selectedScenario.tasks[0]!,
                workdir: workdir(),
            }),
        ).rejects.toThrow("ERROR:fixture-drift: fixture path is not canonical: src/./current.ts");
    });

    test("names the claim whose fixture content contradicts an existing path", async () => {
        const selectedScenario = scenario("map-memories");
        selectedScenario.pool.claims[1]!.fixtureFiles = [
            { path: "src/current.ts", content: "export const current = 99;\n" },
        ];

        await expect(
            seedDreamerEvalTask({
                db: database(),
                scenario: selectedScenario,
                task: selectedScenario.tasks[0]!,
                workdir: workdir(),
            }),
        ).rejects.toThrow("ERROR:fixture-drift: fixture content conflicts for src/current.ts");
    });

    test("seeds a workdir nested inside another repository", async () => {
        // Initialize Git before probing `HEAD` so the probe cannot resolve an ancestor repository.
        // Initialize Git before probing `HEAD` so the probe cannot resolve an ancestor repository.
        const outer = workdir();
        const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
        expect(spawnSync("git", ["init", "--quiet"], { cwd: outer, env }).status).toBe(0);
        expect(
            spawnSync(
                "git",
                ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "outer"],
                { cwd: outer, env },
            ).status,
        ).toBe(0);
        const nested = join(outer, "nested", "work");
        mkdirSync(nested, { recursive: true });

        const selectedScenario = scenario("map-memories");
        const result = await seedDreamerEvalTask({
            db: database(),
            scenario: selectedScenario,
            task: selectedScenario.tasks[0]!,
            workdir: nested,
        });

        expect(result.pool.claims).toHaveLength(10);
        expect(result.preflight.inScopeClaimIds).toEqual(
            selectedScenario.tasks[0]!.expectedInScopeClaimIds,
        );
    });

    test("a claim cannot declare the reserved fixture marker path", async () => {
        const selectedScenario = scenario("verify");
        // Write fixture content before the marker to prevent the marker from replacing it.
        // Rewriting the marker would replace fixture content while the tracked-and-clean commit check still passed.
        selectedScenario.pool.claims[0]!.fixtureFiles = [
            { path: ".dreamer-eval-fixture", content: "not the marker\n" },
        ];

        await expect(
            seedDreamerEvalTask({
                db: database(),
                scenario: selectedScenario,
                task: selectedScenario.tasks[0]!,
                workdir: workdir(),
            }),
        ).rejects.toThrow("ERROR:fixture-drift: fixture path is reserved: .dreamer-eval-fixture");
    });

    test("a fixture file cannot nest under another declared fixture file", async () => {
        const selectedScenario = scenario("verify");
        // Creating a file and a directory at the same path fails with `EEXIST` or `EISDIR`.
        // Without validation, the raw filesystem error escapes the typed fixture-drift path.
        selectedScenario.pool.claims[0]!.fixtureFiles = [{ path: "src/config", content: "a\n" }];
        selectedScenario.pool.claims[1]!.fixtureFiles = [
            { path: "src/config/settings.ts", content: "b\n" },
        ];

        await expect(
            seedDreamerEvalTask({
                db: database(),
                scenario: selectedScenario,
                task: selectedScenario.tasks[0]!,
                workdir: workdir(),
            }),
        ).rejects.toThrow(
            "ERROR:fixture-drift: fixture path src/config/settings.ts nests under declared file src/config",
        );
    });

    test("a claim cannot declare a case alias of the reserved fixture marker", async () => {
        const selectedScenario = scenario("verify");
        // On case-insensitive filesystems, a fixture path differing from the marker only by case aliases the marker.
        // Writing the marker would replace fixture content while the tracked-and-clean commit check still passed.
        selectedScenario.pool.claims[0]!.fixtureFiles = [
            { path: ".DREAMER-EVAL-FIXTURE", content: "not the marker\n" },
        ];

        await expect(
            seedDreamerEvalTask({
                db: database(),
                scenario: selectedScenario,
                task: selectedScenario.tasks[0]!,
                workdir: workdir(),
            }),
        ).rejects.toThrow("ERROR:fixture-drift: fixture path is reserved: .DREAMER-EVAL-FIXTURE");
    });

    test("two fixture paths cannot differ only by case", async () => {
        const selectedScenario = scenario("verify");
        // On case-insensitive filesystems, fixture paths that differ only by case share one file.
        // volume.
        selectedScenario.pool.claims[0]!.fixtureFiles = [{ path: "src/Current.ts", content: "a\n" }];

        await expect(
            seedDreamerEvalTask({
                db: database(),
                scenario: selectedScenario,
                task: selectedScenario.tasks[0]!,
                workdir: workdir(),
            }),
        ).rejects.toThrow("differ only by case");
    });

    test("an authored gitignore cannot suppress another fixture file", async () => {
        const selectedScenario = scenario("verify");
        selectedScenario.pool.claims[0]!.fixtureFiles = [
            { path: ".gitignore", content: "src/current.ts\n" },
        ];
        selectedScenario.tasks[0]!.preconditions.mappings = selectedScenario.tasks[0]!.preconditions.mappings.map(
            (mapping) => (mapping.claimId === "claim-0" ? { ...mapping, files: [".gitignore"] } : mapping),
        );

        const result = await seedDreamerEvalTask({
            db: database(),
            scenario: selectedScenario,
            task: selectedScenario.tasks[0]!,
            workdir: workdir(),
        });

        expect(result.pool.claims).toHaveLength(10);
        assertFixtureFilesCommitted(result.workdir, [".gitignore", "src/current.ts"]);
    });

    test("the contract's latest verification timestamp still seeds", async () => {
        const selectedScenario = scenario("verify");
        const latestAuthorable = 4_102_444_801_999;
        selectedScenario.tasks[0]!.preconditions.verifications = [
            { claimId: "claim-8", outcome: "verified", verifiedAt: latestAuthorable },
        ];

        const result = await seedDreamerEvalTask({
            db: database(),
            scenario: selectedScenario,
            task: selectedScenario.tasks[0]!,
            workdir: workdir(),
        });

        expect(result.fixtureCommitTimeMs).toBe(4_102_444_799_000);
    });

    test("a claim cannot declare a descendant of the fixture marker", async () => {
        const selectedScenario = scenario("verify");
        // Creating a directory at the marker path makes the marker write fail with `EISDIR`.
        // Writing the marker fails with raw `EISDIR` outside the typed fixture-drift path.
        selectedScenario.pool.claims[0]!.fixtureFiles = [
            { path: ".dreamer-eval-fixture/payload", content: "x\n" },
        ];

        await expect(
            seedDreamerEvalTask({
                db: database(),
                scenario: selectedScenario,
                task: selectedScenario.tasks[0]!,
                workdir: workdir(),
            }),
        ).rejects.toThrow("ERROR:fixture-drift: fixture path is reserved: .dreamer-eval-fixture/payload");
    });

    test("reports a result mode the production gate did not return", async () => {
        const selectedScenario = scenario("verify");
        const selectedTask = selectedScenario.tasks[0]!;
        // Changing the mode changes which claims later cycles re-sweep despite the identical initial candidate set.
        selectedTask.expectedResultMode = "full";

        await expect(
            seedDreamerEvalTask({
                db: database(),
                scenario: selectedScenario,
                task: selectedTask,
                workdir: workdir(),
            }),
        ).rejects.toThrow("ERROR:gate-mismatch: result mode: expected full, got incremental");
    });
});
