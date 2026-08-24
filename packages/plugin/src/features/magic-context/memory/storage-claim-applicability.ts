/**
 * Transaction-local writers and readers for the v85 claim applicability
 * ledger: first-class immutable streams, gapless append-only assertions,
 * path/symbol selectors, and the derived interval view.
 *
 * Type-only, `node:`, and explicit-`.ts` sibling imports keep this module
 * loadable by the Node SQLite smoke script, whose loader cannot resolve
 * extensionless runtime imports.
 *
 * Write protocol: every writer assumes the caller holds a write transaction
 * (the storage-claims.ts `...InCurrentTransaction` convention). Appends go
 * through the current stream head only; a fork, sequence gap, reused
 * predecessor, or regressing recorded/knowledge time fails before any row is
 * written, with the database triggers as the cross-process backstop.
 */

import { createHash } from "node:crypto";
import type { Database } from "../../../shared/sqlite.ts";
import {
    APPLICABILITY_STREAM_KEY_PROTOCOL,
    type ApplicabilityOwnerKind,
    type ApplicabilityPathKind,
    type ApplicabilityPathsState,
    type ApplicabilityState,
} from "../storage-claim-applicability-schema.ts";

export class ApplicabilityWriteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ApplicabilityWriteError";
    }
}

/**
 * Positive schema probes memoized per connection: the v85 tables are never
 * dropped outside test fixtures, so `true` is stable for a connection's
 * lifetime. A negative probe re-checks so a migration completing later in
 * the same process is observed.
 */
const applicabilitySchemaPresent = new WeakSet<Database>();

/** Whether this database migrated to v85. */
export function hasClaimApplicabilitySchema(db: Database): boolean {
    if (applicabilitySchemaPresent.has(db)) return true;
    const present =
        db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claim_revision_applicability_streams'",
            )
            .get() != null;
    if (present) applicabilitySchemaPresent.add(db);
    return present;
}

/**
 * Recursively key-sorted clone so the digest is independent of object-key
 * insertion order: semantically identical sources always hash to one value.
 */
function sortKeysDeep(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return Object.fromEntries(
            Object.keys(record)
                .sort()
                .map((key) => [key, sortKeysDeep(record[key])]),
        );
    }
    return value;
}

/** Canonical SHA-256 digest over a JSON-serializable source description. */
export function computeApplicabilitySourceDigest(source: unknown): string {
    return createHash("sha256")
        .update(JSON.stringify(sortKeysDeep(source)) ?? "null", "utf8")
        .digest("hex");
}

/** Versioned deterministic stream key for a legacy memory link (KTD3). */
export function legacyMemoryApplicabilityStreamKey(memoryId: number): string {
    return `legacy-memory:${memoryId}:v1`;
}

function toRowId(result: unknown): number {
    const rowid = (result as { lastInsertRowid?: number | bigint }).lastInsertRowid;
    const value = Number(rowid);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`insert did not produce a safe row id: ${String(rowid)}`);
    }
    return value;
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

export interface EnsureApplicabilityStreamInput {
    revisionId: number;
    projectId: number;
    ownerKind: ApplicabilityOwnerKind;
    streamKey: string;
    keyProtocol: string;
    sourceDigest: string;
    branchSelector?: string | null;
    contextFingerprint?: string | null;
}

export interface ApplicabilityStreamHandle {
    streamId: number;
    created: boolean;
}

interface StreamRow {
    id: number;
    project_id: number;
    owner_kind: string;
    key_protocol: string;
    source_digest: string;
    branch_selector: string | null;
    context_fingerprint: string | null;
}

/**
 * Idempotent stream resolution (KTD3): replay with the stored key verifies
 * the source digest and lineage fields instead of allocating a duplicate
 * stream; a mismatch is a defect, not a new stream.
 */
export function ensureApplicabilityStreamInCurrentTransaction(
    db: Database,
    input: EnsureApplicabilityStreamInput,
): ApplicabilityStreamHandle {
    if (input.ownerKind === "evaluation" && !input.contextFingerprint) {
        throw new ApplicabilityWriteError(
            "evaluation applicability streams require a context fingerprint",
        );
    }
    const existing = db
        .prepare(
            `SELECT id, project_id, owner_kind, key_protocol, source_digest, branch_selector, context_fingerprint
               FROM claim_revision_applicability_streams
              WHERE revision_id = ? AND stream_key = ?`,
        )
        .get(input.revisionId, input.streamKey) as StreamRow | undefined;
    if (existing) {
        const mismatches: string[] = [];
        if (existing.source_digest !== input.sourceDigest) mismatches.push("source digest");
        if (existing.project_id !== input.projectId) mismatches.push("project");
        if (existing.owner_kind !== input.ownerKind) mismatches.push("owner kind");
        if (existing.key_protocol !== input.keyProtocol) mismatches.push("key protocol");
        if (existing.branch_selector !== (input.branchSelector ?? null)) {
            mismatches.push("branch selector");
        }
        if (existing.context_fingerprint !== (input.contextFingerprint ?? null)) {
            mismatches.push("context fingerprint");
        }
        if (mismatches.length > 0) {
            throw new ApplicabilityWriteError(
                `applicability stream ${input.streamKey} for revision ${input.revisionId} replayed with different ${mismatches.join(", ")}`,
            );
        }
        return { streamId: existing.id, created: false };
    }
    const streamId = toRowId(
        db
            .prepare(
                `INSERT INTO claim_revision_applicability_streams
                    (revision_id, project_id, owner_kind, stream_key, key_protocol,
                     source_digest, branch_selector, context_fingerprint, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                input.revisionId,
                input.projectId,
                input.ownerKind,
                input.streamKey,
                input.keyProtocol,
                input.sourceDigest,
                input.branchSelector ?? null,
                input.contextFingerprint ?? null,
                Date.now(),
            ),
    );
    return { streamId, created: true };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export type ApplicabilityPathsInput =
    | { state: Extract<ApplicabilityPathsState, "unknown"> }
    | {
          state: Extract<ApplicabilityPathsState, "known">;
          exact?: readonly string[];
          glob?: readonly string[];
      };

export interface ApplicabilitySymbolInput {
    protocol: string;
    value: string;
}

export interface AppendApplicabilityAssertionInput {
    streamId: number;
    state: ApplicabilityState;
    paths: ApplicabilityPathsInput;
    symbols?: readonly ApplicabilitySymbolInput[];
    validFromAnchorId?: number | null;
    validUntilAnchorId?: number | null;
    evaluatedAgainstAnchorId?: number | null;
    knownFrom?: number | null;
    recordedAt?: number;
    dependencyFingerprint?: string | null;
    dependencyProtocol?: string | null;
    verifierSpec?: string | null;
}

export interface ApplicabilityAssertionHandle {
    assertionId: number;
    seq: number;
}

interface AssertionHeadRow {
    id: number;
    seq: number;
    recorded_at: number;
    known_from: number | null;
}

/** Highest non-NULL knowledge time recorded anywhere in the stream. */
function maxStreamKnownFrom(db: Database, streamId: number): number | null {
    const row = db
        .prepare(
            `SELECT MAX(known_from) AS max FROM claim_revision_applicability_assertions
              WHERE stream_id = ?`,
        )
        .get(streamId) as { max: number | null } | undefined;
    return row?.max ?? null;
}

function normalizePathValues(kind: string, values: readonly string[]): string[] {
    const unique = new Set<string>();
    for (const value of values) {
        if (value.length === 0) {
            throw new ApplicabilityWriteError(`empty ${kind} path selector`);
        }
        unique.add(value);
    }
    return [...unique].sort();
}

function normalizeSymbols(
    symbols: readonly ApplicabilitySymbolInput[],
): ApplicabilitySymbolInput[] {
    const protocols = new Set(symbols.map((symbol) => symbol.protocol));
    if (protocols.size > 1) {
        throw new ApplicabilityWriteError(
            `conflicting symbol selector protocols in one assertion: ${[...protocols].sort().join(", ")}`,
        );
    }
    const byValue = new Map<string, ApplicabilitySymbolInput>();
    for (const symbol of symbols) {
        if (symbol.protocol.length === 0 || symbol.value.length === 0) {
            throw new ApplicabilityWriteError("symbol selectors require a protocol and value");
        }
        byValue.set(`${symbol.protocol}\u0000${symbol.value}`, symbol);
    }
    return [...byValue.values()];
}

/**
 * Append the next assertion at the stream head. Recorded time is clamped
 * forward to the head's recorded time (SQLite wall clocks can regress across
 * processes); an explicitly supplied regressing recorded or knowledge time
 * fails instead. Knowledge time compares against the stream-wide maximum so
 * a NULL known_from gap cannot reopen an older knowledge time.
 */
export function appendApplicabilityAssertionInCurrentTransaction(
    db: Database,
    input: AppendApplicabilityAssertionInput,
): ApplicabilityAssertionHandle {
    const head = db
        .prepare(
            `SELECT id, seq, recorded_at, known_from
               FROM claim_revision_applicability_assertions
              WHERE stream_id = ?
              ORDER BY seq DESC LIMIT 1`,
        )
        .get(input.streamId) as AssertionHeadRow | undefined;

    let recordedAt = input.recordedAt ?? Date.now();
    if (head) {
        if (input.recordedAt !== undefined && input.recordedAt < head.recorded_at) {
            throw new ApplicabilityWriteError(
                `assertion recorded time ${input.recordedAt} regresses behind stream head ${head.recorded_at}`,
            );
        }
        recordedAt = Math.max(recordedAt, head.recorded_at);
        const maxKnownFrom = maxStreamKnownFrom(db, input.streamId);
        if (input.knownFrom != null && maxKnownFrom != null && input.knownFrom < maxKnownFrom) {
            throw new ApplicabilityWriteError(
                `assertion knowledge time ${input.knownFrom} regresses behind stream maximum ${maxKnownFrom}`,
            );
        }
    }
    if (input.validUntilAnchorId != null && input.validFromAnchorId == null) {
        throw new ApplicabilityWriteError(
            "a valid-until anchor requires the valid-from anchor of its half-open interval",
        );
    }
    if (input.dependencyFingerprint != null && !input.dependencyProtocol) {
        throw new ApplicabilityWriteError(
            "a dependency fingerprint requires its canonicalization protocol",
        );
    }
    const exact =
        input.paths.state === "known" ? normalizePathValues("exact", input.paths.exact ?? []) : [];
    const glob =
        input.paths.state === "known" ? normalizePathValues("glob", input.paths.glob ?? []) : [];
    const symbols = normalizeSymbols(input.symbols ?? []);

    const assertionId = toRowId(
        db
            .prepare(
                `INSERT INTO claim_revision_applicability_assertions
                    (stream_id, seq, predecessor_id, state, valid_from_anchor_id,
                     valid_until_anchor_id, evaluated_against_anchor_id, known_from,
                     recorded_at, paths_state, dependency_fingerprint, dependency_protocol,
                     verifier_spec)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                input.streamId,
                head ? head.seq + 1 : 1,
                head ? head.id : null,
                input.state,
                input.validFromAnchorId ?? null,
                input.validUntilAnchorId ?? null,
                input.evaluatedAgainstAnchorId ?? null,
                input.knownFrom ?? null,
                recordedAt,
                input.paths.state,
                input.dependencyFingerprint ?? null,
                input.dependencyProtocol ?? null,
                input.verifierSpec ?? null,
            ),
    );
    const insertPath = db.prepare(
        "INSERT INTO claim_revision_applicability_paths (assertion_id, kind, value) VALUES (?, ?, ?)",
    );
    for (const value of exact) insertPath.run(assertionId, "exact", value);
    for (const value of glob) insertPath.run(assertionId, "glob", value);
    const insertSymbol = db.prepare(
        "INSERT INTO claim_revision_applicability_symbols (assertion_id, protocol, value) VALUES (?, ?, ?)",
    );
    for (const symbol of symbols) insertSymbol.run(assertionId, symbol.protocol, symbol.value);
    return { assertionId, seq: head ? head.seq + 1 : 1 };
}

// ---------------------------------------------------------------------------
// Revision-scoped composition used by claim writers
// ---------------------------------------------------------------------------

export interface RevisionApplicabilityInput {
    ownerKind: ApplicabilityOwnerKind;
    streamKey: string;
    keyProtocol: string;
    sourceDigest: string;
    branchSelector?: string | null;
    contextFingerprint?: string | null;
    assertion: Omit<AppendApplicabilityAssertionInput, "streamId">;
}

/**
 * One stream plus its opening (or successor) assertion for a just-inserted
 * revision. Claim writers call this between the revision insert and the
 * final pointer CAS so revision, evidence, stream, assertion, and selectors
 * commit or roll back together.
 */
export function writeRevisionApplicabilityInCurrentTransaction(
    db: Database,
    args: {
        revisionId: number;
        projectId: number;
        applicability: RevisionApplicabilityInput;
    },
): ApplicabilityAssertionHandle {
    const stream = ensureApplicabilityStreamInCurrentTransaction(db, {
        revisionId: args.revisionId,
        projectId: args.projectId,
        ownerKind: args.applicability.ownerKind,
        streamKey: args.applicability.streamKey,
        keyProtocol: args.applicability.keyProtocol,
        sourceDigest: args.applicability.sourceDigest,
        branchSelector: args.applicability.branchSelector ?? null,
        contextFingerprint: args.applicability.contextFingerprint ?? null,
    });
    return appendApplicabilityAssertionInCurrentTransaction(db, {
        ...args.applicability.assertion,
        streamId: stream.streamId,
    });
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export interface ApplicabilityPathRecord {
    kind: ApplicabilityPathKind;
    value: string;
}

export interface ApplicabilitySymbolRecord {
    protocol: string;
    value: string;
}

export interface ApplicabilityAssertionRecord {
    assertionId: number;
    streamId: number;
    streamKey: string;
    ownerKind: ApplicabilityOwnerKind;
    branchSelector: string | null;
    contextFingerprint: string | null;
    seq: number;
    state: ApplicabilityState;
    validFromAnchorId: number | null;
    validUntilAnchorId: number | null;
    evaluatedAgainstAnchorId: number | null;
    knownFrom: number | null;
    recordedAt: number;
    pathsState: ApplicabilityPathsState;
    dependencyFingerprint: string | null;
    dependencyProtocol: string | null;
    verifierSpec: string | null;
    paths: ApplicabilityPathRecord[];
    symbols: ApplicabilitySymbolRecord[];
}

/**
 * Current head assertion per stream for one revision. An empty result means
 * the revision has no recorded applicability: readers treat it as `unknown`
 * (R13) rather than failing.
 */
export function readCurrentApplicabilityAssertions(
    db: Database,
    revisionId: number,
): ApplicabilityAssertionRecord[] {
    const rows = db
        .prepare(
            `SELECT assertion.id AS assertionId, stream.id AS streamId,
                    stream.stream_key AS streamKey, stream.owner_kind AS ownerKind,
                    stream.branch_selector AS branchSelector,
                    stream.context_fingerprint AS contextFingerprint,
                    assertion.seq AS seq, assertion.state AS state,
                    assertion.valid_from_anchor_id AS validFromAnchorId,
                    assertion.valid_until_anchor_id AS validUntilAnchorId,
                    assertion.evaluated_against_anchor_id AS evaluatedAgainstAnchorId,
                    assertion.known_from AS knownFrom, assertion.recorded_at AS recordedAt,
                    assertion.paths_state AS pathsState,
                    assertion.dependency_fingerprint AS dependencyFingerprint,
                    assertion.dependency_protocol AS dependencyProtocol,
                    assertion.verifier_spec AS verifierSpec
               FROM claim_revision_applicability_streams stream
               JOIN claim_revision_applicability_assertions assertion
                 ON assertion.stream_id = stream.id
              WHERE stream.revision_id = ?
                AND assertion.seq = (
                    SELECT MAX(seq) FROM claim_revision_applicability_assertions
                    WHERE stream_id = stream.id
                )
              ORDER BY stream.id`,
        )
        .all(revisionId) as Array<Omit<ApplicabilityAssertionRecord, "paths" | "symbols">>;
    const readPaths = db.prepare(
        `SELECT kind, value FROM claim_revision_applicability_paths
          WHERE assertion_id = ? ORDER BY kind, value`,
    );
    const readSymbols = db.prepare(
        `SELECT protocol, value FROM claim_revision_applicability_symbols
          WHERE assertion_id = ? ORDER BY protocol, value`,
    );
    return rows.map((row) => ({
        ...row,
        paths: readPaths.all(row.assertionId) as ApplicabilityPathRecord[],
        symbols: readSymbols.all(row.assertionId) as ApplicabilitySymbolRecord[],
    }));
}

export interface ApplicabilityIntervalRecord {
    assertionId: number;
    revisionId: number;
    streamId: number;
    seq: number;
    state: ApplicabilityState;
    validFromAnchorId: number | null;
    validUntilAnchorId: number | null;
    evaluatedAgainstAnchorId: number | null;
    knownFrom: number | null;
    knownUntil: number | null;
    recordedAt: number;
    recordedUntil: number | null;
    pathsState: ApplicabilityPathsState;
}

export function readApplicabilityIntervals(
    db: Database,
    revisionId: number,
): ApplicabilityIntervalRecord[] {
    return db
        .prepare(
            `SELECT assertion_id AS assertionId, revision_id AS revisionId,
                    stream_id AS streamId, seq, state,
                    valid_from_anchor_id AS validFromAnchorId,
                    valid_until_anchor_id AS validUntilAnchorId,
                    evaluated_against_anchor_id AS evaluatedAgainstAnchorId,
                    known_from AS knownFrom, known_until AS knownUntil,
                    recorded_at AS recordedAt, recorded_until AS recordedUntil,
                    paths_state AS pathsState
               FROM claim_revision_applicability_intervals
              WHERE revision_id = ?
              ORDER BY stream_id, seq`,
        )
        .all(revisionId) as ApplicabilityIntervalRecord[];
}

// ---------------------------------------------------------------------------
// Legacy-memory lineage helpers
// ---------------------------------------------------------------------------

/**
 * Known path state from a raw file list. Single owner of the `""` no-file
 * sentinel exclusion rule: a sentinel-only (or empty) list reads as
 * known-empty (file-independent). Both the write-time mapping snapshot and
 * the `memory_verifications` read-time derivation go through here so the
 * two sides of a `pathsStateEquals` comparison can never drift.
 */
export function knownPathsStateFromFiles(files: readonly string[]): ApplicabilityPathsInput {
    const exact = [...new Set(files.filter((file) => file.length > 0))].sort();
    return { state: "known", exact };
}

/**
 * Path knowledge for one legacy memory, derived from its
 * `memory_verifications` side table: no rows means unknown; rows mean known,
 * with the `""` no-file sentinel excluded so a sentinel-only mapping reads
 * as known-empty (file-independent).
 */
export function readMemoryVerificationPathsState(
    db: Database,
    memoryId: number,
): ApplicabilityPathsInput {
    const hasTable = db
        .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_verifications'",
        )
        .get();
    if (!hasTable) return { state: "unknown" };
    const rows = db
        .prepare("SELECT file_path FROM memory_verifications WHERE memory_id = ?")
        .all(memoryId) as Array<{ file_path: string }>;
    if (rows.length === 0) return { state: "unknown" };
    return knownPathsStateFromFiles(rows.map((row) => row.file_path));
}

export interface LegacyMemoryApplicabilitySource {
    id: number;
    first_seen_at: number;
}

/**
 * Latest plausible mapping time across a memory's verification rows. Rows
 * from before the mapping-time column carry the 0 default and are ignored.
 */
function latestMemoryVerificationMappedAt(db: Database, memoryId: number): number | null {
    const row = db
        .prepare("SELECT MAX(mapped_at) AS max FROM memory_verifications WHERE memory_id = ?")
        .get(memoryId) as { max: number | null } | undefined;
    const max = row?.max;
    return typeof max === "number" && Number.isSafeInteger(max) && max > 0 ? max : null;
}

/**
 * Source-stream applicability for a legacy-memory revision. A live write
 * learned its content now. A migration adoption timestamps the snapshot at
 * the latest plausible positive time the memory's content and path mappings
 * were known — first-seen for content, `mapped_at` for paths — and leaves
 * knowledge time unknown when neither is plausible: an as-of read must not
 * see a path selector before it was mapped.
 */
export function legacyMemorySourceApplicability(
    db: Database,
    row: LegacyMemoryApplicabilitySource,
    origin: "live" | "migration",
): RevisionApplicabilityInput {
    const retainedFirstSeen =
        Number.isSafeInteger(row.first_seen_at) && row.first_seen_at > 0 ? row.first_seen_at : null;
    const paths = readMemoryVerificationPathsState(db, row.id);
    const retainedMappedAt =
        paths.state === "unknown" ? null : latestMemoryVerificationMappedAt(db, row.id);
    const retainedKnownFrom =
        retainedFirstSeen != null && retainedMappedAt != null
            ? Math.max(retainedFirstSeen, retainedMappedAt)
            : (retainedMappedAt ?? retainedFirstSeen);
    return {
        ownerKind: "source",
        streamKey: legacyMemoryApplicabilityStreamKey(row.id),
        keyProtocol: APPLICABILITY_STREAM_KEY_PROTOCOL,
        sourceDigest: computeApplicabilitySourceDigest({
            kind: "legacy-memory",
            memoryId: row.id,
        }),
        assertion: {
            state: "unknown",
            paths,
            knownFrom: origin === "live" ? Date.now() : retainedKnownFrom,
        },
    };
}

function sameSortedValues(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function pathsStateEquals(
    head: ApplicabilityAssertionRecord,
    desired: ApplicabilityPathsInput,
): boolean {
    if (head.pathsState !== desired.state) return false;
    if (desired.state === "unknown") return true;
    const desiredExact = normalizePathValues("exact", desired.exact ?? []);
    const desiredGlob = normalizePathValues("glob", desired.glob ?? []);
    const headExact = head.paths.filter((path) => path.kind === "exact").map((path) => path.value);
    const headGlob = head.paths.filter((path) => path.kind === "glob").map((path) => path.value);
    return sameSortedValues(desiredExact, headExact) && sameSortedValues(desiredGlob, headGlob);
}

/**
 * Append a successor assertion carrying new path knowledge onto one of a
 * revision's source streams — only when that knowledge differs from the
 * stream head, so a replayed or no-op mapping write appends nothing. Every
 * non-path head field carries into the successor unchanged: readers treat
 * the head as the whole current snapshot, so a path-only update must not
 * erase anchors, dependency or verifier metadata, or symbol selectors.
 * Callers supply the desired path state and knowledge time explicitly; a
 * regressing knowledge time is clamped forward to the stream maximum.
 */
export function syncRevisionApplicabilityPathsInCurrentTransaction(
    db: Database,
    args: {
        revisionId: number;
        projectId: number;
        streamKey: string;
        keyProtocol: string;
        sourceDigest: string;
        paths: ApplicabilityPathsInput;
        knownFrom: number;
    },
): { appended: boolean } {
    const stream = ensureApplicabilityStreamInCurrentTransaction(db, {
        revisionId: args.revisionId,
        projectId: args.projectId,
        ownerKind: "source",
        streamKey: args.streamKey,
        keyProtocol: args.keyProtocol,
        sourceDigest: args.sourceDigest,
    });
    const heads = readCurrentApplicabilityAssertions(db, args.revisionId);
    const head = heads.find((candidate) => candidate.streamId === stream.streamId);
    if (head && pathsStateEquals(head, args.paths)) return { appended: false };
    const maxKnownFrom = maxStreamKnownFrom(db, stream.streamId);
    const knownFrom =
        maxKnownFrom != null ? Math.max(args.knownFrom, maxKnownFrom) : args.knownFrom;
    appendApplicabilityAssertionInCurrentTransaction(db, {
        streamId: stream.streamId,
        state: head?.state ?? "unknown",
        paths: args.paths,
        knownFrom,
        symbols: head?.symbols,
        validFromAnchorId: head?.validFromAnchorId ?? null,
        validUntilAnchorId: head?.validUntilAnchorId ?? null,
        evaluatedAgainstAnchorId: head?.evaluatedAgainstAnchorId ?? null,
        dependencyFingerprint: head?.dependencyFingerprint ?? null,
        dependencyProtocol: head?.dependencyProtocol ?? null,
        verifierSpec: head?.verifierSpec ?? null,
    });
    return { appended: true };
}

/**
 * Append a successor assertion carrying the memory's current side-table path
 * knowledge onto the revision's legacy-memory source stream. Legacy-keyed
 * wrapper over syncRevisionApplicabilityPathsInCurrentTransaction.
 */
export function syncMemoryApplicabilityPathsInCurrentTransaction(
    db: Database,
    args: {
        revisionId: number;
        projectId: number;
        memoryId: number;
        paths: ApplicabilityPathsInput;
        knownFrom: number;
    },
): { appended: boolean } {
    return syncRevisionApplicabilityPathsInCurrentTransaction(db, {
        revisionId: args.revisionId,
        projectId: args.projectId,
        streamKey: legacyMemoryApplicabilityStreamKey(args.memoryId),
        keyProtocol: APPLICABILITY_STREAM_KEY_PROTOCOL,
        sourceDigest: computeApplicabilitySourceDigest({
            kind: "legacy-memory",
            memoryId: args.memoryId,
        }),
        paths: args.paths,
        knownFrom: args.knownFrom,
    });
}
