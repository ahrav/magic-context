#!/usr/bin/env bun
/**
 *
 *
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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
    type MeasurementOwnership,
    listMeasurementRowsWithOwnership,
    normalizeQueryText,
    normalizedQueryHash,
} from "../src/features/magic-context/storage-embedding-measurements";
import { getAutoSearchHintDecisions } from "../src/features/magic-context/storage-meta-persisted";
import { extractBoundedAutoSearchQuery } from "../src/hooks/magic-context/auto-search-prompt";
import {
    collectUserPromptParts,
    hasStackedAugmentation,
} from "../src/hooks/magic-context/auto-search-runner";
import { hasMeaningfulUserText } from "../src/hooks/magic-context/read-session-formatting";
import type { RawMessage } from "../src/hooks/magic-context/read-session-raw";
import { parseIdShapedQuery } from "../src/features/magic-context/search";
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

/**
 * */
export function collectSessionCandidates(
    messages: readonly RawMessage[],
    options: {
        /**
         * */
        autoSearchRanMessageIds?: ReadonlySet<string>;
    } = {},
): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    for (const message of messages) {
        if (
            message.role === "user" &&
            hasMeaningfulUserText(message.parts) &&
            (options.autoSearchRanMessageIds === undefined ||
                options.autoSearchRanMessageIds.has(message.id))
        ) {
            const collected = collectUserPromptParts({
                info: { role: message.role, id: message.id },
                parts: message.parts,
            });
            if (!hasStackedAugmentation(collected)) {
                const auto = extractBoundedAutoSearchQuery(collected);
                if (auto.length > 0) candidates.push({ text: auto, mode: "automatic" });
            }
        }
        // production shape.
        if (message.role !== "assistant") continue;
        for (const part of message.parts) {
            if (part === null || typeof part !== "object") continue;
            const p = part as Record<string, unknown>;
            if (p.type !== "tool" || p.tool !== CTX_SEARCH_TOOL_NAME) continue;
            const state = p.state as Record<string, unknown> | null;
            if (!state || typeof state !== "object") continue;
            if (state.status !== "completed") continue;
            if (typeof state.output === "string" && state.output.startsWith("Error:")) {
                continue;
            }
            const input = state.input;
            if (input === null || typeof input !== "object") continue;
            const preflight = extractCtxSearchQueryInput(input as CtxSearchArgs);
            if (preflight.ok && preflight.query.length > 0) {
                if (parseIdShapedQuery(preflight.query) !== null) continue;
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
 * `hashCandidate` permits testing hash collisions; it defaults to `normalizedQueryHash`.
 * `normalizedQueryHash`.
 */
export function recoverCandidates(args: {
    rows: readonly RecoveryInputRow[];
    candidatesBySession: ReadonlyMap<string, readonly QueryCandidate[]>;
    /** `knownHashes` distinguishes cross-session-only hashes from zero-match hashes when `candidatesBySession` is bounded.
     * */
    knownHashes?: ReadonlySet<string>;
    /** `forbiddenTokens` rejects candidates containing any listed substring.
     * */
    forbiddenTokens?: readonly string[];
    /**
     * `forbiddenIdentifiers` rejects standalone, word-bounded occurrences so short identifiers do not match substrings. */
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
            // Deduplication preserves entries with identical text and different modes so provenance does not depend on message order.
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
 * The staging root must be caller-owned and outside every forbidden tree.
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
    // Containment checks must use the platform separator because `realpath` uses backslashes on Windows.
    // Literal `/` containment checks miss descendant and ancestor overlaps on Windows.
    const contains = (parent: string, child: string): boolean => {
        const rel = relative(parent, child);
        return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    for (const forbidden of forbiddenRoots) {
        let forbiddenReal: string;
        try {
            forbiddenReal = realpathSync.native(resolve(forbidden));
        } catch {
            continue;
        }
        // A staging root below a forbidden tree could leak drafts into that tree.
        // A staging root above a forbidden tree lets stale-draft purging recursively delete that tree as an old entry.
        if (contains(forbiddenReal, real)) {
            throw new StagingError("staging root overlaps a forbidden tree");
        }
        if (contains(real, forbiddenReal)) {
            throw new StagingError("staging root contains a forbidden tree");
        }
    }
    return real;
}

/** The writer creates an exclusive temporary file and never overwrites an existing destination. */
export function writeStagedFileAtomically(root: string, name: string, content: string): string {
    const destination = join(root, name);
    if (existsSync(destination) || lstatSync(root).isSymbolicLink()) {
        throw new StagingError("staging destination already exists");
    }
    const temp = join(root, `.${name}.tmp`);
    let fd: number | null = null;
    try {
        fd = openSync(temp, "wx", 0o600);
        // writeSync can return fewer bytes than requested without throwing.
        // The writer loops until `writeSync` persists every encoded byte because `writeSync` can return a short write without throwing.
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

/** The purger deletes only recovery-owned `run-*` directories and legacy flat-file entries older than the TTL.
 * Recovery never removes the staging root. */
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
            const stat = lstatSync(path);
            // Recovery owns only directories whose names are `run-` followed by exactly six characters.
            // `mkdtemp` creates a directory named `run-` plus exactly six characters.
            const isRunDir = /^run-[A-Za-z0-9]{6}$/.test(entry) && stat.isDirectory();
            const isLegacyDraft =
                (entry === "draft.json" || entry === "report.json") && stat.isFile();
            if (!isRunDir && !isLegacyDraft) continue;
            if (nowMs - stat.mtimeMs > ttlMs) {
                rmSync(path, { force: true, recursive: true });
            }
        } catch {
            /* */
        }
    }
}

/** The staging path is canonicalized so symlink-alias checks work when macOS maps `/var` to `/private/var`.
 * The default staging root includes the effective UID so callers sharing `/tmp` use separate roots.
 * Without UID namespacing, one account's `0700` root would fail other accounts' caller-ownership checks.
 * Without UID namespacing, another account could pre-create the shared root and prevent recovery. */
export function defaultStagingRoot(): string {
    const owner = typeof process.getuid === "function" ? String(process.getuid()) : "user";
    return join(realpathSync.native(tmpdir()), `magic-context-benchmark-drafts-${owner}`);
}

const REQUIRED_TABLES: Record<string, readonly string[]> = {
    embedding_measurement_corpus: ["id", "session_id", "project_path", "query_text_hash"],
    session_projects: ["session_id", "harness", "project_path"],
    session_meta: ["session_id", "auto_search_hint_decisions"],
};

/** Malformed rows must not produce reconstructed records. */
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

/**
 * The read transaction spans all pages, so buffered rows come from one snapshot. */
const MEASUREMENT_PAGE_SIZE = 5_000;

/**
 * The hydrator pages messages and parts because one long-lived session can exceed the measurement cap. */
const HISTORY_PAGE_SIZE = 200;

interface HistoryPageKey {
    timeCreated: number;
    id: string;
}

/**
 * The message reader keyset-pages each session by `(time_created, id)`, matching the shared readers' order.
 * The reader uses `(time_created, id)` keyset paging because LIMIT/OFFSET rescans preceding rows for every page.
 * `LIMIT/OFFSET` would rescan all preceding messages for every page, making long sessions quadratic.
 * Candidate extraction never consumes ordinals, so records fill them positionally.
 */
function readHistoryPageByKey(
    db: Database,
    sessionId: string,
    afterKey: HistoryPageKey | null,
    limit: number,
): { messages: RawMessage[]; nextKey: HistoryPageKey | null } {
    // `SHAPE` filters invalidly typed rows in SQL so they cannot consume `LIMIT` slots before valid rows.
    // `SHAPE` excludes nonnumeric `time_created` values because keyset comparison requires numeric values.
    // readers' behavior.
    const SHAPE = `typeof(id) = 'text' AND typeof(data) = 'text'
                     AND typeof(time_created) IN ('integer', 'real')`;
    const messageRows = (
        afterKey === null
            ? db
                  .prepare(
                      `SELECT id, data, time_created FROM message
                        WHERE session_id = ? AND ${SHAPE}
                        ORDER BY time_created ASC, id ASC
                        LIMIT ?`,
                  )
                  .all(sessionId, limit)
            : db
                  .prepare(
                      `SELECT id, data, time_created FROM message
                        WHERE session_id = ? AND ${SHAPE}
                          AND (time_created > ? OR (time_created = ? AND id > ?))
                        ORDER BY time_created ASC, id ASC
                        LIMIT ?`,
                  )
                  .all(sessionId, afterKey.timeCreated, afterKey.timeCreated, afterKey.id, limit)
    ) as Array<{ id: unknown; data: unknown; time_created: unknown }>;
    const wellFormed = messageRows.filter(
        (row): row is { id: string; data: string; time_created: number } =>
            typeof row.id === "string" &&
            typeof row.data === "string" &&
            typeof row.time_created === "number",
    );
    if (wellFormed.length === 0) return { messages: [], nextKey: null };

    const placeholders = wellFormed.map(() => "?").join(", ");
    const partRows = db
        .prepare(
            `SELECT message_id, data FROM part
              WHERE session_id = ? AND message_id IN (${placeholders})
              ORDER BY time_created ASC, id ASC`,
        )
        .all(sessionId, ...wellFormed.map((row) => row.id)) as Array<{
        message_id: unknown;
        data: unknown;
    }>;
    const partsByMessageId = new Map<string, unknown[]>();
    for (const part of partRows) {
        if (typeof part.message_id !== "string" || typeof part.data !== "string") continue;
        const list = partsByMessageId.get(part.message_id) ?? [];
        try {
            list.push(JSON.parse(part.data));
        } catch {
            list.push(null);
        }
        partsByMessageId.set(part.message_id, list);
    }

    const messages: RawMessage[] = [];
    for (const [index, row] of wellFormed.entries()) {
        let info: Record<string, unknown> | null = null;
        try {
            const parsed = JSON.parse(row.data);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                info = parsed as Record<string, unknown>;
            }
        } catch {
            /* */
        }
        messages.push({
            ordinal: index + 1,
            id: row.id,
            role: typeof info?.role === "string" ? info.role : "unknown",
            parts: partsByMessageId.get(row.id) ?? [],
            createdAt: row.time_created,
            version: null,
        });
    }
    const last = wellFormed[wellFormed.length - 1];
    return { messages, nextKey: { timeCreated: last.time_created, id: last.id } };
}

export async function runRecovery(args: {
    measurementDb: Database;
    historyDb: Database;
    stagingRoot: string;
    forbiddenRoots: readonly string[];
    /* */
    forbiddenTokens?: readonly string[];
    forbiddenIdentifiers?: readonly string[];
    nowMs?: number;
}): Promise<{ draftPath: string; reportPath: string; report: RecoveryReport }> {
    const nowMs = args.nowMs ?? Date.now();
    const root = ensureStagingRoot(args.stagingRoot, args.forbiddenRoots);
    purgeStaleDrafts(root, nowMs);

    validateMeasurementSchema(args.measurementDb);

    // Each connection holds one read transaction across the run, preventing concurrent pruning or purging from shifting rows between corpus and history reads.
    // `endRead` rolls back read-only transactions without masking the original error.
    // `began` contains only connections whose `BEGIN` succeeded; a failed second `BEGIN` leaves the first transaction open.
    const endRead = (db: Database) => {
        try {
            db.exec("ROLLBACK");
        } catch {
            /* */
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
            // A deferred `BEGIN` establishes its snapshot on the first read, not at `BEGIN`.
            // The immediate reads establish both snapshots before later history writes.
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

        // `rowHashesBySession` retains hashes referenced by measurement rows; other candidate plaintext is released after hashing.
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

        // The hydration loop processes one session at a time and retains only hashes in `globalRowHashes`.
        // Hashes found only in sessions without measurement rows report zero-match because labeling them requires hydrating the entire history database.
        const globalRowHashes = new Set<string>();
        for (const hashes of rowHashesBySession.values()) {
            for (const hash of hashes) globalRowHashes.add(hash);
        }
        for (const [sessionId, rowHashes] of rowHashesBySession) {
            // A "hint" decision or a decision whose reason is neither "stacked" nor "too-short" marks the message as having run an automatic query.
            const ranIds = new Set<string>();
            for (const decision of getAutoSearchHintDecisions(args.measurementDb, sessionId)) {
                if (
                    decision.decision === "hint" ||
                    (decision.reason !== "stacked" && decision.reason !== "too-short")
                ) {
                    ranIds.add(decision.messageId);
                }
            }
            // The loop processes each history page independently, so it never materializes a session's full history.
            const kept: QueryCandidate[] = [];
            const keptKeys = new Set<string>();
            let afterKey: HistoryPageKey | null = null;
            for (;;) {
                const page = readHistoryPageByKey(
                    args.historyDb,
                    sessionId,
                    afterKey,
                    HISTORY_PAGE_SIZE,
                );
                if (page.messages.length === 0) break;
                for (const candidate of collectSessionCandidates(page.messages, {
                    autoSearchRanMessageIds: ranIds,
                })) {
                    const hash = normalizedQueryHash(candidate.text);
                    if (globalRowHashes.has(hash)) allCandidateHashes.add(hash);
                    if (!rowHashes.has(hash)) continue;
                    // The page loop retains one candidate per `(text, mode)` across pages.
                    const key = `${candidate.mode}\u0000${candidate.text}`;
                    if (keptKeys.has(key)) continue;
                    keptKeys.add(key);
                    kept.push(candidate);
                }
                afterKey = page.nextKey;
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
        const { report, draftPath } = await runRecovery({
            measurementDb: measurementDb as unknown as Database,
            historyDb: historyDb as unknown as Database,
            stagingRoot: defaultStagingRoot(),
            forbiddenRoots: [dirname(measurementPath), dirname(historyPath), import.meta.dir],
            forbiddenTokens: [homedir()].filter((token) => token.length > 0),
            forbiddenIdentifiers: [userInfo().username].filter((token) => token.length > 0),
        });
        process.stdout.write(`${JSON.stringify(report.counts)}\ndraft: ${draftPath}\n`);
    } finally {
        measurementDb.close();
        historyDb.close();
    }
}

if (import.meta.main) {
    await main();
}
