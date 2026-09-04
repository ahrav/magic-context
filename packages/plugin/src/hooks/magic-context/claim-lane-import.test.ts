import { describe, expect, test } from "bun:test";
import {
    ANTI_MEMORY_DEFAULT_TTL_MS,
    parseAntiMemoryContent,
} from "../../features/magic-context/memory/anti-memory-content";
import { ANTI_MEMORY_CATEGORY } from "../../features/magic-context/memory/constants";
import { createAntiMemory } from "../../features/magic-context/memory/storage-anti-memory";
import { createProjectMemoryClaim } from "../../features/magic-context/memory/storage-claim-operations";
import { ensureProject } from "../../features/magic-context/memory/storage-claims";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import { KernelClient, sha256Hex } from "../../shared/kernel-client";
import { FakeKernel, FakeKernelTransport } from "../../shared/kernel-client-testing/fake-kernel";
import type { Database } from "../../shared/sqlite";
import {
    CLAIM_LANE_IMPORT_SOURCE_ID,
    claimLaneImportDone,
    claimLaneImportGeneration,
    importClaimLaneMemories,
    importedObjectId,
    listClaimLaneMemories,
    resetClaimLaneImportMarker,
    resetClaimLaneImportScheduleForTest,
    scheduleClaimLaneImport,
} from "./claim-lane-import";

const PROJECT = "git:import-project";
const OTHER_PROJECT = "git:other-project";
const ROOT = "/repo/import";

/** The current-state reader revalidates its snapshot vector after hydration; moving the generation between the two reads makes exactly one read answer `stale`, reproducing a writer landing mid-read. commentlint: allow(JUDGE) */
function forceStaleSnapshotOnce(db: Database): void {
    const rawPrepare = db.prepare.bind(db);
    let armed = true;
    (db as { prepare: Database["prepare"] }).prepare = ((sql: string) => {
        const stmt = rawPrepare(sql);
        if (!armed || !sql.includes("claim_project_generations") || !sql.startsWith("SELECT")) {
            return stmt;
        }
        return {
            run: stmt.run.bind(stmt),
            all: stmt.all.bind(stmt),
            get: (...args: unknown[]) => {
                const row = stmt.get(...(args as never[]));
                if (armed) {
                    armed = false;
                    rawPrepare(
                        "UPDATE claim_project_generations SET generation = generation + 1",
                    ).run();
                }
                return row;
            },
        };
    }) as Database["prepare"];
}

function seedClaim(
    db: Database,
    project: string,
    key: string,
    content: string,
    category = "ARCHITECTURE",
): string {
    const projectId = ensureProject(db, project);
    const result = createProjectMemoryClaim(
        db,
        { producer: "test", operationKey: `${project}:${key}` },
        {
            projectId,
            content,
            category,
            provenance: {
                sourceLocator: "transcript://seed",
                sourceContent: content,
                extractor: "historian",
                extractorVersion: "2",
                extractorRunId: "run-1",
                independenceKey: `ik-${key}`,
                sourceTrustClass: "model_inference",
            },
            actor: "user:test",
        },
    );
    return (result.result.payload as { claim: { publicClaimId: string } }).claim.publicClaimId;
}

/** Seeds a lane anti-memory whose expiry defaults to `nowMs + ANTI_MEMORY_DEFAULT_TTL_MS`; the lane keeps that expiry in a column, never in the rendered content. commentlint: allow(JUDGE) */
function seedAntiMemory(db: Database, project: string, key: string, nowMs: number): string {
    const projectId = ensureProject(db, project);
    const result = createAntiMemory(
        db,
        { producer: "test", operationKey: `${project}:${key}` },
        {
            projectId,
            payload: {
                trigger: "session caching work",
                rejectedStrategy: "use Redis",
                rejectionReason: "it creates split ownership",
                saferAlternative: "use SQLite",
            },
            provenance: {
                sourceLocator: `transcript://${key}`,
                sourceContent: `source ${key}`,
                extractor: "test",
                extractorVersion: "1",
                extractorRunId: `run-${key}`,
                independenceKey: `ik-${key}`,
                sourceTrustClass: "model_inference",
            },
            actor: "user:test",
            nowMs,
        },
    );
    return (result.result.payload as { claim: { publicClaimId: string } }).claim.publicClaimId;
}

function harness() {
    const db = createDirectTestDatabase({ path: ":memory:" }).db;
    const kernel = new FakeKernel();
    const transport = new FakeKernelTransport(kernel);
    const client = new KernelClient({
        transport,
        enabled: true,
        sessionId: "s1",
        projectRoot: "/repo/import",
    });
    return { db, kernel, transport, client };
}

describe("claim-lane import", () => {
    test("lists only the project's own active claims", () => {
        const { db } = harness();
        seedClaim(db, PROJECT, "a", "Own claim A.");
        seedClaim(db, OTHER_PROJECT, "b", "Foreign claim B.");
        const listed = listClaimLaneMemories(db, PROJECT);
        expect(listed?.map((claim) => claim.content)).toEqual(["Own claim A."]);
    });

    test("a stale claim-lane snapshot lists as null, defers, and leaves the marker unset", async () => {
        const { db, kernel, transport, client } = harness();
        seedClaim(db, PROJECT, "a", "Own claim A.");
        forceStaleSnapshotOnce(db);
        expect(listClaimLaneMemories(db, PROJECT)).toBeNull();

        forceStaleSnapshotOnce(db);
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("deferred");
        expect(claimLaneImportDone(db, PROJECT, ROOT)).toBe(false);
        expect(transport.calls).toHaveLength(0);
        expect(kernel.liveRows()).toHaveLength(0);

        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        expect(claimLaneImportDone(db, PROJECT, ROOT)).toBe(true);
        expect(kernel.liveRows()).toHaveLength(1);
    });

    test("imports once, marks the project done, and replays cleanly", async () => {
        const { db, kernel, transport, client } = harness();
        const first = seedClaim(db, PROJECT, "a", "Own claim A.");
        const second = seedClaim(db, PROJECT, "b", "Own claim B.");

        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        expect(claimLaneImportDone(db, PROJECT, ROOT)).toBe(true);
        const live = kernel.liveRows();
        expect(live.map((row) => row.object_id).sort()).toEqual(
            [importedObjectId(first, ROOT), importedObjectId(second, ROOT)].sort(),
        );
        expect(live.every((row) => row.source_id === CLAIM_LANE_IMPORT_SOURCE_ID)).toBe(true);
        expect(live.every((row) => row.source_kind === "model")).toBe(true);

        const commitsBefore = transport.methods().filter((m) => m === "kernel.commit").length;
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("skipped");
        expect(transport.methods().filter((m) => m === "kernel.commit").length).toBe(commitsBefore);
    });

    test("a partial earlier run resumes without re-inserting present objects", async () => {
        const { db, kernel, client } = harness();
        const first = seedClaim(db, PROJECT, "a", "Own claim A.");
        seedClaim(db, PROJECT, "b", "Own claim B.");
        kernel.seedDecision({
            object_id: importedObjectId(first, ROOT),
            decision_kind: "ARCHITECTURE",
            summary: "Own claim A.",
        });
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        expect(kernel.liveRows()).toHaveLength(2);
    });

    test("an unavailable kernel defers and leaves the marker unset", async () => {
        const { db, kernel, client } = harness();
        seedClaim(db, PROJECT, "a", "Own claim A.");
        kernel.surfaceStates.set("explicit_search", {
            kind: "unavailable",
            reason: "store_starting",
        });
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("deferred");
        expect(claimLaneImportDone(db, PROJECT, ROOT)).toBe(false);
        expect(kernel.liveRows()).toHaveLength(0);
    });

    test("a project with no claims is marked done without dialing the daemon", async () => {
        const { db, transport, client } = harness();
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        expect(transport.calls).toHaveLength(0);
        expect(claimLaneImportDone(db, PROJECT, ROOT)).toBe(true);
    });

    test("a legacy-category active claim imports with its category as the decision kind", async () => {
        const { db, kernel, client } = harness();
        seedClaim(db, PROJECT, "a", "Prefers tabs over spaces.", "USER_PREFERENCES");
        seedClaim(db, PROJECT, "b", "CI requires two approvals.", "WORKFLOW_RULES");
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        const kinds = kernel
            .liveRows()
            .map((row) => row.decision?.decision_kind)
            .sort();
        expect(kinds).toEqual(["USER_PREFERENCES", "WORKFLOW_RULES"]);
    });

    test("an imported anti-memory carries the lane's expiry as an Expires at line", async () => {
        const { db, kernel, client } = harness();
        const createdAt = Date.now();
        const publicId = seedAntiMemory(db, PROJECT, "anti", createdAt);
        const laneExpiry = createdAt + ANTI_MEMORY_DEFAULT_TTL_MS;
        const listed = listClaimLaneMemories(db, PROJECT);
        expect(listed?.[0]?.expiresAt).toBe(laneExpiry);
        expect(listed?.[0]?.content).not.toContain("Expires at:");

        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        const row = kernel.liveRows()[0];
        expect(row?.object_id).toBe(importedObjectId(publicId, ROOT));
        expect(row?.decision?.decision_kind).toBe(ANTI_MEMORY_CATEGORY);
        const summary = row?.decision?.payload.summary ?? "";
        expect(summary).toContain(`Expires at: ${laneExpiry}`);
        expect(parseAntiMemoryContent(summary).expiresAt).toBe(laneExpiry);
    });

    test("an anti-memory already live under its import id replays without churn", async () => {
        const { db, kernel, transport, client } = harness();
        const createdAt = Date.now();
        const publicId = seedAntiMemory(db, PROJECT, "anti", createdAt);
        const laneContent = listClaimLaneMemories(db, PROJECT)?.[0]?.content ?? "";
        // An existing import whose summary lacks the expiry line stays verbatim.
        kernel.seedDecision({
            object_id: importedObjectId(publicId, ROOT),
            decision_kind: ANTI_MEMORY_CATEGORY,
            summary: laneContent,
            domain_id: "memory",
            source_kind: "model",
            source_id: CLAIM_LANE_IMPORT_SOURCE_ID,
        });

        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        expect(transport.methods().filter((m) => m === "kernel.commit")).toHaveLength(0);
        expect(kernel.liveRows()).toHaveLength(1);
        expect(kernel.liveRows()[0]?.decision?.payload.summary).toBe(laneContent);
    });

    test("a project marked done under the pre-widening marker key re-imports once", async () => {
        const { db, kernel, transport, client } = harness();
        db.prepare("INSERT INTO context_store_meta(key, value) VALUES (?, ?)").run(
            `kernel_claim_lane_import:${sha256Hex(PROJECT).slice(0, 32)}`,
            JSON.stringify({ importedAt: 1, imported: 1 }),
        );
        const imported = seedClaim(db, PROJECT, "a", "Own claim A.");
        seedClaim(db, PROJECT, "b", "Legacy directive.", "USER_DIRECTIVES");
        kernel.seedDecision({
            object_id: importedObjectId(imported, ROOT),
            decision_kind: "ARCHITECTURE",
            summary: "Own claim A.",
            domain_id: "memory",
            source_kind: "model",
            source_id: CLAIM_LANE_IMPORT_SOURCE_ID,
        });

        expect(claimLaneImportDone(db, PROJECT, ROOT)).toBe(false);
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        expect(kernel.liveRows()).toHaveLength(2);
        expect(kernel.liveRows().map((row) => row.decision?.payload.summary)).toContain(
            "Legacy directive.",
        );

        const commitsBefore = transport.methods().filter((m) => m === "kernel.commit").length;
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("skipped");
        expect(transport.methods().filter((m) => m === "kernel.commit").length).toBe(commitsBefore);
        expect(kernel.liveRows()).toHaveLength(2);
    });

    test("a reset after archiving an imported memory re-imports the rest instead of aborting", async () => {
        const { db, kernel, client } = harness();
        const archived = seedClaim(db, PROJECT, "a", "Own claim A.");
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        const archivedId = importedObjectId(archived, ROOT);
        await client.archive(archivedId, {
            actor: "user:test",
            operationId: "archive-1",
            cause: "test archive",
        });
        expect(kernel.liveRows()).toHaveLength(0);

        // The daemon holds no receipt for the original import, so the
        // re-insert reaches the registry and answers `already_exists`
        // instead of replaying.
        kernel.receipts.clear();
        resetClaimLaneImportMarker(db, PROJECT, ROOT);
        seedClaim(db, PROJECT, "b", "Own claim B.");
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        expect(claimLaneImportDone(db, PROJECT, ROOT)).toBe(true);
        // The archived memory stays retired; only the later claim is live.
        expect(kernel.liveRows().map((row) => row.decision?.payload.summary)).toEqual([
            "Own claim B.",
        ]);
    });

    test("a reset replay whose import receipt survives replays the insert without resurrecting the archived row", async () => {
        const { db, kernel, client } = harness();
        const archived = seedClaim(db, PROJECT, "a", "Own claim A.");
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        await client.archive(importedObjectId(archived, ROOT), {
            actor: "user:test",
            operationId: "archive-1",
            cause: "test archive",
        });
        resetClaimLaneImportMarker(db, PROJECT, ROOT);
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        expect(claimLaneImportDone(db, PROJECT, ROOT)).toBe(true);
        expect(kernel.liveRows()).toHaveLength(0);
    });

    test("a marker reset clears the schedule done-pin so the next schedule re-runs", async () => {
        const { db, kernel, client } = harness();
        resetClaimLaneImportScheduleForTest();
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        scheduleClaimLaneImport({
            db,
            client,
            projectPath: PROJECT,
            projectRoot: ROOT,
            sessionId: "s1",
        });

        seedClaim(db, PROJECT, "a", "Fact from a failed promotion.");
        resetClaimLaneImportMarker(db, PROJECT, ROOT);
        expect(claimLaneImportDone(db, PROJECT, ROOT)).toBe(false);

        scheduleClaimLaneImport({
            db,
            client,
            projectPath: PROJECT,
            projectRoot: ROOT,
            sessionId: "s1",
        });
        for (let waited = 0; waited < 200 && kernel.liveRows().length === 0; waited++) {
            await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(kernel.liveRows()).toHaveLength(1);
        expect(kernel.liveRows()[0]?.decision?.payload.summary).toBe(
            "Fact from a failed promotion.",
        );
        resetClaimLaneImportScheduleForTest();
    });

    test("a marker reset during an in-flight import fences the stale done write", async () => {
        const { db, kernel, client } = harness();
        seedClaim(db, PROJECT, "a", "Own claim A.");
        // The reset lands while the importer awaits its commit: after the
        // claims snapshot, before the done write.
        kernel.beforeCommit = () => {
            resetClaimLaneImportMarker(db, PROJECT, ROOT);
            kernel.beforeCommit = null;
        };
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("deferred");
        // The stale run committed its batch but must not mark the replay done.
        expect(claimLaneImportDone(db, PROJECT, ROOT)).toBe(false);
        expect(kernel.liveRows()).toHaveLength(1);

        // A claim that arrives after the reset migrates on the next run.
        seedClaim(db, PROJECT, "b", "Fact from a failed promotion.");
        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        expect(claimLaneImportDone(db, PROJECT, ROOT)).toBe(true);
        expect(kernel.liveRows()).toHaveLength(2);
    });

    test("a reset between runs bumps the generation so an old-generation done write is ignored", () => {
        const { db } = harness();
        expect(claimLaneImportGeneration(db, PROJECT, ROOT)).toBe(0);
        resetClaimLaneImportMarker(db, PROJECT, ROOT);
        expect(claimLaneImportGeneration(db, PROJECT, ROOT)).toBe(1);
        resetClaimLaneImportMarker(db, PROJECT, ROOT);
        expect(claimLaneImportGeneration(db, PROJECT, ROOT)).toBe(2);
    });

    test("two checkouts sharing a root-commit identity each import into their own kernel scope", async () => {
        const { db, client } = harness();
        const otherKernel = new FakeKernel();
        const otherClient = new KernelClient({
            transport: new FakeKernelTransport(otherKernel),
            enabled: true,
            sessionId: "s1",
            projectRoot: "/repo/import-second",
        });
        const claim = seedClaim(db, PROJECT, "a", "Own claim A.");

        expect(
            await importClaimLaneMemories({
                db,
                client,
                projectPath: PROJECT,
                projectRoot: ROOT,
                sessionId: "s1",
            }),
        ).toBe("done");
        // The first checkout's marker does not cover the second checkout.
        expect(claimLaneImportDone(db, PROJECT, ROOT)).toBe(true);
        expect(claimLaneImportDone(db, PROJECT, "/repo/import-second")).toBe(false);

        expect(
            await importClaimLaneMemories({
                db,
                client: otherClient,
                projectPath: PROJECT,
                projectRoot: "/repo/import-second",
                sessionId: "s1",
            }),
        ).toBe("done");
        expect(otherKernel.liveRows()).toHaveLength(1);
        // Object ids differ per checkout root, so both scopes' rows coexist in one store.
        expect(importedObjectId(claim, ROOT)).not.toBe(
            importedObjectId(claim, "/repo/import-second"),
        );
        expect(otherKernel.liveRows()[0]?.object_id).toBe(
            importedObjectId(claim, "/repo/import-second"),
        );
    });
});
