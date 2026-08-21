#!/usr/bin/env bun

/**
 * Claims-backfill calibration (KTD4): measures the eager v83 conversion over
 * deterministic corpora and writes the evidence artifact
 * `docs/evidence/claims-backfill/v83-threshold.json`. The default bounded run
 * measures 1K/10K and records 100K/1M plus Node as explicit omissions;
 * CLAIMS_BACKFILL_FULL=1 enables all Bun scales.
 *
 * The measured lock duration is the full `runMigrations()` wall time over a
 * populated legacy-baseline database with the eager path forced for the
 * measured scale — the duration a sibling process would wait on the write
 * lock. A per-scale run also re-verifies the completion checkpoint so a
 * conversion that silently failed can never publish a timing.
 *
 * Cutoff policy: the selected cutoff is the largest measured scale whose
 * SLOWEST run stays under 2.5 seconds (half the 5-second sibling busy
 * timeout). The production cutoff in claims-backfill.ts stays 0 until the
 * checked-in evidence passes review; this script never edits code.
 *
 * Scales whose projected runtime exceeds the per-scale budget are skipped and
 * recorded as skipped in the evidence file rather than being extrapolated.
 *
 * Machine-readable JSON goes to stdout ONLY; diagnostics go to stderr.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    computeClaimsBackfillEvidenceDigest,
    getClaimsBackfillStatus,
    setClaimsBackfillCalibrationForTests,
} from "../src/features/magic-context/claims-backfill";
import { runMigrations } from "../src/features/magic-context/migrations";
import { initializeDatabase } from "../src/features/magic-context/storage-db";
import { Database } from "../src/shared/sqlite";

const SCALES = [1_000, 10_000, 100_000, 1_000_000] as const;
const FULL_CALIBRATION = process.env.CLAIMS_BACKFILL_FULL === "1";
const DEFAULT_MAX_SCALE = 10_000;
const RUNS_PER_SCALE = 3;
const SEED = 20_260_818;
const CUTOFF_TARGET_MS = 2_500;
/** Skip a scale when its projected single-run time exceeds this budget. */
const PER_RUN_BUDGET_MS = 300_000;
/** Fraction of rows that supersede a prior row (relationship density). */
const SUPERSEDED_FRACTION = 0.05;
/** Fraction of rows that carry a JSON merged_from array. */
const MERGED_FRACTION = 0.02;
const PROJECT_COUNT = 8;

function splitmix32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x9e3779b9) >>> 0;
        let z = state;
        z ^= z >>> 16;
        z = Math.imul(z, 0x21f0aaad);
        z ^= z >>> 15;
        z = Math.imul(z, 0x735a2d97);
        z ^= z >>> 15;
        return (z >>> 0) / 0x1_0000_0000;
    };
}

const WORDS = [
    "queue",
    "index",
    "vector",
    "cache",
    "commit",
    "schema",
    "shard",
    "token",
    "buffer",
    "cursor",
    "replica",
    "latency",
    "filter",
    "segment",
    "payload",
    "batch",
    "stream",
    "anchor",
    "compaction",
    "retrieval",
] as const;

const CATEGORIES = ["CONSTRAINTS", "ARCHITECTURE", "CONFIG_VALUES", "NAMING", "WORKFLOW"] as const;

interface CorpusStats {
    rows: number;
    supersededRows: number;
    mergedRows: number;
}

/** Build one deterministic legacy-baseline corpus at `scale` rows. */
function buildCorpus(db: Database, scale: number): CorpusStats {
    const random = splitmix32(SEED + scale);
    const insert = db.prepare(
        `INSERT INTO memories
            (project_path, category, content, normalized_hash, importance, seen_count,
             retrieval_count, first_seen_at, created_at, updated_at, last_seen_at,
             status, verification_status, verified_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, 1, 1, 1, 1, ?, ?, ?)`,
    );
    const setSuperseded = db.prepare(
        "UPDATE memories SET superseded_by_memory_id = ?, status = 'archived' WHERE id = ?",
    );
    const setMerged = db.prepare("UPDATE memories SET merged_from = ? WHERE id = ?");
    const stats: CorpusStats = { rows: scale, supersededRows: 0, mergedRows: 0 };
    db.transaction(() => {
        for (let i = 1; i <= scale; i += 1) {
            const wordCount = 12 + Math.floor(random() * 84);
            const words: string[] = [];
            for (let w = 0; w < wordCount; w += 1) {
                words.push(WORDS[Math.floor(random() * WORDS.length)]);
            }
            const verified = random() < 0.1;
            insert.run(
                `git:calibration-${i % PROJECT_COUNT}`,
                CATEGORIES[i % CATEGORIES.length],
                `memory ${i}: ${words.join(" ")}`,
                `hash:${scale}:${i}`,
                1 + Math.floor(random() * 100),
                random() < 0.05 ? "permanent" : "active",
                verified ? "verified" : "unverified",
                verified ? 1 : null,
            );
        }
        for (let i = 2; i <= scale; i += 1) {
            if (random() < SUPERSEDED_FRACTION) {
                setSuperseded.run(i - 1, i);
                stats.supersededRows += 1;
            } else if (i > 3 && random() < MERGED_FRACTION) {
                setMerged.run(JSON.stringify([i - 2, i - 1]), i);
                stats.mergedRows += 1;
            }
        }
    })();
    return stats;
}

interface ScaleMeasurement {
    scale: number;
    rows: number;
    supersededRows: number;
    mergedRows: number;
    relationshipDensity: number;
    runsMs: number[];
    slowestMs: number;
    lockDurationMs: number;
    lockDurationMetric: string;
}

function measureScale(workDir: string, scale: number): ScaleMeasurement {
    const runsMs: number[] = [];
    let stats: CorpusStats = { rows: scale, supersededRows: 0, mergedRows: 0 };
    for (let run = 0; run < RUNS_PER_SCALE; run += 1) {
        const dbPath = join(workDir, `calibration-${scale}-${run}.db`);
        const db = new Database(dbPath);
        try {
            db.exec("PRAGMA foreign_keys=ON");
            initializeDatabase(db);
            db.exec(`
                CREATE TABLE IF NOT EXISTS schema_migrations_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                INSERT OR REPLACE INTO schema_migrations_meta (key, value)
                VALUES ('v22_legacy_memory_backfill', 'completed');
            `);
            stats = buildCorpus(db, scale);
            setClaimsBackfillCalibrationForTests(
                {
                    cutoffRows: scale,
                    evidenceDigest: "f".repeat(64),
                },
                // Measurement must force eager conversion above the shipped
                // ceiling; the ceiling's own justification comes from these runs.
                { bypassCutoffCeilingForMeasurement: true },
            );
            const start = performance.now();
            runMigrations(db);
            const elapsed = performance.now() - start;
            const status = getClaimsBackfillStatus(db);
            if (status.mode !== "eager" || status.state !== "complete") {
                throw new Error(
                    `scale ${scale} run ${run} did not complete eagerly: mode=${status.mode} state=${status.state}`,
                );
            }
            if (status.linkedBoundaryRows !== scale) {
                throw new Error(
                    `scale ${scale} run ${run} linked ${status.linkedBoundaryRows} of ${scale} rows`,
                );
            }
            runsMs.push(Math.round(elapsed * 100) / 100);
            console.error(`[measure] scale=${scale} run=${run} ${elapsed.toFixed(0)}ms`);
        } finally {
            setClaimsBackfillCalibrationForTests(null);
            db.close();
            rmSync(dbPath, { force: true });
            rmSync(`${dbPath}-wal`, { force: true });
            rmSync(`${dbPath}-shm`, { force: true });
        }
    }
    const slowestMs = Math.max(...runsMs);
    return {
        scale,
        rows: stats.rows,
        supersededRows: stats.supersededRows,
        mergedRows: stats.mergedRows,
        relationshipDensity:
            Math.round(((stats.supersededRows + stats.mergedRows) / stats.rows) * 1000) / 1000,
        runsMs,
        slowestMs,
        lockDurationMs: slowestMs,
        lockDurationMetric:
            "full runMigrations() wall time over the populated legacy baseline (forced eager v83); the duration a sibling start would wait",
    };
}

function main(): void {
    const workDir = mkdtempSync(join(tmpdir(), "claims-backfill-calibration-"));
    const measurements: ScaleMeasurement[] = [];
    const skippedScales: Array<{ scale: number; reason: string }> = [];
    try {
        for (const scale of SCALES) {
            if (!FULL_CALIBRATION && scale > DEFAULT_MAX_SCALE) {
                skippedScales.push({
                    scale,
                    reason: "bounded default run omits 100K/1M; rerun with CLAIMS_BACKFILL_FULL=1 for reviewable full-scale evidence",
                });
                continue;
            }
            const previous = measurements[measurements.length - 1];
            if (previous) {
                const projectedMs = (previous.slowestMs * scale) / previous.scale;
                if (projectedMs > PER_RUN_BUDGET_MS) {
                    skippedScales.push({
                        scale,
                        reason: `projected ${Math.round(projectedMs)}ms per run from the ${previous.scale}-row measurement exceeds the ${PER_RUN_BUDGET_MS}ms per-run budget`,
                    });
                    console.error(`[measure] skipping scale=${scale}: projected over budget`);
                    continue;
                }
            }
            measurements.push(measureScale(workDir, scale));
        }
    } finally {
        rmSync(workDir, { recursive: true, force: true });
    }

    const eligible = measurements.filter((m) => m.slowestMs < CUTOFF_TARGET_MS);
    const selectedCutoff = eligible.length > 0 ? Math.max(...eligible.map((m) => m.scale)) : 0;
    let commit = "unknown";
    try {
        commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch {
        console.error("[measure] git rev-parse failed; recording commit=unknown");
    }
    const probe = new Database(":memory:");
    const sqliteVersion = (
        probe.prepare("SELECT sqlite_version() AS version").get() as { version: string }
    ).version;
    probe.close();

    const evidence = {
        schemaVersion: "claims-backfill-threshold/v1",
        generatedAt: new Date().toISOString(),
        commit,
        runtime: `bun ${Bun.version}`,
        runtimeCoverage: {
            bun: "measured",
            node: "omitted: this Bun script does not provide the required Node reference-host eager run",
        },
        sqliteVersion,
        prng: "splitmix32",
        seed: SEED,
        runsPerScale: RUNS_PER_SCALE,
        cutoffTargetMs: CUTOFF_TARGET_MS,
        cutoffPolicy:
            "largest measured scale whose slowest run stays under cutoffTargetMs (2x margin before the 5s sibling busy timeout)",
        measurements,
        skippedScales,
        selectedCutoff,
        reviewStatus: "unreviewed",
        productionCutoff: 0,
        productionCutoffReason:
            "production policy stays at cutoff 0 (PRODUCTION_CLAIMS_BACKFILL_POLICY = null): full 1K/10K/100K/1M Bun and Node reference-host evidence was not run and reviewed; omissions were not extrapolated",
        evidenceDigestPolicy: "sha256(JSON.stringify(measurements))",
        evidenceDigest: computeClaimsBackfillEvidenceDigest(measurements),
    };

    const outputPath = join(
        import.meta.dir,
        "../../..",
        "docs/evidence/claims-backfill/v83-threshold.json",
    );
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.error(`[measure] evidence written to ${outputPath}`);
    console.log(JSON.stringify(evidence, null, 2));
}

main();
