/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "../../../shared/sqlite.ts";
import { closeQuietly } from "../../../shared/sqlite-helpers.ts";
import {
    CLAIMS_BACKFILL_FAILPOINT_IDS,
    CLAIMS_MIGRATION_FAILPOINT_IDS,
    clearClaimsBackfillFailpoints,
    getClaimsBackfillStatus,
    runClaimsBackfill,
    setClaimsBackfillCalibrationForTests,
    setClaimsBackfillFailpoint,
} from "../claims-backfill.ts";
import { runMigrations } from "../migrations.ts";
import { initializeDatabase } from "../storage-db.ts";
import { CLAIMS_BACKFILL_META_KEYS } from "../storage-memory-claims-schema.ts";
import { MEMORY_CLAIM_FAILPOINT_IDS } from "./storage-memory-claims.ts";

const REPO_ROOT = existsSync(resolve(process.cwd(), "packages", "plugin"))
    ? process.cwd()
    : resolve(process.cwd(), "../..");
const EVIDENCE_PATH = resolve(REPO_ROOT, "docs/evidence/claims-backfill/v83-process-crash.json");
const WORKER_SOURCE = resolve(
    REPO_ROOT,
    "packages/plugin/src/features/magic-context/memory/fixtures/claims-crash-worker.ts",
);
const IMPLEMENTATION_FILES = [
    "ARCHITECTURE.md",
    "STRUCTURE.md",
    "docs/migration-version-lanes.md",
    "packages/cli/src/lib/migration-import-guard.test.ts",
    "packages/e2e-tests/src/harness.ts",
    "packages/e2e-tests/src/opencode-runner/spawn.ts",
    "packages/e2e-tests/src/pi-harness.ts",
    "packages/e2e-tests/tests/cache-invariants.test.ts",
    "packages/e2e-tests/tests/compaction-off.test.ts",
    "packages/e2e-tests/tests/emergency-blocking.test.ts",
    "packages/e2e-tests/tests/historian-success.test.ts",
    "packages/e2e-tests/tests/long-running-session.test.ts",
    "packages/e2e-tests/tests/memory-injection.test.ts",
    "packages/e2e-tests/tests/overflow-recovery.test.ts",
    "packages/e2e-tests/tests/pi-cache-invariants.test.ts",
    "packages/e2e-tests/tests/pi-cross-harness.test.ts",
    "packages/e2e-tests/tests/pi-long-running-session.test.ts",
    "packages/e2e-tests/tests/pi-memory-injection.test.ts",
    "packages/e2e-tests/tests/slow-historian.test.ts",
    "packages/pi-plugin/PARITY.md",
    "packages/plugin/src/features/magic-context/dreamer/task-gates.test.ts",
    "packages/plugin/src/features/magic-context/memory/fixtures/claims-crash-worker.ts",
    "packages/plugin/src/features/magic-context/memory/storage-memory-claims-crash.test.ts",
    "packages/plugin/src/features/magic-context/memory/storage-memory-claims.ts",
    "packages/plugin/src/features/magic-context/mural/resolve-mural.test.ts",
    "packages/plugin/src/features/magic-context/search.test.ts",
    "packages/plugin/src/hooks/magic-context/module-state-sync.test.ts",
] as const;

interface RuntimeSpec {
    name: "bun" | "node";
    command: string;
    worker: string;
}

interface CrashResult {
    reached: boolean;
    acted: boolean;
    acknowledged: boolean;
}

interface CampaignEntry {
    runtime: RuntimeSpec["name"];
    site: string;
    scenario: string;
    planned: true;
    reached: true;
    acted: true;
    recovered: true;
    checked: true;
    acknowledgement: "observed" | "not-observed" | "ambiguous";
    recoveredState: string;
    semanticDigest: string;
}

interface SemanticSnapshot {
    schemaVersion: number;
    memories: Array<Record<string, unknown>>;
    stats: Array<Record<string, unknown>>;
    links: Array<Record<string, unknown>>;
    revisions: Array<Record<string, unknown>>;
    evidence: Array<Record<string, unknown>>;
    verifications: Array<Record<string, unknown>>;
    operations: Array<Record<string, unknown>>;
    outbox: Array<Record<string, unknown>>;
    generations: Array<Record<string, unknown>>;
    conflicts: Array<Record<string, unknown>>;
    lineage: Array<Record<string, unknown>>;
    failures: Array<Record<string, unknown>>;
    backfillMeta: Array<Record<string, unknown>>;
    mutationLogCount: number;
}

let rootDir = "";
let nodeBundle = "";

const close = (db: Database): void => closeQuietly(db);

beforeAll(() => {
    rootDir = mkdtempSync(join(tmpdir(), "claims-crash-campaign-"));
    nodeBundle = join(rootDir, "claims-crash-worker.mjs");
    const build = Bun.spawnSync([
        process.execPath,
        "build",
        WORKER_SOURCE,
        "--outfile",
        nodeBundle,
        "--target",
        "node",
        "--format",
        "esm",
        "--external",
        "node:sqlite",
    ]);
    if (build.exitCode !== 0) {
        throw new Error(`Node worker bundle failed: ${build.stderr.toString()}`);
    }
});

afterAll(() => {
    clearClaimsBackfillFailpoints();
    setClaimsBackfillCalibrationForTests(null);
    rmSync(rootDir, { recursive: true, force: true });
});

function runtimes(): RuntimeSpec[] {
    return [
        { name: "bun", command: process.execPath, worker: WORKER_SOURCE },
        { name: "node", command: process.env.NODE ?? "node", worker: nodeBundle },
    ];
}

function parseWorkerLine(line: string): Record<string, unknown> | null {
    const prefix = "CLAIMS_CRASH ";
    if (!line.startsWith(prefix)) return null;
    return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
}

function crashWorker(
    runtime: RuntimeSpec,
    command: string,
    dbPath: string,
    site: string,
): Promise<CrashResult> {
    return new Promise((resolvePromise, reject) => {
        const child: ChildProcessWithoutNullStreams = spawn(
            runtime.command,
            [runtime.worker, command, dbPath, site],
            { stdio: ["pipe", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        let pending = "";
        let reached = false;
        let acted = false;
        let acknowledged = false;
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`${runtime.name}/${site} timed out\n${stdout}\n${stderr}`));
        }, 20_000);

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
                if (event.event === "acknowledged") acknowledged = true;
                if (event.event === "reached") {
                    if (event.site !== site) {
                        child.kill("SIGKILL");
                        reject(new Error(`worker reached ${String(event.site)}, expected ${site}`));
                        return;
                    }
                    reached = true;
                    child.stdin.write("act\n");
                }
                if (event.event === "act-ready") {
                    acted = child.kill("SIGKILL");
                }
            }
        });
        child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once("exit", (code, signal) => {
            clearTimeout(timeout);
            if (!reached || !acted || signal !== "SIGKILL" || code !== null) {
                reject(
                    new Error(
                        `${runtime.name}/${site} did not complete reach/act/SIGKILL handshake: ${JSON.stringify({ code, signal, reached, acted })}\n${stdout}\n${stderr}`,
                    ),
                );
                return;
            }
            resolvePromise({ reached, acted, acknowledged });
        });
    });
}

function runWorker(
    runtime: RuntimeSpec,
    command: string,
    dbPath: string,
): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(runtime.command, [runtime.worker, command, dbPath], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let done: Record<string, unknown> | null = null;
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`${runtime.name}/${command} timed out\n${stdout}\n${stderr}`));
        }, 30_000);
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
            for (const line of stdout.split("\n")) {
                const event = parseWorkerLine(line);
                if (event?.event === "done") done = event;
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

function openFixture(path: string): Database {
    const db = new Database(path);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    return db;
}

function insertLegacyRows(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT OR REPLACE INTO schema_migrations_meta (key, value)
        VALUES ('v22_legacy_memory_backfill', 'completed');
    `);
    const insert = db.prepare(
        `INSERT INTO memories
            (project_path, category, content, normalized_hash, importance, scope, shareable,
             source_type, first_seen_at, created_at, updated_at, last_seen_at, status,
             verification_status, verified_at, merged_from, superseded_by_memory_id, metadata_json)
         VALUES ('git:claims-crash', 'CONSTRAINTS', ?, ?, 73, 'ecosystem', 1,
                 'historian', 11, 12, 13, 14, 'active', 'unverified', NULL, NULL, ?,
                 '{"retained":true}')`,
    );
    insert.run("canonical crash fact", "hash:canonical", null);
    insert.run("superseded crash fact", "hash:superseded", 1);
}

function prepareEmptyV83(path: string): void {
    const db = openFixture(path);
    try {
        initializeDatabase(db);
        runMigrations(db);
    } finally {
        close(db);
    }
}

function prepareLegacy(path: string, migrate: boolean): void {
    const db = openFixture(path);
    try {
        initializeDatabase(db);
        insertLegacyRows(db);
        if (migrate) runMigrations(db);
    } finally {
        close(db);
    }
}

async function prepareRelationshipPhase(path: string): Promise<void> {
    prepareLegacy(path, true);
    const db = openFixture(path);
    const stop = new Error("stop after committed setup batch");
    setClaimsBackfillFailpoint("claims-backfill.020.batch-commit.after", () => {
        throw stop;
    });
    try {
        while (getClaimsBackfillStatus(db).phase !== "relationships") {
            try {
                await runClaimsBackfill(db, { batchSize: 1, yieldToEventLoop: async () => {} });
            } catch (error) {
                if (error !== stop) throw error;
            }
        }
    } finally {
        clearClaimsBackfillFailpoints();
        close(db);
    }
}

function tableExists(db: Database, table: string): boolean {
    return Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
    );
}

function rows(db: Database, sql: string): Array<Record<string, unknown>> {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
}

function semanticSnapshot(path: string): SemanticSnapshot {
    const db = openFixture(path);
    try {
        const schemaVersion = (
            db
                .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
                .get() as {
                version: number;
            }
        ).version;
        const compat = tableExists(db, "legacy_memory_claims");
        return {
            schemaVersion,
            memories: rows(
                db,
                `SELECT id, project_path, category, content, hex(CAST(content AS BLOB)) AS content_hex,
                        normalized_hash, importance, scope, shareable, source_type, status,
                        verification_status, superseded_by_memory_id, merged_from, metadata_json
                   FROM memories ORDER BY id`,
            ),
            stats: tableExists(db, "memory_stats")
                ? rows(
                      db,
                      `SELECT memory_id, seen_count, retrieval_count, last_seen_at, last_retrieved_at
                         FROM memory_stats ORDER BY memory_id`,
                  )
                : [],
            links: compat
                ? rows(
                      db,
                      `SELECT memory_id, canonical_memory_id, claim_id, project_id, root_observation_id
                         FROM legacy_memory_claims ORDER BY memory_id`,
                  )
                : [],
            revisions: compat
                ? rows(
                      db,
                      `SELECT lmc.memory_id, c.id AS claim_id, c.state, r.id AS revision_id,
                              r.revision, r.content, r.content_sha256, m.category, m.normalized_hash,
                              m.importance, m.memory_scope, m.shareable, m.source_type,
                              m.expires_at, m.metadata_json
                         FROM legacy_memory_claims lmc
                         JOIN claims c ON c.id = lmc.claim_id
                         JOIN claim_revisions r ON r.claim_id = c.id
                         JOIN claim_revision_memory_metadata m ON m.revision_id = r.id
                        ORDER BY lmc.memory_id, r.revision`,
                  )
                : [],
            evidence: compat
                ? rows(
                      db,
                      `SELECT ce.revision_id, ce.observation_id, ce.relation
                         FROM claim_evidence ce ORDER BY ce.revision_id, ce.observation_id`,
                  )
                : [],
            verifications: compat
                ? rows(
                      db,
                      `SELECT revision_id, observation_id, outcome, verifier
                         FROM verification_events ORDER BY id`,
                  )
                : [],
            operations: compat
                ? rows(
                      db,
                      `SELECT id, producer, operation_key, request_digest,
                              expected_effect_count, result_json
                         FROM claim_operations ORDER BY id`,
                  )
                : [],
            outbox: compat
                ? rows(
                      db,
                      `SELECT id, operation_id, effect_key, project_id, claim_id,
                              effect_type, generation
                         FROM claim_change_outbox ORDER BY id`,
                  )
                : [],
            generations: compat
                ? rows(
                      db,
                      `SELECT project_id, generation
                         FROM claim_project_generations ORDER BY project_id`,
                  )
                : [],
            conflicts: compat
                ? rows(
                      db,
                      `SELECT relation, left_revision_id, right_revision_id
                         FROM claim_conflicts ORDER BY id`,
                  )
                : [],
            lineage: compat
                ? rows(
                      db,
                      `SELECT source_revision_id, source_project_id,
                              target_revision_id, target_project_id
                         FROM claim_merge_lineage ORDER BY id`,
                  )
                : [],
            failures: compat
                ? rows(
                      db,
                      `SELECT phase, item_kind, item_key, reason_code, disposition, rationale
                         FROM claim_backfill_failures ORDER BY phase, item_kind, item_key`,
                  )
                : [],
            backfillMeta: tableExists(db, "schema_migrations_meta")
                ? rows(
                      db,
                      `SELECT key, value FROM schema_migrations_meta
                        WHERE key LIKE 'claims_backfill_%' ORDER BY key`,
                  )
                : [],
            mutationLogCount: tableExists(db, "memory_mutation_log")
                ? (
                      db.prepare("SELECT COUNT(*) AS count FROM memory_mutation_log").get() as {
                          count: number;
                      }
                  ).count
                : 0,
        };
    } finally {
        close(db);
    }
}

function digest(snapshot: SemanticSnapshot): string {
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function meta(snapshot: SemanticSnapshot, key: string): string | null {
    const entry = snapshot.backfillMeta.find((row) => row.key === key);
    return typeof entry?.value === "string" ? entry.value : null;
}

function assertMemoryTuple(snapshot: SemanticSnapshot, committed: boolean): void {
    expect(snapshot.schemaVersion).toBe(83);
    expect(snapshot.memories).toHaveLength(committed ? 1 : 0);
    expect(snapshot.links).toHaveLength(committed ? 1 : 0);
    expect(snapshot.revisions).toHaveLength(committed ? 1 : 0);
    expect(snapshot.evidence).toHaveLength(committed ? 1 : 0);
    expect(snapshot.operations).toHaveLength(committed ? 1 : 0);
    expect(snapshot.outbox).toHaveLength(committed ? 1 : 0);
    expect(snapshot.generations).toHaveLength(committed ? 1 : 0);
    expect(snapshot.mutationLogCount).toBe(0);
    if (!committed) return;
    expect(snapshot.memories[0]).toMatchObject({
        content: "crash-safe claim tuple",
        content_hex: Buffer.from("crash-safe claim tuple").toString("hex").toUpperCase(),
        normalized_hash: "hash:crash-safe-claim-tuple",
        status: "active",
    });
    expect(snapshot.revisions[0]).toMatchObject({
        content: "crash-safe claim tuple",
        content_sha256: createHash("sha256").update("crash-safe claim tuple").digest("hex"),
        normalized_hash: "hash:crash-safe-claim-tuple",
        state: "active",
    });
    expect(snapshot.operations[0]).toMatchObject({ expected_effect_count: 1 });
    expect(snapshot.outbox[0]).toMatchObject({ effect_type: "upsert", generation: 1 });
    expect(snapshot.generations[0]).toMatchObject({ generation: 1 });
}

function assertBackfillCut(snapshot: SemanticSnapshot, scenario: string): void {
    expect(snapshot.schemaVersion).toBe(83);
    if (scenario === "lazy-row-uncommitted") {
        expect(snapshot.links).toHaveLength(0);
        expect(meta(snapshot, CLAIMS_BACKFILL_META_KEYS.phase)).toBe("rows");
        expect(meta(snapshot, CLAIMS_BACKFILL_META_KEYS.rowsCursor)).toBe("0");
    } else if (scenario === "lazy-relationship-uncommitted") {
        expect(snapshot.links).toHaveLength(2);
        expect(snapshot.conflicts).toHaveLength(0);
        expect(meta(snapshot, CLAIMS_BACKFILL_META_KEYS.phase)).toBe("relationships");
        expect(meta(snapshot, CLAIMS_BACKFILL_META_KEYS.relationshipsCursor)).toBe("0");
    } else if (scenario === "lazy-batch-committed") {
        expect(snapshot.links).toHaveLength(1);
        expect(snapshot.operations).toHaveLength(1);
        expect(meta(snapshot, CLAIMS_BACKFILL_META_KEYS.phase)).toBe("rows");
        expect(meta(snapshot, CLAIMS_BACKFILL_META_KEYS.rowsCursor)).toBe("1");
    } else if (scenario === "lazy-completion-uncommitted") {
        expect(snapshot.links).toHaveLength(2);
        expect(snapshot.conflicts).toHaveLength(1);
        expect(meta(snapshot, CLAIMS_BACKFILL_META_KEYS.phase)).toBe("reconciling");
        expect(meta(snapshot, CLAIMS_BACKFILL_META_KEYS.reconciliationVersion)).toBeNull();
    } else {
        expect(snapshot.links).toHaveLength(2);
        expect(snapshot.conflicts).toHaveLength(1);
        expect(meta(snapshot, CLAIMS_BACKFILL_META_KEYS.phase)).toBe("complete");
        expect(meta(snapshot, CLAIMS_BACKFILL_META_KEYS.reconciliationVersion)).toBe("1");
    }
}

function prepareEagerReference(path: string): void {
    prepareLegacy(path, false);
    const db = openFixture(path);
    setClaimsBackfillCalibrationForTests({ cutoffRows: 10, evidenceDigest: "e".repeat(64) });
    try {
        runMigrations(db);
    } finally {
        setClaimsBackfillCalibrationForTests(null);
        close(db);
    }
}

async function prepareLazyReference(path: string): Promise<void> {
    prepareLegacy(path, true);
    const db = openFixture(path);
    try {
        const result = await runClaimsBackfill(db, {
            batchSize: 1,
            yieldToEventLoop: async () => {},
        });
        expect(result.status).toBe("complete");
    } finally {
        close(db);
    }
}

function implementationDigest(): string {
    const hash = createHash("sha256");
    for (const path of IMPLEMENTATION_FILES) {
        hash.update(path);
        hash.update("\0");
        hash.update(readFileSync(resolve(REPO_ROOT, path)));
        hash.update("\0");
    }
    return hash.digest("hex");
}

function gitHead(): string {
    const result = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
}

function nodeVersion(): string {
    const result = Bun.spawnSync([process.env.NODE ?? "node", "--version"]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
}

function evidenceReport(
    matrix: CampaignEntry[],
    sqliteVersions: Record<RuntimeSpec["name"], string>,
): Record<string, unknown> {
    const stats = statfsSync(rootDir);
    return {
        schemaVersion: "claims-process-crash-evidence/v1",
        commitUnderTest: gitHead(),
        dirtyDiffDigestPolicy:
            "sha256(sorted U6 implementation path + NUL + full file bytes + NUL); evidence file excluded",
        dirtyDiffDigest: implementationDigest(),
        implementationFiles: IMPLEMENTATION_FILES,
        runtimes: {
            bun: { version: Bun.version, sqliteVersion: sqliteVersions.bun },
            node: { version: nodeVersion(), sqliteVersion: sqliteVersions.node },
        },
        environment: {
            os: platform(),
            release: release(),
            arch: arch(),
            filesystem: {
                type: stats.type.toString(16),
                blockSize: stats.bsize,
                campaignRoot:
                    "OS temporary directory; same live database path and WAL sidecars reopened",
            },
        },
        summary: {
            planned: matrix.length,
            reached: matrix.filter((entry) => entry.reached).length,
            acted: matrix.filter((entry) => entry.acted).length,
            recovered: matrix.filter((entry) => entry.recovered).length,
            checked: matrix.filter((entry) => entry.checked).length,
            byRuntime: Object.fromEntries(
                runtimes().map((runtime) => [
                    runtime.name,
                    matrix.filter((entry) => entry.runtime === runtime.name).length,
                ]),
            ),
        },
        matrix,
        acknowledgementWitness:
            "Supervisor-owned: observed only after an explicit worker acknowledgement event; not-observed before that event; ambiguous where no response acknowledgement exists.",
        limits: [
            "Process crash by SIGKILL only.",
            "No host power-loss claim.",
            "No instantaneous disk-image claim.",
            "No torn-write claim.",
            "No storage-controller-cache claim.",
            "No exactly-once external delivery claim.",
        ],
    };
}

function verifyOrWriteEvidence(report: Record<string, unknown>): void {
    if (process.env.UPDATE_CLAIMS_CRASH_EVIDENCE === "1") {
        writeFileSync(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`);
        return;
    }
    expect(existsSync(EVIDENCE_PATH)).toBeTrue();
    const checked = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as Record<string, unknown>;
    expect(checked.schemaVersion).toBe(report.schemaVersion);
    expect(checked.dirtyDiffDigest).toBe(report.dirtyDiffDigest);
    expect(checked.implementationFiles).toEqual(report.implementationFiles);
    expect(checked.matrix).toEqual(report.matrix);
    expect(checked.limits).toEqual(report.limits);
    expect(checked.summary).toEqual(report.summary);
    expect(checked.commitUnderTest).toMatch(/^[0-9a-f]{40}$/);
    expect(checked.runtimes).toMatchObject({
        bun: { version: expect.any(String), sqliteVersion: expect.any(String) },
        node: { version: expect.any(String), sqliteVersion: expect.any(String) },
    });
    expect(checked.environment).toMatchObject({
        os: expect.any(String),
        release: expect.any(String),
        arch: expect.any(String),
        filesystem: { type: expect.any(String), blockSize: expect.any(Number) },
    });
}

describe("v83 process-crash matrix", () => {
    test("reaches, kills, reopens, recovers, and checks every stable Bun and Node cut", async () => {
        const matrix: CampaignEntry[] = [];
        const sqliteVersions = { bun: "", node: "" };
        const lazyReferencePath = join(rootDir, "lazy-reference.db");
        await prepareLazyReference(lazyReferencePath);
        const lazyReferenceDigest = digest(semanticSnapshot(lazyReferencePath));
        const eagerReferencePath = join(rootDir, "eager-reference.db");
        prepareEagerReference(eagerReferencePath);
        const eagerReferenceDigest = digest(semanticSnapshot(eagerReferencePath));

        for (const runtime of runtimes()) {
            for (const site of MEMORY_CLAIM_FAILPOINT_IDS) {
                const dbPath = join(rootDir, `${runtime.name}-${site}.db`);
                prepareEmptyV83(dbPath);
                const crash = await crashWorker(runtime, "crash-memory", dbPath, site);
                const committed =
                    site === "memory-claim.060.commit.after" ||
                    site === "memory-claim.070.ack.after";
                const afterKill = semanticSnapshot(dbPath);
                assertMemoryTuple(afterKill, committed);
                const afterKillDigest = digest(afterKill);
                const reopened = await runWorker(runtime, "reopen", dbPath);
                sqliteVersions[runtime.name] = String(reopened.sqliteVersion);
                expect(digest(semanticSnapshot(dbPath))).toBe(afterKillDigest);
                if (site === "memory-claim.060.commit.after") {
                    await runWorker(runtime, "recover-memory", dbPath);
                    assertMemoryTuple(semanticSnapshot(dbPath), true);
                    expect(digest(semanticSnapshot(dbPath))).toBe(afterKillDigest);
                }
                await runWorker(runtime, "reopen", dbPath);
                expect(digest(semanticSnapshot(dbPath))).toBe(afterKillDigest);
                const acknowledgement =
                    site === "memory-claim.070.ack.after" ? "observed" : "not-observed";
                expect(crash.acknowledged).toBe(acknowledgement === "observed");
                matrix.push({
                    runtime: runtime.name,
                    site,
                    scenario: site,
                    planned: true,
                    reached: true,
                    acted: true,
                    recovered: true,
                    checked: true,
                    acknowledgement,
                    recoveredState: committed ? "complete-new-tuple" : "complete-old-tuple",
                    semanticDigest: afterKillDigest,
                });
            }

            const backfillCases = [
                {
                    site: "claims-backfill.010.batch.after",
                    scenario: "lazy-row-uncommitted",
                    prepare: (path: string) => prepareLegacy(path, true),
                },
                {
                    site: "claims-backfill.010.batch.after",
                    scenario: "lazy-relationship-uncommitted",
                    prepare: prepareRelationshipPhase,
                },
                {
                    site: "claims-backfill.020.batch-commit.after",
                    scenario: "lazy-batch-committed",
                    prepare: (path: string) => prepareLegacy(path, true),
                },
                {
                    site: "claims-backfill.030.complete.before",
                    scenario: "lazy-completion-uncommitted",
                    prepare: (path: string) => prepareLegacy(path, true),
                },
                {
                    site: "claims-backfill.040.complete.after",
                    scenario: "lazy-completion-committed",
                    prepare: (path: string) => prepareLegacy(path, true),
                },
            ] as const;
            for (const [index, entry] of backfillCases.entries()) {
                const dbPath = join(rootDir, `${runtime.name}-backfill-${index}.db`);
                await entry.prepare(dbPath);
                const crash = await crashWorker(runtime, "crash-backfill", dbPath, entry.site);
                expect(crash.acknowledged).toBeFalse();
                assertBackfillCut(semanticSnapshot(dbPath), entry.scenario);
                await runWorker(runtime, "recover-backfill", dbPath);
                const recovered = semanticSnapshot(dbPath);
                expect(digest(recovered)).toBe(lazyReferenceDigest);
                const stableDigest = digest(recovered);
                await runWorker(runtime, "recover-backfill", dbPath);
                expect(digest(semanticSnapshot(dbPath))).toBe(stableDigest);
                matrix.push({
                    runtime: runtime.name,
                    site: entry.site,
                    scenario: entry.scenario,
                    planned: true,
                    reached: true,
                    acted: true,
                    recovered: true,
                    checked: true,
                    acknowledgement: "ambiguous",
                    recoveredState: "lazy-resumed-to-uninterrupted-digest",
                    semanticDigest: stableDigest,
                });
            }

            for (const site of CLAIMS_MIGRATION_FAILPOINT_IDS) {
                const dbPath = join(rootDir, `${runtime.name}-${site}.db`);
                prepareLegacy(dbPath, false);
                const crash = await crashWorker(runtime, "crash-migration", dbPath, site);
                expect(crash.acknowledged).toBeFalse();
                const committed = site === "claims-migration.050.commit.after";
                const afterKill = semanticSnapshot(dbPath);
                expect(afterKill.schemaVersion).toBe(committed ? 83 : 82);
                expect(compatSchemaExists(dbPath)).toBe(committed);
                if (committed) {
                    expect(meta(afterKill, CLAIMS_BACKFILL_META_KEYS.phase)).toBe("complete");
                } else {
                    expect(afterKill.links).toHaveLength(0);
                }
                await runWorker(runtime, "recover-migration", dbPath);
                const recovered = semanticSnapshot(dbPath);
                expect(digest(recovered)).toBe(eagerReferenceDigest);
                const stableDigest = digest(recovered);
                await runWorker(runtime, "recover-migration", dbPath);
                expect(digest(semanticSnapshot(dbPath))).toBe(stableDigest);
                matrix.push({
                    runtime: runtime.name,
                    site,
                    scenario: site,
                    planned: true,
                    reached: true,
                    acted: true,
                    recovered: true,
                    checked: true,
                    acknowledgement: "ambiguous",
                    recoveredState: committed
                        ? "complete-v83-roll-forward"
                        : "complete-v82-rerun-to-v83",
                    semanticDigest: stableDigest,
                });
            }
        }

        for (const runtime of runtimes()) {
            const runtimeEntries = matrix.filter((entry) => entry.runtime === runtime.name);
            expect(runtimeEntries).toHaveLength(17);
            expect(new Set(runtimeEntries.map((entry) => entry.site))).toEqual(
                new Set([
                    ...MEMORY_CLAIM_FAILPOINT_IDS,
                    ...CLAIMS_BACKFILL_FAILPOINT_IDS,
                    ...CLAIMS_MIGRATION_FAILPOINT_IDS,
                ]),
            );
        }
        verifyOrWriteEvidence(evidenceReport(matrix, sqliteVersions));
    }, 180_000);
});

function compatSchemaExists(path: string): boolean {
    const db = openFixture(path);
    try {
        return tableExists(db, "legacy_memory_claims");
    } finally {
        close(db);
    }
}
