// Node-runtime smoke test for the node:sqlite branch of shared/sqlite.ts.
// Bun's `bun test` only exercises the bun:sqlite branch, so this runs the
// REAL wrapper under Node to validate: construction, readonly mapping, the
// transaction() shim (top-level + nested savepoint rollback), exec/prepare/
// run/get/all, and ATTACH. Run with: node packages/plugin/scripts/smoke-node-sqlite.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// NOTE: explicit .ts extension — this script is run directly under Node
// (`node scripts/smoke-node-sqlite.ts`) to exercise the node:sqlite branch that
// `bun test` cannot reach. Node's ESM type-stripping resolver requires the
// extension. The file is excluded from tsconfig.scripts.json for the same
// reason (running it IS the validation).
import {
    appendClaimRevision,
    createClaim,
    createEpisode,
    createObservation,
    createSourceSpan,
    ensureProject,
} from "../src/features/magic-context/memory/storage-claims.ts";
import {
    clearMemoryClaimFailpoints,
    createMemoryWithClaimsInCurrentTransaction,
    getCurrentMemoryClaimByLegacyMemoryId,
    runInMemoryClaimsWriteTransaction,
    setMemoryClaimFailpoint,
    updateMemoryContentWithClaimsInCurrentTransaction,
} from "../src/features/magic-context/memory/storage-memory-claims.ts";
import { readMemoryProjectionRow } from "../src/features/magic-context/memory/storage-memory-projection.ts";
import { createClaimsAndEvidenceSchema } from "../src/features/magic-context/storage-claims-schema.ts";
import {
    createMemoryClaimsCompatSchema,
    installMemoryClaimsWriteGuards,
} from "../src/features/magic-context/storage-memory-claims-schema.ts";
import { Database } from "../src/shared/sqlite.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

const dir = mkdtempSync(join(tmpdir(), "mc-node-sqlite-smoke-"));
const dbPath = join(dir, "smoke.db");
try {
    // Construction + basic DDL/DML.
    const db = new Database(dbPath) as unknown as {
        exec: (s: string) => void;
        prepare: (s: string) => {
            run: (...a: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
            get: (...a: unknown[]) => unknown;
            all: (...a: unknown[]) => unknown[];
        };
        transaction: <F extends (...a: unknown[]) => unknown>(fn: F) => F;
        close: () => void;
        isTransaction?: boolean;
    };
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT, flag INTEGER)");
    const ins = db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)");
    const r = ins.run("a", 1);
    check("run() returns changes+lastInsertRowid", r.changes === 1 && Number(r.lastInsertRowid) === 1, JSON.stringify(r));
    check("get() returns row", (db.prepare("SELECT v FROM t WHERE id=?").get(1) as { v: string }).v === "a");

    // Array-form bind normalization (issue #151): bare node:sqlite throws
    // `Unknown named parameter '0'` on `.run([a,b])`; the chokepoint shim must
    // make it behave like bun:sqlite (positional). Exercise run/get with array binds.
    let arrayBindOk = false;
    try {
        db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)").run(["arr", 1]);
        const got = db.prepare("SELECT v FROM t WHERE v=?").get(["arr"]) as { v: string } | undefined;
        arrayBindOk = got?.v === "arr";
        // Clean up so the row-count assertions below stay valid.
        db.prepare("DELETE FROM t WHERE v=?").run(["arr"]);
    } catch (e) {
        arrayBindOk = false;
        check("array-bind normalized to positional", false, (e as Error).message);
    }
    check("array-bind normalized to positional (issue #151)", arrayBindOk);

    // transaction() shim — top-level commit.
    db.transaction(() => {
        db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)").run("b", 0);
    })();
    check("transaction() commits", (db.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c === 2);

    // transaction() shim — top-level rollback on throw.
    try {
        db.transaction(() => {
            db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)").run("doomed", 0);
            throw new Error("boom");
        })();
    } catch {
        /* expected */
    }
    check("transaction() rolls back on throw", (db.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c === 2);

    // Nested transaction — outer commits, inner savepoint rolls back.
    db.transaction(() => {
        db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)").run("outer", 0);
        try {
            db.transaction(() => {
                db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)").run("inner-doomed", 0);
                throw new Error("inner boom");
            })();
        } catch {
            /* swallow — outer continues */
        }
    })();
    const names = (db.prepare("SELECT v FROM t ORDER BY id").all() as { v: string }[]).map((x) => x.v);
    check("nested savepoint: outer kept, inner rolled back", names.join(",") === "a,b,outer", names.join(","));

    // ATTACH (used by tool-owner-backfill) works under defensive mode.
    const other = new Database(join(dir, "other.db")) as unknown as { exec: (s: string) => void; close: () => void };
    other.exec("CREATE TABLE x(id INTEGER); INSERT INTO x(id) VALUES(42)");
    other.close();
    db.exec(`ATTACH '${join(dir, "other.db")}' AS oc`);
    check("ATTACH + cross-db read", (db.prepare("SELECT id FROM oc.x").get() as { id: number }).id === 42);
    db.exec("DETACH oc");

    db.close();

    // readonly → readOnly mapping.
    const ro = new Database(dbPath, { readonly: true } as never) as unknown as {
        prepare: (s: string) => { get: (...a: unknown[]) => unknown };
        exec: (s: string) => void;
        close: () => void;
    };
    check("readonly open can read", (ro.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c === 3);
    let blocked = false;
    try {
        ro.exec("INSERT INTO t(v, flag) VALUES('nope', 0)");
    } catch {
        blocked = true;
    }
    check("readonly open blocks writes", blocked);
    ro.close();

    const claimsDb = new Database(join(dir, "claims.db"));
    claimsDb.exec("PRAGMA foreign_keys=ON");
    const engine = claimsDb.prepare("SELECT sqlite_version() AS version").get() as {
        version: string;
    };
    console.log(`  sqlite_version() = ${engine.version}`);
    createClaimsAndEvidenceSchema(claimsDb);
    const projectId = ensureProject(claimsDb, "git:node-smoke");
    const episodeId = createEpisode(claimsDb, { projectId, sourceSessionId: "ses_smoke" });
    const spanId = createSourceSpan(claimsDb, {
        episodeId,
        sourceLocator: "transcript://smoke",
        content: "smoke span content",
        startOffset: 0,
        endOffset: 18,
    });
    const observationId = createObservation(claimsDb, {
        sourceSpanId: spanId,
        extractedText: "smoke observation",
        extractor: "smoke",
        extractorVersion: "1",
        extractorRunId: "run",
        independenceKey: "ik",
    });
    const created = createClaim(claimsDb, {
        projectId,
        subject: "s",
        predicate: "p",
        content: "claim v1",
        evidence: [{ observationId }],
    });
    check("v82 createClaim applies revision 1", created.status === "applied", JSON.stringify(created));
    if (created.status === "applied") {
        const appended = appendClaimRevision(claimsDb, {
            claimId: created.claimId,
            expectedCurrentRevisionId: created.revisionId,
            content: "claim v2",
            evidence: [{ observationId }],
        });
        check(
            "v82 append advances to revision 2",
            appended.status === "applied" && appended.revision === 2,
            JSON.stringify(appended),
        );
        const stale = appendClaimRevision(claimsDb, {
            claimId: created.claimId,
            expectedCurrentRevisionId: created.revisionId,
            content: "stale append",
            evidence: [{ observationId }],
        });
        check("v82 stale CAS reports stale", stale.status === "stale", JSON.stringify(stale));
        const revisionCount = claimsDb
            .prepare("SELECT COUNT(*) AS count FROM claim_revisions")
            .get() as { count: number };
        check(
            "v82 stale append leaves no revision residue",
            revisionCount.count === 2,
            String(revisionCount.count),
        );
    }
    claimsDb.close();

    const kernelDb = new Database(join(dir, "kernel.db"));
    kernelDb.exec("PRAGMA foreign_keys=ON");
    kernelDb.exec(`
        CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            normalized_hash TEXT NOT NULL,
            importance INTEGER,
            scope TEXT NOT NULL DEFAULT 'project',
            shareable INTEGER NOT NULL DEFAULT 0,
            source_session_id TEXT,
            source_type TEXT DEFAULT 'historian',
            seen_count INTEGER DEFAULT 1,
            retrieval_count INTEGER DEFAULT 0,
            first_seen_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            last_retrieved_at INTEGER,
            status TEXT DEFAULT 'active',
            expires_at INTEGER,
            verification_status TEXT DEFAULT 'unverified',
            verified_at INTEGER,
            classified_at INTEGER,
            superseded_by_memory_id INTEGER,
            merged_from TEXT,
            metadata_json TEXT,
            mural_cue TEXT,
            mural_cue_hash TEXT,
            mural_cue_at INTEGER,
            mural_cue_rejection_count INTEGER NOT NULL DEFAULT 0,
            UNIQUE(project_path, category, normalized_hash)
        );
        CREATE TABLE memory_embeddings (
            memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            embedding BLOB NOT NULL,
            model_id TEXT NOT NULL,
            PRIMARY KEY(memory_id, model_id)
        );
        CREATE TABLE memory_verifications (
            memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL,
            verified_at INTEGER NOT NULL,
            mapped_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (memory_id, file_path)
        );
        CREATE TABLE memory_stats (
            memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
            seen_count INTEGER NOT NULL,
            retrieval_count INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            last_retrieved_at INTEGER,
            updated_at INTEGER NOT NULL
        );
        CREATE TRIGGER memories_stats_ai AFTER INSERT ON memories BEGIN
            INSERT INTO memory_stats (memory_id, seen_count, retrieval_count, last_seen_at, last_retrieved_at, updated_at)
            VALUES (NEW.id, COALESCE(NEW.seen_count, 1), COALESCE(NEW.retrieval_count, 0), NEW.last_seen_at, NEW.last_retrieved_at, NEW.updated_at);
        END;
        CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    createClaimsAndEvidenceSchema(kernelDb);
    createMemoryClaimsCompatSchema(kernelDb);
    installMemoryClaimsWriteGuards(kernelDb);

    let guardBlocked = false;
    try {
        kernelDb.exec(
            "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES ('git:kernel', 'CONSTRAINTS', 'bare', 'h0', 1, 1, 1, 1)",
        );
    } catch {
        guardBlocked = true;
    }
    check("v84 guard rejects a bare semantic insert", guardBlocked);

    const kernelCreated = runInMemoryClaimsWriteTransaction(kernelDb, () =>
        createMemoryWithClaimsInCurrentTransaction(
            kernelDb,
            { producer: "node-smoke", operationKey: "create-1", requestDigest: "a".repeat(64) },
            {
                projectPath: "git:kernel",
                category: "CONSTRAINTS",
                content: "node kernel fact",
                normalizedHash: "hash:node kernel fact",
                nowMs: 1_000,
            },
        ),
    );
    check(
        "v84 kernel create links a claim",
        kernelCreated.result.claimId !== null && kernelCreated.result.revisionId !== null,
        JSON.stringify(kernelCreated),
    );

    kernelDb.transaction(() => {
        runInMemoryClaimsWriteTransaction(kernelDb, () =>
            updateMemoryContentWithClaimsInCurrentTransaction(
                kernelDb,
                { producer: "node-smoke", operationKey: "update-1", requestDigest: "b".repeat(64) },
                {
                    memoryId: kernelCreated.result.memoryId,
                    content: "node kernel fact v2",
                    normalizedHash: "hash:node kernel fact v2",
                },
            ),
        );
    }).immediate();
    const currentClaim = getCurrentMemoryClaimByLegacyMemoryId(kernelDb, kernelCreated.result.memoryId);
    check("v84 nested update advanced to revision 2", currentClaim?.revision === 2);

    const tupleCounts = (): string =>
        JSON.stringify({
            memories: kernelDb.prepare("SELECT COUNT(*) c FROM memories").get(),
            revisions: kernelDb.prepare("SELECT COUNT(*) c FROM claim_revisions").get(),
            outbox: kernelDb.prepare("SELECT COUNT(*) c FROM claim_change_outbox").get(),
            generations: kernelDb.prepare("SELECT COUNT(*) c FROM claim_project_generations").get(),
        });
    const countsBefore = tupleCounts();
    setMemoryClaimFailpoint("memory-claim.050.commit.before", () => {
        throw new Error("smoke rollback");
    });
    let rolledBack = false;
    try {
        runInMemoryClaimsWriteTransaction(kernelDb, () =>
            createMemoryWithClaimsInCurrentTransaction(
                kernelDb,
                { producer: "node-smoke", operationKey: "doomed-1", requestDigest: "c".repeat(64) },
                {
                    projectPath: "git:kernel",
                    category: "CONSTRAINTS",
                    content: "doomed fact",
                    normalizedHash: "hash:doomed fact",
                },
            ),
        );
    } catch {
        rolledBack = true;
    }
    clearMemoryClaimFailpoints();
    check(
        "v84 failpoint rollback leaves no tuple residue",
        rolledBack && tupleCounts() === countsBefore,
        tupleCounts(),
    );

    const projectionRow = readMemoryProjectionRow(kernelDb, kernelCreated.result.memoryId);
    check(
        "v84 legacy projection and current claim read the same state",
        projectionRow?.content === currentClaim?.content &&
            projectionRow?.category === currentClaim?.category &&
            projectionRow?.normalized_hash === currentClaim?.normalizedHash &&
            projectionRow?.status === currentClaim?.state,
        JSON.stringify({ projectionRow, currentClaim }),
    );
    kernelDb.close();
} finally {
    rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nSMOKE PASS (node:sqlite branch)" : `\nSMOKE FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
