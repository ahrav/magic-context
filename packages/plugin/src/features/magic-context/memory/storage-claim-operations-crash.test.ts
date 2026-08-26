import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "../../../shared/sqlite.ts";
import { closeQuietly } from "../../../shared/sqlite-helpers.ts";
import { listSchemaObjectNames } from "../storage-current-schema.ts";
import { readDirectFormatMarker } from "../storage-format-epoch.ts";
import { computeExpectedDirectFormat, createDirectTestDatabase } from "../test-database.ts";
import { ensureProject } from "./storage-claims.ts";

const REPO_ROOT = existsSync(resolve(process.cwd(), "packages", "plugin"))
    ? process.cwd()
    : resolve(process.cwd(), "../..");
const WORKER_SOURCE = resolve(
    REPO_ROOT,
    "packages/plugin/src/features/magic-context/memory/fixtures/claim-operations-crash-worker.ts",
);
const PREFIX = "CLAIM_OPERATION_CRASH ";
const PROJECT = "git:u8-claim-operation-crash";
const PRODUCER = "u8-claim-operation-crash";
const OPERATION_KEY = "create-direct-claim-v1";
const OPERATION_CONTENT = "U8 process-crash direct claim";

interface RuntimeSpec {
    name: "bun" | "node";
    command: string;
    worker: string;
}

interface WorkerDone {
    event: "done";
    command: string;
    incarnation?: string;
    outcome?: string;
    replayed?: boolean;
    resultJson?: string;
}

interface CrashResult {
    reached: boolean;
    armed: boolean;
}

interface SemanticSnapshot {
    projects: unknown[];
    claims: unknown[];
    revisions: unknown[];
    evidence: unknown[];
    attributes: unknown[];
    lifecycle: unknown[];
    heads: unknown[];
    telemetry: unknown[];
    applicabilityStreams: unknown[];
    applicabilityAssertions: unknown[];
    applicabilityPaths: unknown[];
    policySubjects: unknown[];
    maturity: unknown[];
    effectivePolicy: unknown[];
    receipts: unknown[];
    effects: unknown[];
    generations: unknown[];
}

let campaignDir = "";
let nodeWorker = "";

beforeAll(() => {
    campaignDir = mkdtempSync(join(tmpdir(), "mc-u8-claim-crash-"));
    nodeWorker = join(campaignDir, "claim-operations-crash-worker.mjs");
    const build = Bun.spawnSync([
        process.execPath,
        "build",
        WORKER_SOURCE,
        "--outfile",
        nodeWorker,
        "--target",
        "node",
        "--format",
        "esm",
        "--external",
        "node:sqlite",
    ]);
    if (build.exitCode !== 0) {
        throw new Error(`Node crash worker bundle failed: ${build.stderr.toString()}`);
    }
});

afterAll(() => {
    rmSync(campaignDir, { recursive: true, force: true });
});

function runtimes(): RuntimeSpec[] {
    return [
        { name: "bun", command: process.execPath, worker: WORKER_SOURCE },
        { name: "node", command: process.env.NODE ?? "node", worker: nodeWorker },
    ];
}

function parseWorkerLine(line: string): Record<string, unknown> | null {
    if (!line.startsWith(PREFIX)) return null;
    return JSON.parse(line.slice(PREFIX.length)) as Record<string, unknown>;
}

function crashWorker(
    runtime: RuntimeSpec,
    command: "bootstrap" | "operation",
    dbPath: string,
    site: string,
): Promise<CrashResult> {
    return new Promise((resolvePromise, reject) => {
        const child: ChildProcessWithoutNullStreams = spawn(
            runtime.command,
            [runtime.worker, command, dbPath, site],
            { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test" } },
        );
        let stdout = "";
        let stderr = "";
        let pending = "";
        let reached = false;
        let armed = false;
        let settled = false;
        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            child.kill("SIGKILL");
            reject(error);
        };
        const timeout = setTimeout(
            () => fail(new Error(`${runtime.name}/${site} timed out\n${stdout}\n${stderr}`)),
            20_000,
        );

        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stdout += text;
            pending += text;
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
                const event = parseWorkerLine(line);
                if (!event) continue;
                if (event.event === "reached") {
                    if (event.site !== site) {
                        fail(new Error(`worker reached ${String(event.site)}, expected ${site}`));
                        return;
                    }
                    reached = true;
                    child.stdin.write("arm\n");
                } else if (event.event === "armed") {
                    if (event.site !== site) {
                        fail(new Error(`worker armed ${String(event.site)}, expected ${site}`));
                        return;
                    }
                    armed = true;
                    child.kill("SIGKILL");
                }
            }
        });
        child.once("error", (error) => fail(error));
        child.once("exit", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (!reached || !armed || signal !== "SIGKILL" || code !== null) {
                reject(
                    new Error(
                        `${runtime.name}/${site} missed reach/arm/SIGKILL handshake: ${JSON.stringify({ code, signal, reached, armed })}\n${stdout}\n${stderr}`,
                    ),
                );
                return;
            }
            resolvePromise({ reached, armed });
        });
    });
}

function runWorker(
    runtime: RuntimeSpec,
    command: "bootstrap-recover" | "operation-recover",
    dbPath: string,
): Promise<WorkerDone> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(runtime.command, [runtime.worker, command, dbPath], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, NODE_ENV: "test" },
        });
        let stdout = "";
        let stderr = "";
        let pending = "";
        let done: WorkerDone | null = null;
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`${runtime.name}/${command} timed out\n${stdout}\n${stderr}`));
        }, 30_000);
        child.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stdout += text;
            pending += text;
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
                const event = parseWorkerLine(line);
                if (event?.event === "done") done = event as unknown as WorkerDone;
            }
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once("exit", (code, signal) => {
            clearTimeout(timeout);
            if (code !== 0 || signal !== null || !done) {
                reject(
                    new Error(
                        `${runtime.name}/${command} failed: ${JSON.stringify({ code, signal })}\n${stdout}\n${stderr}`,
                    ),
                );
                return;
            }
            resolvePromise(done);
        });
    });
}

function fixturePath(label: string): string {
    const dir = mkdtempSync(join(campaignDir, `${label}-`));
    return join(dir, "context.db");
}

function rows(db: Database, sql: string): unknown[] {
    return db.prepare(sql).all() as unknown[];
}

function semanticSnapshot(dbPath: string): SemanticSnapshot {
    const db = new Database(dbPath);
    try {
        db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
        return {
            projects: rows(
                db,
                "SELECT canonical_identity AS identity FROM projects ORDER BY canonical_identity",
            ),
            claims: rows(
                db,
                "SELECT public_id, claims.state FROM claims JOIN claim_public_ids ON claim_public_ids.claim_id = claims.id ORDER BY public_id",
            ),
            revisions: rows(
                db,
                "SELECT public_id, revision, content, content_sha256 FROM claim_revisions JOIN claim_public_ids ON claim_public_ids.claim_id = claim_revisions.claim_id ORDER BY public_id, revision",
            ),
            evidence: rows(
                db,
                "SELECT public_id, relation, observations.independence_key FROM claim_evidence JOIN claim_revisions ON claim_revisions.id = claim_evidence.revision_id JOIN claim_public_ids ON claim_public_ids.claim_id = claim_revisions.claim_id JOIN observations ON observations.id = claim_evidence.observation_id ORDER BY public_id, observations.independence_key",
            ),
            attributes: rows(
                db,
                "SELECT public_id, category, normalized_hash, importance, memory_scope, sharing, expires_at FROM claim_memory_revision_attributes JOIN claim_public_ids ON claim_public_ids.claim_id = claim_memory_revision_attributes.claim_id ORDER BY public_id, revision_id",
            ),
            lifecycle: rows(
                db,
                "SELECT public_id, seq, state, actor FROM claim_memory_lifecycle_events JOIN claim_public_ids ON claim_public_ids.claim_id = claim_memory_lifecycle_events.claim_id ORDER BY public_id, seq",
            ),
            heads: rows(
                db,
                "SELECT public_id, category, normalized_hash, lifecycle_state FROM claim_memory_current_heads JOIN claim_public_ids ON claim_public_ids.claim_id = claim_memory_current_heads.claim_id ORDER BY public_id",
            ),
            telemetry: rows(
                db,
                "SELECT public_id, seen_count, retrieval_count FROM claim_usage_stats JOIN claim_public_ids ON claim_public_ids.claim_id = claim_usage_stats.claim_id ORDER BY public_id",
            ),
            applicabilityStreams: rows(
                db,
                "SELECT public_id, claim_revisions.revision, stream_key, owner_kind FROM claim_revision_applicability_streams JOIN claim_revisions ON claim_revisions.id = claim_revision_applicability_streams.revision_id JOIN claim_public_ids ON claim_public_ids.claim_id = claim_revisions.claim_id ORDER BY public_id, claim_revisions.revision, stream_key",
            ),
            applicabilityAssertions: rows(
                db,
                "SELECT public_id, claim_revisions.revision, stream_key, claim_revision_applicability_assertions.seq, paths_state FROM claim_revision_applicability_assertions JOIN claim_revision_applicability_streams ON claim_revision_applicability_streams.id = claim_revision_applicability_assertions.stream_id JOIN claim_revisions ON claim_revisions.id = claim_revision_applicability_streams.revision_id JOIN claim_public_ids ON claim_public_ids.claim_id = claim_revisions.claim_id ORDER BY public_id, claim_revisions.revision, stream_key, claim_revision_applicability_assertions.seq",
            ),
            applicabilityPaths: rows(
                db,
                "SELECT public_id, claim_revisions.revision, stream_key, claim_revision_applicability_assertions.seq, kind, value FROM claim_revision_applicability_paths JOIN claim_revision_applicability_assertions ON claim_revision_applicability_assertions.id = claim_revision_applicability_paths.assertion_id JOIN claim_revision_applicability_streams ON claim_revision_applicability_streams.id = claim_revision_applicability_assertions.stream_id JOIN claim_revisions ON claim_revisions.id = claim_revision_applicability_streams.revision_id JOIN claim_public_ids ON claim_public_ids.claim_id = claim_revisions.claim_id ORDER BY public_id, claim_revisions.revision, stream_key, claim_revision_applicability_assertions.seq, kind, value",
            ),
            policySubjects: rows(
                db,
                "SELECT public_id, origin_taint FROM claim_revision_policy_subjects JOIN claim_revisions ON claim_revisions.id = claim_revision_policy_subjects.revision_id JOIN claim_public_ids ON claim_public_ids.claim_id = claim_revisions.claim_id ORDER BY public_id, claim_revisions.revision",
            ),
            maturity: rows(
                db,
                "SELECT public_id, claim_maturity_assertions.seq, maturity FROM claim_maturity_assertions JOIN claim_maturity_streams ON claim_maturity_streams.id = claim_maturity_assertions.stream_id JOIN claim_revisions ON claim_revisions.id = claim_maturity_streams.revision_id JOIN claim_public_ids ON claim_public_ids.claim_id = claim_revisions.claim_id ORDER BY public_id, claim_maturity_assertions.seq",
            ),
            effectivePolicy: rows(
                db,
                "SELECT public_id, effective_maturity, auto_eligible, explicit_eligible, generation FROM claim_effective_policy JOIN claim_revisions ON claim_revisions.id = claim_effective_policy.revision_id JOIN claim_public_ids ON claim_public_ids.claim_id = claim_revisions.claim_id ORDER BY public_id",
            ),
            receipts: rows(
                db,
                "SELECT producer, operation_key, request_digest, outcome, expected_effect_count, effect_summary_json, generation_vector_json, result_json FROM claim_operation_receipts ORDER BY producer, operation_key",
            ),
            effects: rows(
                db,
                "SELECT producer, operation_key, effect_key, change_kind, generation, public_id FROM claim_operation_effects JOIN claim_operation_receipts ON claim_operation_receipts.id = claim_operation_effects.receipt_id JOIN claim_public_ids ON claim_public_ids.claim_id = claim_operation_effects.claim_id ORDER BY producer, operation_key, effect_key",
            ),
            generations: rows(
                db,
                "SELECT projects.canonical_identity AS identity, generation FROM claim_project_generations JOIN projects ON projects.id = claim_project_generations.project_id ORDER BY projects.canonical_identity",
            ),
        };
    } finally {
        closeQuietly(db);
    }
}

function assertRecoveredImage(dbPath: string): void {
    const db = new Database(dbPath);
    try {
        const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{
            integrity_check: string;
        }>;
        expect(integrity).toEqual([{ integrity_check: "ok" }]);
        const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
        expect(foreignKeys).toEqual([]);
    } finally {
        closeQuietly(db);
    }
}

function prepareOperationFixture(label: string): { dbPath: string; baseline: SemanticSnapshot } {
    const dbPath = fixturePath(label);
    const { db } = createDirectTestDatabase({ path: dbPath });
    try {
        ensureProject(db, PROJECT);
    } finally {
        closeQuietly(db);
    }
    return { dbPath, baseline: semanticSnapshot(dbPath) };
}

function assertOneCompleteOperation(snapshot: SemanticSnapshot): void {
    expect(snapshot.claims).toHaveLength(1);
    expect(snapshot.revisions).toHaveLength(1);
    expect(snapshot.evidence).toHaveLength(1);
    expect(snapshot.attributes).toHaveLength(1);
    expect(snapshot.lifecycle).toHaveLength(1);
    expect(snapshot.heads).toHaveLength(1);
    expect(snapshot.telemetry).toHaveLength(1);
    expect(snapshot.applicabilityStreams).toHaveLength(1);
    expect(snapshot.applicabilityAssertions).toHaveLength(1);
    expect(snapshot.applicabilityPaths).toHaveLength(0);
    expect(snapshot.policySubjects).toHaveLength(1);
    expect(snapshot.maturity).toHaveLength(2);
    expect(snapshot.effectivePolicy).toHaveLength(1);
    expect(snapshot.receipts).toHaveLength(1);
    expect(snapshot.effects).toHaveLength(1);
    expect(snapshot.generations).toEqual([{ identity: PROJECT, generation: 1 }]);
    expect(snapshot.revisions).toEqual([
        expect.objectContaining({ content: OPERATION_CONTENT, revision: 1 }),
    ]);
    expect(snapshot.receipts).toEqual([
        expect.objectContaining({
            producer: PRODUCER,
            operation_key: OPERATION_KEY,
            outcome: "applied",
            expected_effect_count: 1,
        }),
    ]);
}

describe("U8 process-crash/live-kernel recovery only (not power-loss durability)", () => {
    test("bootstrap SIGKILL cuts recover from pristine or one complete direct format", async () => {
        const expectedInventory = computeExpectedDirectFormat().schemaObjectNames;
        for (const runtime of runtimes()) {
            for (const site of ["bootstrap.before-open", "bootstrap.after-commit-before-ack"]) {
                const dbPath = fixturePath(`${runtime.name}-${site}`);
                const crash = await crashWorker(runtime, "bootstrap", dbPath, site);
                expect(crash).toEqual({ reached: true, armed: true });
                if (site === "bootstrap.before-open") expect(existsSync(dbPath)).toBe(false);

                const recovered = await runWorker(runtime, "bootstrap-recover", dbPath);
                expect(recovered.incarnation).toMatch(/^[0-9a-f]{32}$/);
                const db = new Database(dbPath);
                try {
                    expect(listSchemaObjectNames(db)).toEqual(expectedInventory);
                    const marker = readDirectFormatMarker(db);
                    expect(marker.status).toBe("present");
                    if (marker.status === "present") {
                        expect(marker.marker.databaseIncarnationId).toBe(recovered.incarnation);
                    }
                } finally {
                    closeQuietly(db);
                }
                assertRecoveredImage(dbPath);
            }
        }
    }, 120_000);

    test("claim-operation pre-commit cuts restore old complete state; post-commit/pre-ack replays once", async () => {
        const sites = [
            "operation.before-stage",
            "operation.after-stage",
            "operation.after-commit-before-ack",
        ] as const;
        for (const runtime of runtimes()) {
            for (const site of sites) {
                const fixture = prepareOperationFixture(`${runtime.name}-${site}`);
                await expect(
                    crashWorker(runtime, "operation", fixture.dbPath, site),
                ).resolves.toEqual({ reached: true, armed: true });

                const afterCrash = semanticSnapshot(fixture.dbPath);
                if (site === "operation.after-commit-before-ack") {
                    assertOneCompleteOperation(afterCrash);
                } else {
                    expect(afterCrash).toEqual(fixture.baseline);
                }
                assertRecoveredImage(fixture.dbPath);

                const recovered = await runWorker(runtime, "operation-recover", fixture.dbPath);
                expect(recovered.outcome).toBe("applied");
                expect(recovered.replayed).toBe(site === "operation.after-commit-before-ack");
                const complete = semanticSnapshot(fixture.dbPath);
                assertOneCompleteOperation(complete);
                if (site === "operation.after-commit-before-ack") {
                    expect(complete).toEqual(afterCrash);
                    expect(recovered.resultJson).toBe(
                        (afterCrash.receipts[0] as { result_json: string }).result_json,
                    );
                }
                assertRecoveredImage(fixture.dbPath);
            }
        }
    }, 120_000);

    test("concurrent identical Bun/Node operations converge on one stored result and effect", async () => {
        const fixture = prepareOperationFixture("concurrent-identical");
        const [bun, node] = runtimes();
        const results = await Promise.all([
            runWorker(bun!, "operation-recover", fixture.dbPath),
            runWorker(node!, "operation-recover", fixture.dbPath),
        ]);
        expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
        expect(results[0]?.resultJson).toBe(results[1]?.resultJson);
        assertOneCompleteOperation(semanticSnapshot(fixture.dbPath));
        assertRecoveredImage(fixture.dbPath);
    }, 60_000);
});
