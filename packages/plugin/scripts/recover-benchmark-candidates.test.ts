import { afterEach, describe, expect, it } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "../src/shared/sqlite";
import { normalizedQueryHash } from "../src/features/magic-context/storage-embedding-measurements";
import {
    type QueryCandidate,
    type RecoveryInputRow,
    StagingError,
    collectSessionCandidates,
    ensureStagingRoot,
    purgeStaleDrafts,
    recoverCandidates,
    runRecovery,
    validateMeasurementSchema,
    writeStagedFileAtomically,
} from "./recover-benchmark-candidates";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function makeMeasurementDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE embedding_measurement_corpus (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            project_path TEXT NOT NULL DEFAULT '',
            query_text_hash TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE session_projects (
            session_id TEXT NOT NULL,
            harness TEXT NOT NULL DEFAULT 'opencode',
            project_path TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(session_id, harness)
        );
    `);
    return db;
}

function makeHistoryDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            data TEXT NOT NULL,
            time_created INTEGER,
            time_updated INTEGER
        );
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            data TEXT NOT NULL,
            time_created INTEGER,
            time_updated INTEGER
        );
    `);
    return db;
}

let messageCounter = 0;

function insertUserMessage(db: Database, sessionId: string, text: string): void {
    messageCounter += 1;
    const messageId = `msg_${messageCounter}`;
    db.prepare(
        "INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)",
    ).run(messageId, sessionId, JSON.stringify({ role: "user", id: messageId }), messageCounter);
    const partId = `part_${messageCounter}`;
    db.prepare(
        "INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)",
    ).run(
        partId,
        messageId,
        sessionId,
        JSON.stringify({ type: "text", text }),
        messageCounter,
    );
}

function bindSession(db: Database, sessionId: string, harness: string): void {
    db.prepare(
        "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, 'git:proj', 0)",
    ).run(sessionId, harness);
}

function insertMeasurement(db: Database, sessionId: string, hash: string): void {
    db.prepare(
        "INSERT INTO embedding_measurement_corpus (session_id, query_text_hash) VALUES (?, ?)",
    ).run(sessionId, hash);
}

function row(
    ordinal: number,
    sessionId: string,
    hash: string,
    ownership: RecoveryInputRow["ownership"] = "opencode",
): RecoveryInputRow {
    return { ordinal, sessionId, queryTextHash: hash, ownership };
}

describe("recoverCandidates", () => {
    const candidate = (text: string, mode: QueryCandidate["mode"] = "automatic") => ({
        text,
        mode,
    });

    it("recovers a unique same-session match and nothing else", () => {
        const text = "how does the queue backpressure work";
        const outcome = recoverCandidates({
            rows: [row(0, "s1", normalizedQueryHash(text))],
            candidatesBySession: new Map([["s1", [candidate(text)]]]),
        });
        expect(outcome.report.rows).toEqual([{ ordinal: 0, status: "recovered" }]);
        expect(outcome.draft.records).toEqual([
            { ordinal: 0, mode: "automatic", queryText: text },
        ]);
    });

    it("emits distinct allowlisted statuses for every non-recoverable case", () => {
        const shared = "shared candidate text";
        const collidingA = "Collision  Text";
        const collidingB = "collision text";
        const outcome = recoverCandidates({
            rows: [
                row(0, "s1", normalizedQueryHash("absent query")),
                row(1, "s1", normalizedQueryHash(shared)),
                row(2, "s2", normalizedQueryHash("anything"), "pi"),
                row(3, "s3", normalizedQueryHash("anything"), "missing"),
                row(4, "s4", normalizedQueryHash("anything"), "ambiguous"),
                row(5, "s1", normalizedQueryHash(collidingA)),
            ],
            candidatesBySession: new Map([
                ["s1", [candidate(collidingA), candidate(collidingB)]],
                ["s5", [candidate(shared)]],
            ]),
        });
        expect(outcome.report.rows.map((r) => r.status)).toEqual([
            "zero-match",
            "cross-session-only",
            "owner-pi",
            "owner-missing",
            "owner-ambiguous",
            "normalized-collision",
        ]);
        expect(outcome.draft.records).toHaveLength(0);
    });

    it("reports a defensive multi-match when the hash function collides", () => {
        const outcome = recoverCandidates({
            rows: [row(0, "s1", "collide")],
            candidatesBySession: new Map([
                ["s1", [candidate("alpha entirely"), candidate("beta different")]],
            ]),
            hashCandidate: () => "collide",
        });
        expect(outcome.report.rows).toEqual([{ ordinal: 0, status: "multi-match" }]);
    });

    it("privacy-rejects a matched candidate that still carries sensitive text", () => {
        const text = "token in /home/someone/.ssh/id_rsa please";
        const outcome = recoverCandidates({
            rows: [row(0, "s1", normalizedQueryHash(text))],
            candidatesBySession: new Map([["s1", [candidate(text)]]]),
        });
        expect(outcome.report.rows).toEqual([{ ordinal: 0, status: "privacy-rejected" }]);
        expect(outcome.draft.records).toHaveLength(0);
    });

    it("is deterministic across runs over the same inputs", () => {
        const args = {
            rows: [row(0, "s1", normalizedQueryHash("query one"))],
            candidatesBySession: new Map([["s1", [candidate("query one")]]]),
        };
        expect(JSON.stringify(recoverCandidates(args))).toBe(
            JSON.stringify(recoverCandidates(args)),
        );
    });
});

describe("collectSessionCandidates", () => {
    it("derives the same automatic query as the production stripper", () => {
        const db = makeHistoryDb();
        insertUserMessage(
            db,
            "s1",
            "<system-reminder>noise</system-reminder>How does   compaction work?",
        );
        const messages = [
            {
                ordinal: 1,
                id: "msg_x",
                role: "user",
                parts: [
                    {
                        type: "text",
                        text: "<system-reminder>noise</system-reminder>How does   compaction work?",
                    },
                ],
            },
        ];
        const candidates = collectSessionCandidates(messages);
        expect(candidates).toEqual([
            { text: "How does compaction work?", mode: "automatic" },
        ]);
    });

    it("skips ignored parts, unwraps imitated-reduced args, and drops malformed input", () => {
        const candidates = collectSessionCandidates([
            {
                ordinal: 1,
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "ignored notification", ignored: true }],
            },
            {
                ordinal: 2,
                id: "m2",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        tool: "ctx_search",
                        state: {
                            input: {
                                reduced: true,
                                summary: JSON.stringify({ query: "nested lookup" }),
                            },
                        },
                    },
                    { type: "tool", tool: "ctx_search", state: { input: null } },
                    { type: "tool", tool: "other_tool", state: { input: { query: "not ours" } } },
                ],
            },
        ]);
        expect(candidates).toEqual([{ text: "nested lookup", mode: "explicit" }]);
    });

    it("drops an over-cap explicit query exactly like the live tool", () => {
        const candidates = collectSessionCandidates([
            {
                ordinal: 1,
                id: "m1",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        tool: "ctx_search",
                        state: { input: { query: "x".repeat(17 * 1024) } },
                    },
                ],
            },
        ]);
        expect(candidates).toEqual([]);
    });
});

describe("staging safety", () => {
    it("rejects symlinked roots, permissive modes, VCS trees, and forbidden overlaps", () => {
        const base = tempDir("staging-safety-");
        const realRoot = join(base, "real");
        mkdirSync(realRoot, { mode: 0o700 });
        const alias = join(base, "alias");
        symlinkSync(realRoot, alias);
        expect(() => ensureStagingRoot(alias, [])).toThrow(StagingError);

        const permissive = join(base, "permissive");
        mkdirSync(permissive, { mode: 0o755 });
        expect(() => ensureStagingRoot(permissive, [])).toThrow(StagingError);

        const vcs = join(base, "repo", "staging");
        mkdirSync(join(base, "repo", ".git"), { recursive: true });
        mkdirSync(vcs, { recursive: true, mode: 0o700 });
        expect(() => ensureStagingRoot(vcs, [])).toThrow(StagingError);

        const forbidden = join(base, "forbidden", "inner");
        mkdirSync(forbidden, { recursive: true, mode: 0o700 });
        expect(() => ensureStagingRoot(forbidden, [join(base, "forbidden")])).toThrow(
            StagingError,
        );

        expect(() => ensureStagingRoot("relative/path", [])).toThrow(StagingError);
    });

    it("refuses existing destinations and leaves no temp file on failure", () => {
        const root = ensureStagingRoot(join(tempDir("staging-write-"), "root"), []);
        writeStagedFileAtomically(root, "draft.json", "{}");
        expect(() => writeStagedFileAtomically(root, "draft.json", "{}")).toThrow(StagingError);
        expect(readdirSync(root).sort((a, b) => a.localeCompare(b))).toEqual(["draft.json"]);
    });

    it("purges drafts older than the TTL and keeps fresh ones", () => {
        const root = ensureStagingRoot(join(tempDir("staging-purge-"), "root"), []);
        const stale = join(root, "stale.json");
        writeFileSync(stale, "{}");
        const past = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
        utimesSync(stale, past, past);
        writeStagedFileAtomically(root, "fresh.json", "{}");
        purgeStaleDrafts(root, Date.now());
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(join(root, "fresh.json"))).toBe(true);
    });
});

describe("runRecovery", () => {
    function seededDbs() {
        const measurementDb = makeMeasurementDb();
        const historyDb = makeHistoryDb();
        const text = "where is the retry backoff configured";
        bindSession(measurementDb, "s1", "opencode");
        insertMeasurement(measurementDb, "s1", normalizedQueryHash(text));
        bindSession(measurementDb, "s2", "pi");
        insertMeasurement(measurementDb, "s2", normalizedQueryHash("pi query"));
        insertUserMessage(historyDb, "s1", text);
        return { measurementDb, historyDb, text };
    }

    it("writes a de-identified draft and allowlisted report, deterministically", async () => {
        const { measurementDb, historyDb, text } = seededDbs();
        const rootA = join(tempDir("run-recovery-"), "a");
        const first = await runRecovery({
            measurementDb,
            historyDb,
            stagingRoot: rootA,
            forbiddenRoots: [],
        });
        const draft = readFileSync(first.draftPath, "utf8");
        const report = readFileSync(first.reportPath, "utf8");
        expect(JSON.parse(draft).records).toEqual([
            { ordinal: 0, mode: "automatic", queryText: text },
        ]);
        expect(JSON.parse(report).rows).toEqual([
            { ordinal: 0, status: "recovered" },
            { ordinal: 1, status: "owner-pi" },
        ]);
        for (const output of [draft, report]) {
            expect(output).not.toContain("s1");
            expect(output).not.toContain(normalizedQueryHash(text));
        }
        expect(report).not.toContain(text);

        const rootB = join(tempDir("run-recovery-"), "b");
        const second = await runRecovery({
            measurementDb,
            historyDb,
            stagingRoot: rootB,
            forbiddenRoots: [],
        });
        expect(readFileSync(second.draftPath, "utf8")).toBe(draft);
        expect(readFileSync(second.reportPath, "utf8")).toBe(report);
    });

    it("keeps canaries in hashes, ids, and metadata out of every output channel", async () => {
        const measurementDb = makeMeasurementDb();
        const historyDb = makeHistoryDb();
        const canaryText = "find sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 in the config";
        bindSession(measurementDb, "ses_canary_owner", "opencode");
        insertMeasurement(measurementDb, "ses_canary_owner", normalizedQueryHash(canaryText));
        insertUserMessage(historyDb, "ses_canary_owner", canaryText);
        const root = join(tempDir("run-canary-"), "root");
        const result = await runRecovery({
            measurementDb,
            historyDb,
            stagingRoot: root,
            forbiddenRoots: [],
        });
        expect(JSON.parse(readFileSync(result.reportPath, "utf8")).rows).toEqual([
            { ordinal: 0, status: "privacy-rejected" },
        ]);
        for (const file of readdirSync(root)) {
            const content = readFileSync(join(root, file), "utf8");
            expect(content).not.toContain("sk-ant");
            expect(content).not.toContain("ses_canary_owner");
            expect(file).not.toContain("ses_canary_owner");
        }
    });

    it("rejects malformed schema and out-of-bounds rows without writing anything", async () => {
        const broken = new Database(":memory:");
        broken.exec("CREATE TABLE embedding_measurement_corpus (id INTEGER PRIMARY KEY)");
        const historyDb = makeHistoryDb();
        const root = join(tempDir("run-malformed-"), "root");
        await expect(
            runRecovery({
                measurementDb: broken,
                historyDb,
                stagingRoot: root,
                forbiddenRoots: [],
            }),
        ).rejects.toThrow(StagingError);
        expect(readdirSync(root)).toEqual([]);

        const oversized = makeMeasurementDb();
        bindSession(oversized, "s1", "opencode");
        insertMeasurement(oversized, "s1", "not-a-hash");
        const root2 = join(tempDir("run-oversized-"), "root");
        await expect(
            runRecovery({
                measurementDb: oversized,
                historyDb,
                stagingRoot: root2,
                forbiddenRoots: [],
            }),
        ).rejects.toThrow(StagingError);
        expect(readdirSync(root2)).toEqual([]);
    });

    it("leaves source databases byte-identical (no writes on the query-only path)", async () => {
        const dir = tempDir("run-readonly-");
        const measurementPath = join(dir, "context.db");
        const historyPath = join(dir, "opencode.db");
        {
            const seedMeasurement = new Database(measurementPath);
            seedMeasurement.exec(`
                CREATE TABLE embedding_measurement_corpus (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    project_path TEXT NOT NULL DEFAULT '',
                    query_text_hash TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE session_projects (
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    project_path TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(session_id, harness)
                );
            `);
            bindSession(seedMeasurement, "s1", "opencode");
            insertMeasurement(seedMeasurement, "s1", normalizedQueryHash("some query"));
            seedMeasurement.close();
            const seedHistory = new Database(historyPath);
            seedHistory.exec(`
                CREATE TABLE message (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL,
                    time_created INTEGER, time_updated INTEGER
                );
                CREATE TABLE part (
                    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
                    data TEXT NOT NULL, time_created INTEGER, time_updated INTEGER
                );
            `);
            seedHistory.close();
        }
        const beforeMeasurement = readFileSync(measurementPath);
        const beforeHistory = readFileSync(historyPath);
        const filesBefore = readdirSync(dir).sort((a, b) => a.localeCompare(b));

        const measurementDb = new Database(measurementPath, { readonly: true });
        const historyDb = new Database(historyPath, { readonly: true });
        const root = join(tempDir("run-readonly-out-"), "root");
        await runRecovery({
            measurementDb,
            historyDb,
            stagingRoot: root,
            forbiddenRoots: [dir],
        });
        measurementDb.close();
        historyDb.close();

        expect(readdirSync(dir).sort((a, b) => a.localeCompare(b))).toEqual(filesBefore);
        expect(readFileSync(measurementPath).equals(beforeMeasurement)).toBe(true);
        expect(readFileSync(historyPath).equals(beforeHistory)).toBe(true);
    });

    it("has no import edge to promotion or publication code", () => {
        const source = readFileSync(
            join(import.meta.dir, "recover-benchmark-candidates.ts"),
            "utf8",
        );
        const importLines = source.split("\n").filter((line) => line.includes(" from \""));
        for (const line of importLines) {
            expect(line.includes("promote")).toBe(false);
            expect(line.includes("build-benchmark-corpus")).toBe(false);
        }
    });
});

describe("validateMeasurementSchema", () => {
    it("accepts the production schema shape", () => {
        expect(() => validateMeasurementSchema(makeMeasurementDb())).not.toThrow();
    });
});
