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

/** Candidate queries from one session's raw history, in message order,
 *  through the same extraction the live automatic and explicit paths use. */
export function collectSessionCandidates(
    messages: readonly RawMessage[],
    options: {
        /** Message ids with persisted evidence that the automatic path ran
         *  past its gates (a recorded hint/no-hint decision other than
         *  stacked/too-short). When provided, only those messages yield
         *  automatic candidates: configuration-dependent gates (auto-search
         *  disabled, minPromptChars) cannot be re-derived from text alone,
         *  and guessing records phantom automatic candidates. */
        autoSearchRanMessageIds?: ReadonlySet<string>;
    } = {},
): QueryCandidate[] {
    const candidates: QueryCandidate[] = [];
    for (const message of messages) {
        // Same eligibility gates as the live automatic path: messages that
        // are ignored/system-directive-only or already carry a stacked
        // augmentation never ran auto-search in production, so recording
        // them here could misclassify a same-text explicit measurement as
        // mode-ambiguous or recover it under the wrong mode.
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
        // Tool calls are assistant turns. The paged history reader keeps a
        // malformed-parent row as role "unknown" (the full reader dropped
        // it), so gating on the role keeps paging from changing candidate
        // semantics — and a ctx_search part under any other role is not a
        // production shape.
        if (message.role !== "assistant") continue;
        for (const part of message.parts) {
            if (part === null || typeof part !== "object") continue;
            const p = part as Record<string, unknown>;
            if (p.type !== "tool" || p.tool !== CTX_SEARCH_TOOL_NAME) continue;
            const state = p.state as Record<string, unknown> | null;
            if (!state || typeof state !== "object") continue;
            // Only completed calls: pending, running, canceled, and errored
            // parts never executed a search, so their input must not become
            // an explicit candidate. A completed call whose output is an
            // error string resolved before (or instead of) the measured
            // search path — project-resolution and bounds failures return
            // early with "Error: ..." — so it is no candidate either.
            if (state.status !== "completed") continue;
            if (typeof state.output === "string" && state.output.startsWith("Error:")) {
                continue;
            }
            const input = state.input;
            if (input === null || typeof input !== "object") continue;
            const preflight = extractCtxSearchQueryInput(input as CtxSearchArgs);
            if (preflight.ok && preflight.query.length > 0) {
                // ID-shaped queries can short-circuit to direct memory
                // lookup without ever reaching the measurement-producing
                // search path; whether they measured is unknowable from
                // history, so they are never candidates.
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
    // Component-aware containment with the platform separator: string-prefix
    // checks with a literal "/" miss descendant/ancestor overlaps on
    // Windows, where realpath returns backslash-separated paths.
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
        // Both directions: a staging root BELOW a forbidden tree could leak
        // drafts into it, and a staging root ABOVE one would let the stale-
        // draft purge recursively delete the forbidden tree as an old entry.
        if (contains(forbiddenReal, real)) {
            throw new StagingError("staging root overlaps a forbidden tree");
        }
        if (contains(real, forbiddenReal)) {
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

/** Delete recovery-owned staged entries (`run-*` directories and their
 *  legacy flat-file predecessors) older than the TTL. Anything else in the
 *  root is not ours to remove, even in an otherwise-valid staging root. */
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
            // Recovery-generated entries only: mkdtemp appends exactly six
            // characters to the "run-" prefix and creates a directory, so a
            // shared root's "run-notes.txt" or "run-production" is not ours.
            const isRunDir = /^run-[A-Za-z0-9]{6}$/.test(entry) && stat.isDirectory();
            const isLegacyDraft =
                (entry === "draft.json" || entry === "report.json") && stat.isFile();
            if (!isRunDir && !isLegacyDraft) continue;
            if (nowMs - stat.mtimeMs > ttlMs) {
                rmSync(path, { force: true, recursive: true });
            }
        } catch {
            /* raced with another purge */
        }
    }
}

/** Canonicalized so the symlink-alias staging check holds on platforms whose
 *  temp directory itself sits behind a symlink (macOS `/var` -> `/private/var`).
 *  Namespaced by effective UID: on a shared /tmp, one account's 0700 root
 *  would otherwise fail every other account's caller-ownership check (or be
 *  pre-created to deny recovery outright). */
export function defaultStagingRoot(): string {
    const owner = typeof process.getuid === "function" ? String(process.getuid()) : "user";
    return join(realpathSync.native(tmpdir()), `magic-context-benchmark-drafts-${owner}`);
}

const REQUIRED_TABLES: Record<string, readonly string[]> = {
    embedding_measurement_corpus: ["id", "session_id", "project_path", "query_text_hash"],
    session_projects: ["session_id", "harness", "project_path"],
    session_meta: ["session_id", "auto_search_hint_decisions"],
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

/** Page size for raw session history. One long-lived session's messages and
 *  parts are unbounded by the measurement cap, so hydration pages too. */
const HISTORY_PAGE_SIZE = 200;

interface HistoryPageKey {
    timeCreated: number;
    id: string;
}

/**
 * Keyset page of one session's raw messages, ordered like the shared
 * readers (time_created, id). LIMIT/OFFSET paging would re-skip the whole
 * preceding history per page — quadratic in exactly the long sessions
 * paging exists for — so the cursor is the ordering key itself. Candidate
 * extraction never consumes ordinals, so they are filled positionally.
 */
function readHistoryPageByKey(
    db: Database,
    sessionId: string,
    afterKey: HistoryPageKey | null,
    limit: number,
): { messages: RawMessage[]; nextKey: HistoryPageKey | null } {
    // Type predicates live in SQL so a returned page is well-formed by
    // construction: filtering in JS after the fact would let a full page of
    // malformed rows read as end-of-history while valid messages follow,
    // and rows with non-numeric time_created cannot join a keyset
    // comparison anyway. Malformed rows are skipped, matching the shared
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
            /* malformed message row: candidates require a well-formed role */
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
        // extracted. The retained hash union is intersected with the global
        // measurement-row hash set: the cross-session check only ever asks
        // about ROW hashes, so the intersection is exact while staying
        // bounded by the measurement rows rather than by session history.
        // A hash that exists only in sessions with no measurement rows
        // reports zero-match, a deliberate bound — labeling it would require
        // hydrating the entire history database for a diagnostic count that
        // recovers nothing either way.
        const globalRowHashes = new Set<string>();
        for (const hashes of rowHashesBySession.values()) {
            for (const hash of hashes) globalRowHashes.add(hash);
        }
        for (const [sessionId, rowHashes] of rowHashesBySession) {
            // Persisted decision provenance: reasons recorded BEFORE the
            // search gate (stacked, too-short) mean no automatic query ran;
            // every other recorded decision means it did. Messages with no
            // decision at all yield no automatic candidate — recovery
            // requires evidence, not inference.
            const ranIds = new Set<string>();
            for (const decision of getAutoSearchHintDecisions(args.measurementDb, sessionId)) {
                if (
                    decision.decision === "hint" ||
                    (decision.reason !== "stacked" && decision.reason !== "too-short")
                ) {
                    ranIds.add(decision.messageId);
                }
            }
            // Candidate extraction is per-message, so history pages can be
            // hashed and released one at a time; a single long-lived
            // session never materializes in full.
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
                    // Dedup on (text, mode) during paging, not only inside
                    // the matcher: a prompt repeated across a long session
                    // must not retain one copy per repetition.
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
