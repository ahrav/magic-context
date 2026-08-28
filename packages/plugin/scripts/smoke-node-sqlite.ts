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
    computeProjectMemoryMutationToken,
    createProjectMemoryClaim,
    reviseProjectMemoryClaim,
} from "../src/features/magic-context/memory/storage-claim-operations.ts";
import { createClaimsAndEvidenceSchema } from "../src/features/magic-context/storage-claims-schema.ts";
import {
    addObservationSourceTrustClassColumn,
    createClaimApplicabilitySchema,
} from "../src/features/magic-context/storage-claim-applicability-schema.ts";
import {
    appendApplicabilityAssertionInCurrentTransaction,
    readApplicabilityIntervals,
    readCurrentApplicabilityAssertions,
} from "../src/features/magic-context/memory/storage-claim-applicability.ts";
import {
    classifyDatabaseFormatFamily,
    inspectDatabaseForClassification,
    readDirectFormatMarker,
} from "../src/features/magic-context/storage-format-epoch.ts";
import {
    computeExpectedDirectFormat,
    createDirectTestDatabase,
} from "../src/features/magic-context/test-database.ts";
import {
    collectSqliteRuntimeGateInput,
    Database,
    evaluateSqliteRuntimeGate,
    verifySqliteConnectionContract,
} from "../src/shared/sqlite.ts";

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
    // SAFETY: The smoke test invokes every asserted Database member, so an
    // absent member throws.
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

    // RAISE(ROLLBACK) ends the transaction inside SQLite. The wrapper must
    // preserve that trigger error instead of masking it with a second ROLLBACK.
    db.exec(`
        CREATE TRIGGER rollback_t_insert
        BEFORE INSERT ON t
        WHEN NEW.v = 'abort-whole'
        BEGIN
            SELECT RAISE(ROLLBACK, 'trigger rollback');
        END
    `);
    let triggerRollbackMessage = "";
    try {
        db.transaction(() => {
            db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)").run("abort-whole", 0);
        })();
    } catch (error) {
        triggerRollbackMessage = error instanceof Error ? error.message : String(error);
    }
    check(
        "transaction() preserves trigger RAISE(ROLLBACK) error",
        triggerRollbackMessage.includes("trigger rollback") && !triggerRollbackMessage.includes("no transaction"),
        triggerRollbackMessage,
    );
    db.transaction(() => {
        db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)").run("after-trigger-rollback", 0);
    })();
    db.prepare("DELETE FROM t WHERE v = ?").run("after-trigger-rollback");

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
    // SAFETY: The smoke test invokes every asserted Database member, so an
    // absent member throws.
    const other = new Database(join(dir, "other.db")) as unknown as { exec: (s: string) => void; close: () => void };
    other.exec("CREATE TABLE x(id INTEGER); INSERT INTO x(id) VALUES(42)");
    other.close();
    // pi-lens-ignore: sql-injection
    db.exec(`ATTACH '${join(dir, "other.db")}' AS oc`);
    check("ATTACH + cross-db read", (db.prepare("SELECT id FROM oc.x").get() as { id: number }).id === 42);
    db.exec("DETACH oc");

    db.close();

    // readonly → readOnly mapping.
    // SAFETY: The smoke test invokes every asserted Database member, so an
    // absent member throws.
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
    addObservationSourceTrustClassColumn(claimsDb);
    createClaimApplicabilitySchema(claimsDb);
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
        sourceTrustClass: "explicit_user",
    });
    const storedTrust = claimsDb
        .prepare("SELECT source_trust_class AS trust FROM observations WHERE id = ?")
        .get(observationId) as { trust: string };
    check("v85 observation trust class persists", storedTrust.trust === "explicit_user");
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
        check("v82 stale append leaves no revision residue",
            revisionCount.count === 2,
            String(revisionCount.count),
        );
        const baselineHeads = readCurrentApplicabilityAssertions(claimsDb, created.revisionId);
        check(
            "v85 create writes an unknown baseline assertion",
            baselineHeads.length === 1 && baselineHeads[0]?.state === "unknown",
            JSON.stringify(baselineHeads),
        );
        const baseline = baselineHeads[0];
        if (baseline) {
            claimsDb
                .transaction(() =>
                    appendApplicabilityAssertionInCurrentTransaction(claimsDb, {
                        streamId: baseline.streamId,
                        state: "historical",
                        paths: { state: "known", exact: ["src/smoke.ts"] },
                        knownFrom: (baseline.knownFrom ?? 0) + 1_000,
                    }),
                )
                .immediate();
            const intervals = readApplicabilityIntervals(claimsDb, created.revisionId);
            const closed = intervals.find((row) => row.seq === 1);
            check(
                "v85 successor closes the baseline knowledge interval",
                closed?.knownUntil === (baseline.knownFrom ?? 0) + 1_000 &&
                    closed?.recordedUntil !== null,
                JSON.stringify(intervals),
            );
        }
    }
    claimsDb.close();

    // Direct claim kernel under node:sqlite: create, replay, revise, and
    // stale fencing against the registered direct format.
    const kernel = createDirectTestDatabase({ path: join(dir, "kernel.db") });
    const kernelDb = kernel.db;
    const kernelProvenance = {
        sourceLocator: "transcript://node-smoke/1",
        sourceContent: "node smoke source",
        extractor: "historian",
        extractorVersion: "1",
        extractorRunId: "run-node-smoke",
        independenceKey: "ik-node-smoke",
        sourceTrustClass: "explicit_user",
    } as const;
    const kernelProjectId = ensureProject(kernelDb, "git:kernel");
    const kernelCreateInput = {
        projectId: kernelProjectId,
        content: "node kernel fact",
        category: "CONSTRAINTS",
        provenance: { ...kernelProvenance },
        actor: "user:node-smoke",
    };
    const kernelCreated = createProjectMemoryClaim(
        kernelDb,
        { producer: "node-smoke", operationKey: "create-1" },
        kernelCreateInput,
    );
    const createdClaim = (
        kernelCreated.result.payload as {
            claim: { publicClaimId: string; revision: number; revisionLocator: string };
        }
    ).claim;
    check(
        "direct kernel create commits claim revision 1",
        kernelCreated.outcome === "applied" && createdClaim.revision === 1,
        kernelCreated.resultJson,
    );

    const kernelReplayed = createProjectMemoryClaim(
        kernelDb,
        { producer: "node-smoke", operationKey: "create-1" },
        kernelCreateInput,
    );
    check(
        "replaying the operation returns the stored result bytes",
        kernelReplayed.replayed && kernelReplayed.resultJson === kernelCreated.resultJson,
        kernelReplayed.resultJson,
    );

    const kernelToken = computeProjectMemoryMutationToken(kernelDb, createdClaim.publicClaimId);
    const kernelRevised = reviseProjectMemoryClaim(
        kernelDb,
        { producer: "node-smoke", operationKey: "revise-1" },
        {
            token: kernelToken,
            content: "node kernel fact v2",
            provenance: {
                ...kernelProvenance,
                sourceLocator: "transcript://node-smoke/2",
                extractorRunId: "run-node-smoke-2",
                independenceKey: "ik-node-smoke-2",
            },
            actor: "user:node-smoke",
        },
    );
    const revisedClaim = (
        kernelRevised.result.payload as { claim: { revision: number } } | null
    )?.claim;
    check(
        "revise advances the claim to revision 2",
        kernelRevised.outcome === "applied" && revisedClaim?.revision === 2,
        kernelRevised.resultJson,
    );

    const kernelCounts = (): string =>
        JSON.stringify({
            revisions: kernelDb.prepare("SELECT COUNT(*) c FROM claim_revisions").get(),
            effects: kernelDb.prepare("SELECT COUNT(*) c FROM claim_operation_effects").get(),
            generations: kernelDb.prepare("SELECT COUNT(*) c FROM claim_project_generations").get(),
        });
    const countsBeforeStale = kernelCounts();
    const staleAttempt = reviseProjectMemoryClaim(
        kernelDb,
        { producer: "node-smoke", operationKey: "revise-stale" },
        {
            token: kernelToken,
            content: "stale write",
            provenance: {
                ...kernelProvenance,
                sourceLocator: "transcript://node-smoke/3",
                extractorRunId: "run-node-smoke-3",
                independenceKey: "ik-node-smoke-3",
            },
            actor: "user:node-smoke",
        },
    );
    check(
        "a stale claim token stores a zero-effect result",
        staleAttempt.outcome === "stale" && kernelCounts() === countsBeforeStale,
        `${staleAttempt.outcome} ${kernelCounts()}`,
    );
    const receipts = kernelDb
        .prepare("SELECT COUNT(*) c FROM claim_operation_receipts")
        .get() as { c: number };
    check(
        "every operation left one durable receipt",
        receipts.c === 3,
        String(receipts.c),
    );
    kernelDb.close();

    const gateInput = collectSqliteRuntimeGateInput();
    console.log(
        `  node=${gateInput.runtimeVersion} sqlite=${gateInput.sqliteVersion} source=${gateInput.sqliteSourceId}`,
    );
    check(
        "node:sqlite passes the WAL-reset-safety gate",
        evaluateSqliteRuntimeGate(gateInput).ok,
        evaluateSqliteRuntimeGate(gateInput).reasons.join("; "),
    );
    check(
        "gate rejects Node 24.14.1",
        !evaluateSqliteRuntimeGate({ ...gateInput, runtimeVersion: "24.14.1" }).ok,
    );
    check(
        "gate rejects a pre-fix SQLite 3.46.0 source",
        !evaluateSqliteRuntimeGate({ ...gateInput, sqliteVersion: "3.46.0" }).ok,
    );

    const directPath = join(dir, "direct-format.db");
    const direct = createDirectTestDatabase({ path: directPath });
    const contractViolations = verifySqliteConnectionContract(direct.db, {
        expectWal: true,
        minBusyTimeoutMs: 5000,
    });
    check(
        "direct factory connection satisfies the contract",
        contractViolations.length === 0,
        contractViolations.join("; "),
    );
    const directClassification = classifyDatabaseFormatFamily(
        inspectDatabaseForClassification(direct.db, directPath),
        computeExpectedDirectFormat(),
    );
    check(
        "direct factory database classifies as current under node:sqlite",
        directClassification.family === "current",
        JSON.stringify(directClassification),
    );
    direct.db.close();
    const directReopened = new Database(directPath);
    const rereadMarker = readDirectFormatMarker(directReopened);
    check(
        "database incarnation is stable across reopen under node:sqlite",
        rereadMarker.status === "present" &&
            rereadMarker.marker.databaseIncarnationId === direct.marker.databaseIncarnationId,
        JSON.stringify(rereadMarker),
    );
    directReopened.close();
} finally {
    rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nSMOKE PASS (node:sqlite branch)" : `\nSMOKE FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
