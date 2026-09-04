import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import type { Memory, MemoryCategory, MemoryInput, MemoryScope, MemoryStatus, VerificationStatus } from "./types";
export declare const COLUMN_MAP: Record<keyof Memory, string>;
export declare function registerStatsDependentStatementCache<T extends {
    delete(db: Database): boolean;
}>(cache: T): T;
/**
 * Fetch (or prepare) a stats-dependent statement, probing the schema FIRST:
 * the probe's first positive observation drops the registered caches, so a
 * statement prepared against the pre-v80 shape is discarded before it can
 * execute once more against the migrated schema.
 */
export declare function getStatsDependentStatement(db: Database, cache: WeakMap<Database, PreparedStatement>, prepare: (db: Database) => PreparedStatement): PreparedStatement;
export interface MemoryCountsByStatus {
    total: number;
    active: number;
    permanent: number;
    archived: number;
    merged: number;
    ids: number[];
    archivedIds: number[];
    mergedIds: number[];
}
export interface InsertMemoryResult {
    memory: Memory;
    inserted: boolean;
}
export declare function hasMemoryShareableColumn(db: Database): boolean;
export declare function hasMemoryClassifiedAtColumn(db: Database): boolean;
/**
 * Whether this database has migrated to v80, where mutable memory telemetry
 * (seen/retrieval counters and their event timestamps) lives in the
 * `memory_stats` side table and the legacy `memories` telemetry columns are a
 * frozen migration baseline. Pre-v80 databases (including raw test fixtures
 * that never ran migrations) keep the legacy single-table contract.
 */
export declare function hasMemoryStatsTable(db: Database): boolean;
export declare class MemoryStatsIntegrityError extends Error {
    constructor(memoryId: number);
}
/**
 * SQL fragment projecting the effective seen_count: the memory_stats value on
 * a v80 database (NULL when the stats row is missing — corruption the caller
 * must reject via {@link requireEffectiveSeenCount}), the base column pre-v80.
 */
export declare function effectiveSeenCountSql(db: Database, tableName?: string): string;
/**
 * Coerce an effective seen_count read for a merge decision. On a stats-backed
 * database a NULL/undefined value means the one-row-per-memory invariant
 * broke; that must surface before a defaulted count feeds a destructive
 * merge-and-delete. Pre-v80 the legacy default of 1 applies.
 */
export declare function requireEffectiveSeenCount(db: Database, memoryId: number, value: unknown): number;
/**
 * Map raw projection rows to `Memory` values. On a v80 database a row whose
 * stats tuple came back NULL means the one-row-per-memory invariant broke;
 * that is corruption and must surface, never be silently filtered or healed
 * from the frozen legacy columns.
 */
export declare function memoryRowsFromQuery(db: Database, rows: readonly unknown[]): Memory[];
/** Memory ids (from the given set) that have never been classified — the
 *  classify-memories run-gate + Stage-3 "to-classify" partition. */
export declare function getUnclassifiedMemoryIds(db: Database, memoryIds: readonly number[]): number[];
export declare function getMemorySelectColumns(db: Database, tableName?: string): string;
/**
 * Join clause pairing the stats-backed projection from
 * {@link getMemorySelectColumns} with the `memory_stats` side table (aliased
 * `mstats`). Callers embed it directly after the memories table reference;
 * empty on pre-v80 databases. A missing stats row yields NULL telemetry
 * through the LEFT JOIN, which memoryRowsFromQuery rejects as corruption.
 */
export declare function getMemoryStatsJoin(db: Database, tableName?: string): string;
export declare function isMemoryRow(row: unknown): row is Memory;
export declare class ModuleMemoryAuthorityError extends Error {
    readonly projectPath: string;
    readonly code = "MEMORY_MODULE_AUTHORITY";
    constructor(projectPath: string);
}
export interface MemoryClaimOperationIdentity {
    producer: string;
    operationKey: string;
    requestDigest?: string;
}
export declare function insertMemory(db: Database, input: MemoryInput, operationIdentity?: MemoryClaimOperationIdentity): Memory;
/**
 * Shared-DB callers can race between their exact-hash pre-check and INSERT. When
 * the unique constraint wins, return the existing row with `inserted: false`
 * instead of surfacing a transient write failure. The recovery is non-mutating:
 * a raced row can be policy-hidden, and its seen count must stay untouched when
 * the caller answers with the uniform refusal — so the caller owns the
 * seen-count bump after its visibility decision, exactly as it does for a
 * duplicate found by its own pre-check lookup.
 */
export declare function insertMemoryIdempotent(db: Database, input: MemoryInput, operationIdentity?: MemoryClaimOperationIdentity): InsertMemoryResult;
export declare function getMemoryByHash(db: Database, projectPath: string, category: MemoryCategory, normalizedHash: string): Memory | null;
export declare function getMemoriesByProject(db: Database, projectPath: string, statuses?: MemoryStatus[], expiryCutoff?: number): Memory[];
export interface WorkspaceMemorySqlFilter {
    clause: string;
    params: string[];
    active: boolean;
    /** Canonical policy text retained for parity/golden checks across render paths. */
    predicate: string;
}
export declare function buildWorkspaceMemorySqlFilter(args: {
    identities: readonly string[];
    ownIdentities?: readonly string[];
    shareCategories?: readonly string[] | null;
    tableName?: string;
    includeClassificationFields?: boolean;
}): WorkspaceMemorySqlFilter;
/**
 * Resolve specific memory ids through the same visibility predicate the scoped
 * reads use, in the caller's request order, keeping duplicate requests.
 *
 * `json_each` drives an integer-primary-key lookup per requested id, so this
 * costs one indexed probe per id instead of loading every visible memory. A
 * hidden or expired row is indistinguishable from a missing one, exactly as when
 * the caller filtered a fully loaded set in memory.
 */
export declare function getMemoriesByRequestedIds(db: Database, args: {
    ids: readonly number[];
    identities: readonly string[];
    statuses?: readonly MemoryStatus[];
    expiryCutoff?: number;
    ownIdentities?: readonly string[];
    shareCategories?: readonly string[] | null;
}): Memory[];
export declare function getMemoriesByProjects(db: Database, projectPaths: readonly string[], statuses?: MemoryStatus[], expiryCutoff?: number, ownIdentities?: readonly string[], shareCategories?: readonly string[] | null): Memory[];
export declare function getMaxMemoryIdForProjects(db: Database, projectPaths: readonly string[], ownIdentities?: readonly string[], shareCategories?: readonly string[] | null, expiryCutoff?: number): number;
export declare function readNewMemoriesForM1Union(db: Database, projectPaths: readonly string[], afterId: number, expiryCutoff: number, ownIdentities?: readonly string[], shareCategories?: readonly string[] | null): Memory[];
export declare function getAllActiveMemoriesForMigration(db: Database, projectPath: string): Memory[];
export declare function getMemoryById(db: Database, id: number): Memory | null;
/** Load multiple memories by id in one positional-bind statement.
 *
 *  Returns whatever rows exist; missing ids are simply absent from the result.
 *  Visibility (own project vs foreign workspace + share category) is the
 *  caller's job — this helper does not enforce it. The tool layer applies the
 *  same union-read predicate used by every other read path (`memoryVisibleToTool`)
 *  and reports not-found / not-visible ids with one opaque per-id message, so
 *  foreign memory existence is never leaked. */
export declare function getMemoriesByIds(db: Database, ids: readonly number[]): Memory[];
export declare function updateMemorySeenCount(db: Database, id: number): void;
export declare function updateMemoryRetrievalCount(db: Database, id: number): void;
export declare function updateMemoryStatus(db: Database, id: number, status: MemoryStatus, operationIdentity?: MemoryClaimOperationIdentity): boolean;
export declare function updateMemoryVerification(db: Database, id: number, verificationStatus: VerificationStatus): void;
export declare function updateMemoryContent(db: Database, id: number, content: string, normalizedHash: string, operationIdentity?: MemoryClaimOperationIdentity): boolean;
export interface MemoryClassificationUpdate {
    importance?: number;
    scope?: MemoryScope;
    shareable?: boolean;
}
export declare function setMemoryClassification(db: Database, id: number, classification: MemoryClassificationUpdate): boolean;
export declare function supersededMemory(db: Database, id: number, supersededById: number, operationIdentity?: MemoryClaimOperationIdentity): boolean;
export declare function mergeMemoryStats(db: Database, id: number, seenCount: number, retrievalCount: number, mergedFrom: string, status: MemoryStatus, operationIdentity?: MemoryClaimOperationIdentity): boolean;
export declare function archiveMemory(db: Database, id: number, reason?: string, operationIdentity?: MemoryClaimOperationIdentity): boolean;
export declare function deleteMemory(db: Database, id: number): void;
export declare function getMemoryCount(db: Database, projectPath?: string): number;
export declare function getMemoryCountsByStatus(db: Database, projectPath: string): MemoryCountsByStatus;
//# sourceMappingURL=storage-memory.d.ts.map