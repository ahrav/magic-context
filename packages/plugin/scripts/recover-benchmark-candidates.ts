#!/usr/bin/env bun
/**
 * Recover historical benchmark query candidates from the measurement corpus.
 *
 * Query-only over one stable read snapshot per database (a read transaction
 * is held on both connections across all reads): joins measurement rows to
 * `session_projects` ownership in bounded keyset pages, reconstructs
 * candidate queries from OpenCode session history with the same helpers the
 * live paths use (one session hydrated at a time, its raw messages released
 * after candidate extraction), and accepts a plaintext only when exactly one
 * same-session candidate matches the stored normalized hash with one
 * unambiguous mode. Raw text and hashes stay in memory; the only outputs are
 * a privacy-gated draft and an allowlisted status/count report, written
 * atomically to an owner-only staging directory outside every source,
 * publication, and VCS tree. Recovery has no import edge to promotion.
 *
 * Usage: bun packages/plugin/scripts/recover-benchmark-candidates.ts
 */

import {
    chmodSync,
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
    type MeasurementOwnership,
    listMeasurementRowsWithOwnership,
    normalizeQueryText,
    normalizedQueryHash,
} from "../src/features/magic-context/storage-embedding-measurements";
import { extractBoundedAutoSearchQuery } from "../src/hooks/magic-context/auto-search-prompt";
import { collectUserPromptParts } from "../src/hooks/magic-context/auto-search-runner";
import {
    type RawMessage,
    readRawSessionMessagesFromDb,
} from "../src/hooks/magic-context/read-session-raw";
import type { Database } from "../src/shared/sqlite";
import { CTX_SEARCH_TOOL_NAME } from "../src/tools/ctx-search/constants";
import { extractCtxSearchQueryInput } from "../src/tools/ctx-search/query-input";
import type { CtxSearchArgs } from "../src/tools/ctx-search/types";
import { hasGitAncestor } from "./retrieval-benchmark/fs-boundary";
import { scanForSensitiveContent } from "./retrieval-benchmark/privacy";

export const DRAFT_VERSION = "benchmark-draft/v1";
export const REPORT_VERSION = "recovery-report/v1";
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export const RECOVERY_STATUSES = [
    "recovered",
    "owner-pi",
    "owner-missing",
    "owner-ambiguous",
    "zero-match",
    "cross-session-only",
    "normalized-collision",
    "multi-match",
    "mode-ambiguous",
    "privacy-rejected",
] as const;
export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];

export interface QueryCandidate {
    text: string;
    mode: "automatic" | "explicit";
}

export interface DraftRecord {
    ordinal: number;
    mode: "automatic" | "explicit";
    queryText: string;
}

export interface RecoveryReport {
    reportVersion: typeof REPORT_VERSION;
    counts: Partial<Record<RecoveryStatus, number>>;
    rows: Array<{ ordinal: number; status: RecoveryStatus }>;
}

export interface RecoveryDraft {
    draftVersion: typeof DRAFT_VERSION;
    records: DraftRecord[];
}

/** Candidate queries from one session's raw history, in message order,
 *  through the same extraction the live automatic and explicit paths use. */
export function collectSessionCandidates(messages: readonly RawMessage[]): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    for (const message of messages) {
        if (message.role === "user") {
            const collected = collectUserPromptParts({
                info: { role: message.role, id: message.id },
                parts: message.parts,
            });
            const auto = extractBoundedAutoSearchQuery(collected);
            if (auto.length > 0) candidates.push({ text: auto, mode: "automatic" });
        }
        for (const part of message.parts) {
            if (part === null || typeof part !== "object") continue;
            const p = part as Record<string, unknown>;
            if (p.type !== "tool" || p.tool !== CTX_SEARCH_TOOL_NAME) continue;
            const state = p.state as Record<string, unknown> | null;
            if (!state || typeof state !== "object") continue;
            const input = state.input;
            if (input === null || typeof input !== "object") continue;
            const preflight = extractCtxSearchQueryInput(input as CtxSearchArgs);
            if (preflight.ok && preflight.query.length > 0) {
                candidates.push({ text: preflight.query, mode: "explicit" });
            }
        }
    }
    return candidates;
}

export interface RecoveryInputRow {
    ordinal: number;
    sessionId: string;
    queryTextHash: string;
    ownership: MeasurementOwnership;
}

export interface RecoveryOutcome {
    draft: RecoveryDraft;
    report: RecoveryReport;
}

function normalizedCompare(a: string, b: string): boolean {
    return normalizeQueryText(a) === normalizeQueryText(b);
}

const OWNERSHIP_STATUS = {
    pi: "owner-pi",
    missing: "owner-missing",
    ambiguous: "owner-ambiguous",
} as const;

/**
 * Pure matching core. `hashCandidate` is injectable only so tests can force
 * the defensive hash-collision arm; production always uses
 * `normalizedQueryHash`.
 */
export function recoverCandidates(args: {
    rows: readonly RecoveryInputRow[];
    candidatesBySession: ReadonlyMap<string, readonly QueryCandidate[]>;
    /** Candidate hashes known beyond `candidatesBySession` (a streaming
     *  caller passes the full union while supplying only row-referenced
     *  candidates per session), so cross-session-only vs zero-match stays
     *  exact under bounded retention. */
    knownHashes?: ReadonlySet<string>;
    /** Substring deny list (home paths, operator codenames) rejected
     *  wherever it appears in candidate text. The privacy scan itself is
     *  host-independent, so author-host identity must be supplied here — at
     *  authoring time — or it is never checked. */
    forbiddenTokens?: readonly string[];
    /** Word-bounded deny list (usernames): rejects standalone occurrences
     *  only, so a short username does not reject every word containing it. */
    forbiddenIdentifiers?: readonly string[];
    hashCandidate?: (text: string) => string;
}): RecoveryOutcome {
    const hashCandidate = args.hashCandidate ?? normalizedQueryHash;
    const hashesBySession = new Map<string, Map<string, QueryCandidate[]>>();
    const allHashes = new Set<string>(args.knownHashes ?? []);
    for (const [sessionId, candidates] of args.candidatesBySession) {
        const byHash = new Map<string, QueryCandidate[]>();
        for (const candidate of candidates) {
            const hash = hashCandidate(candidate.text);
            allHashes.add(hash);
            const list = byHash.get(hash) ?? [];
            // Dedupe on (text, mode): one text seen as both an automatic
            // prompt and an explicit tool call keeps both entries, so mode
            // provenance is classified instead of resolved by message order.
            if (
                !list.some(
                    (existing) =>
                        existing.text === candidate.text && existing.mode === candidate.mode,
                )
            ) {
                list.push(candidate);
            }
            byHash.set(hash, list);
        }
        hashesBySession.set(sessionId, byHash);
    }

    const records: DraftRecord[] = [];
    const rows: RecoveryReport["rows"] = [];
    const counts: RecoveryReport["counts"] = {};
    const record = (ordinal: number, status: RecoveryStatus) => {
        rows.push({ ordinal, status });
        counts[status] = (counts[status] ?? 0) + 1;
    };

    for (const row of args.rows) {
        if (row.ownership !== "opencode") {
            record(row.ordinal, OWNERSHIP_STATUS[row.ownership]);
            continue;
        }
        const matches = hashesBySession.get(row.sessionId)?.get(row.queryTextHash) ?? [];
        if (matches.length === 0) {
            record(
                row.ordinal,
                allHashes.has(row.queryTextHash) ? "cross-session-only" : "zero-match",
            );
            continue;
        }
        if (matches.length > 1) {
            const texts = new Set(matches.map((m) => m.text));
            if (texts.size === 1) {
                // Identical text under differing modes: provenance selects
                // the replay path, so guessing one is not allowlisted.
                record(row.ordinal, "mode-ambiguous");
            } else if (matches.every((m) => normalizedCompare(m.text, matches[0].text))) {
                record(row.ordinal, "normalized-collision");
            } else {
                record(row.ordinal, "multi-match");
            }
            continue;
        }
        const match = matches[0];
        if (
            scanForSensitiveContent(
                { queryText: match.text },
                {
                    forbiddenTokens: args.forbiddenTokens,
                    forbiddenIdentifiers: args.forbiddenIdentifiers,
                },
            ).length > 0
        ) {
            record(row.ordinal, "privacy-rejected");
            continue;
        }
        record(row.ordinal, "recovered");
        records.push({ ordinal: row.ordinal, mode: match.mode, queryText: match.text });
    }

    return {
        draft: { draftVersion: DRAFT_VERSION, records },
        report: { reportVersion: REPORT_VERSION, counts, rows },
    };
}

export class StagingError extends Error {}

/**
 * Owner-only staging root outside every forbidden tree. Rejects roots whose
 * path traverses any symlink component (the realpath must equal the path as
 * given), roots not owned by the calling user, group/other-accessible modes,
 * and any root under a VCS worktree or a caller-named forbidden path.
 */
export function ensureStagingRoot(root: string, forbiddenRoots: readonly string[]): string {
    if (!isAbsolute(root)) throw new StagingError("staging root must be absolute");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const real = realpathSync.native(root);
    if (real !== resolve(root)) {
        throw new StagingError("staging root resolves through an alias");
    }
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !statSync(root).isDirectory()) {
        throw new StagingError("staging root must be a plain directory");
    }
    const rootStat = statSync(root);
    if (typeof process.getuid === "function" && rootStat.uid !== process.getuid()) {
        throw new StagingError("staging root must be caller-owned");
    }
    if ((rootStat.mode & 0o077) !== 0) {
        throw new StagingError("staging root must be owner-only");
    }
    if (hasGitAncestor(real)) throw new StagingError("staging root is inside a VCS tree");
    for (const forbidden of forbiddenRoots) {
        let forbiddenReal: string;
        try {
            forbiddenReal = realpathSync.native(resolve(forbidden));
        } catch {
            continue;
        }
        // Both directions: a staging root BELOW a forbidden tree could leak
        // drafts into it, and a staging root ABOVE one would let the stale-
        // draft purge recursively delete the forbidden tree as an old entry.
        if (real === forbiddenReal || real.startsWith(`${forbiddenReal}/`)) {
            throw new StagingError("staging root overlaps a forbidden tree");
        }
        if (forbiddenReal.startsWith(`${real}/`)) {
            throw new StagingError("staging root contains a forbidden tree");
        }
    }
    return real;
}

/** Exclusive temp file + rename; destination must not already exist. */
export function writeStagedFileAtomically(root: string, name: string, content: string): string {
    const destination = join(root, name);
    if (existsSync(destination) || lstatSync(root).isSymbolicLink()) {
        throw new StagingError("staging destination already exists");
    }
    const temp = join(root, `.${name}.tmp`);
    let fd: number | null = null;
    try {
        fd = openSync(temp, "wx", 0o600);
        // writeSync can return short without throwing (signal interruption,
        // filesystem pressure); publishing a truncated draft would silently
        // lose records, so loop until every encoded byte is persisted.
        const bytes = Buffer.from(content, "utf8");
        let written = 0;
        while (written < bytes.length) {
            const n = writeSync(fd, bytes, written, bytes.length - written);
            if (n <= 0) throw new StagingError("staging write made no progress");
            written += n;
        }
        closeSync(fd);
        fd = null;
        chmodSync(temp, 0o600);
        renameSync(temp, destination);
    } catch (error) {
        if (fd !== null) closeSync(fd);
        try {
            unlinkSync(temp);
        } catch {
            /* already gone */
        }
        throw error;
    }
    return destination;
}

/** Delete staged entries older than the TTL. */
export function purgeStaleDrafts(root: string, nowMs: number, ttlMs = DRAFT_TTL_MS): void {
    let entries: string[];
    try {
        entries = readdirSync(root);
    } catch {
        return;
    }
    for (const entry of entries) {
        const path = join(root, entry);
        try {
            if (nowMs - lstatSync(path).mtimeMs > ttlMs) {
                rmSync(path, { force: true, recursive: true });
            }
        } catch {
            /* raced with another purge */
        }
    }
}

/** Canonicalized so the symlink-alias staging check holds on platforms whose
 *  temp directory itself sits behind a symlink (macOS `/var` -> `/private/var`). */
export function defaultStagingRoot(): string {
    return join(realpathSync.native(tmpdir()), "magic-context-benchmark-drafts");
}

const REQUIRED_TABLES: Record<string, readonly string[]> = {
    embedding_measurement_corpus: ["id", "session_id", "project_path", "query_text_hash"],
    session_projects: ["session_id", "harness", "project_path"],
};

/** Validate schema and bounded row shapes before any reconstruction. */
export function validateMeasurementSchema(db: Database): void {
    for (const [table, columns] of Object.entries(REQUIRED_TABLES)) {
        const present = db
            .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table);
        if (!present) throw new StagingError("source schema is missing a required table");
        const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        const names = new Set(info.map((c) => c.name));
        for (const column of columns) {
            if (!names.has(column)) {
                throw new StagingError("source schema is missing a required column");
            }
        }
    }
}

export function boundedRowsOrThrow(
    rows: ReturnType<typeof listMeasurementRowsWithOwnership>,
    baseOrdinal = 0,
): RecoveryInputRow[] {
    return rows.map((row, i) => {
        if (!/^[0-9a-f]{64}$/.test(row.queryTextHash) || row.sessionId.length > 256) {
            throw new StagingError("source row shape is out of bounds");
        }
        return {
            ordinal: baseOrdinal + i,
            sessionId: row.sessionId,
            queryTextHash: row.queryTextHash,
            ownership: row.ownership,
        };
    });
}

/** Keyset page size for the measurement-corpus read. Bounds the per-query
 *  buffer; the read transaction held across pages keeps them one snapshot. */
const MEASUREMENT_PAGE_SIZE = 5_000;

export async function runRecovery(args: {
    measurementDb: Database;
    historyDb: Database;
    stagingRoot: string;
    forbiddenRoots: readonly string[];
    /** Passed through to the privacy gate on every recovered candidate. */
    forbiddenTokens?: readonly string[];
    forbiddenIdentifiers?: readonly string[];
    nowMs?: number;
}): Promise<{ draftPath: string; reportPath: string; report: RecoveryReport }> {
    const nowMs = args.nowMs ?? Date.now();
    const root = ensureStagingRoot(args.stagingRoot, args.forbiddenRoots);
    purgeStaleDrafts(root, nowMs);

    validateMeasurementSchema(args.measurementDb);

    // One read transaction per connection, held across every read on that
    // connection, so concurrent plugin activity (corpus pruning, session
    // purge) cannot shift rows between the corpus and history phases of one
    // run. Read-only work: end with ROLLBACK, and never let transaction
    // teardown mask the original error. Only connections whose BEGIN
    // completed are rolled back — a failed second BEGIN must not leave the
    // first connection holding an open transaction.
    const endRead = (db: Database) => {
        try {
            db.exec("ROLLBACK");
        } catch {
            /* connection already closed or transaction never started */
        }
    };
    const began: Database[] = [];
    let rows: RecoveryInputRow[];
    const candidatesBySession = new Map<string, readonly QueryCandidate[]>();
    const allCandidateHashes = new Set<string>();
    try {
        for (const db of [args.measurementDb, args.historyDb]) {
            db.exec("BEGIN");
            began.push(db);
            // Deferred BEGIN takes its snapshot on the FIRST READ, not at
            // BEGIN. Pin both snapshots now, so history written during the
            // (potentially long) measurement page scan cannot make the
            // history phase see a different database state than the rows.
            db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get();
        }
        rows = [];
        let afterId = 0;
        for (;;) {
            const page = listMeasurementRowsWithOwnership(args.measurementDb, {
                afterId,
                limit: MEASUREMENT_PAGE_SIZE,
            });
            if (page.length === 0) break;
            rows.push(...boundedRowsOrThrow(page, rows.length));
            afterId = page[page.length - 1].id;
        }

        // Hashes each session's rows actually reference: candidate plaintext
        // outside this set is released immediately after hashing, so retained
        // text is bounded by the measurement rows (which the report already
        // scales with), not by total session history.
        const rowHashesBySession = new Map<string, Set<string>>();
        for (const row of rows) {
            if (row.ownership !== "opencode") continue;
            let hashes = rowHashesBySession.get(row.sessionId);
            if (!hashes) {
                hashes = new Set();
                rowHashesBySession.set(row.sessionId, hashes);
            }
            hashes.add(row.queryTextHash);
        }

        // One session hydrated at a time; its raw messages and unreferenced
        // candidate text are released as soon as the row-referenced subset is
        // extracted. The full hash union survives (hashes only, no text) so
        // cross-session-only classification stays exact.
        for (const [sessionId, rowHashes] of rowHashesBySession) {
            const kept: QueryCandidate[] = [];
            for (const candidate of collectSessionCandidates(
                readRawSessionMessagesFromDb(args.historyDb, sessionId),
            )) {
                const hash = normalizedQueryHash(candidate.text);
                allCandidateHashes.add(hash);
                if (rowHashes.has(hash)) kept.push(candidate);
            }
            candidatesBySession.set(sessionId, kept);
        }
    } finally {
        for (const db of began) endRead(db);
    }

    const { draft, report } = recoverCandidates({
        rows,
        candidatesBySession,
        knownHashes: allCandidateHashes,
        forbiddenTokens: args.forbiddenTokens,
        forbiddenIdentifiers: args.forbiddenIdentifiers,
    });
    // Each run stages into its own mkdtemp subdirectory (0o700), created only
    // once there is something to write: re-running within the TTL never
    // collides with a previous run's draft.json, failures never leave an
    // empty run directory behind, and stale runs age out through the purge.
    const runDir = mkdtempSync(join(root, "run-"));
    let draftPath: string;
    let reportPath: string;
    try {
        draftPath = writeStagedFileAtomically(
            runDir,
            "draft.json",
            `${JSON.stringify(draft, null, 2)}\n`,
        );
        reportPath = writeStagedFileAtomically(
            runDir,
            "report.json",
            `${JSON.stringify(report, null, 2)}\n`,
        );
    } catch (error) {
        rmSync(runDir, { recursive: true, force: true });
        throw error;
    }
    return { draftPath, reportPath, report };
}

async function main(): Promise<void> {
    const { Database: BunDatabase } = await import("bun:sqlite");
    const measurementPath =
        process.env.MAGIC_CONTEXT_DB ??
        join(homedir(), ".local", "share", "cortexkit", "magic-context", "context.db");
    const historyPath =
        process.env.OPENCODE_DB ?? join(homedir(), ".local", "share", "opencode", "opencode.db");
    const measurementDb = new BunDatabase(measurementPath, { readonly: true });
    const historyDb = new BunDatabase(historyPath, { readonly: true });
    try {
        // The privacy scan is host-independent by design; the author host's
        // identity is checked here, at authoring time. The home path matches
        // as a substring; the username matches as a bounded identifier so a
        // short account name does not reject every word containing it.
        const { report, draftPath } = await runRecovery({
            measurementDb: measurementDb as unknown as Database,
            historyDb: historyDb as unknown as Database,
            stagingRoot: defaultStagingRoot(),
            forbiddenRoots: [dirname(measurementPath), dirname(historyPath), import.meta.dir],
            forbiddenTokens: [homedir()].filter((token) => token.length > 0),
            forbiddenIdentifiers: [userInfo().username].filter((token) => token.length > 0),
        });
        // Allowlisted output only: status codes and counts, never text/ids.
        process.stdout.write(`${JSON.stringify(report.counts)}\ndraft: ${draftPath}\n`);
    } finally {
        measurementDb.close();
        historyDb.close();
    }
}

if (import.meta.main) {
    await main();
}
