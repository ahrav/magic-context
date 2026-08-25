import { createHash, randomUUID } from "node:crypto";
import type {
    ClaimEffectDeliveryRequest,
    ClaimEffectDeliveryResponse,
    ClaimIntentAckRequest,
    ClaimIntentAckResponse,
    ClaimIntentInspectRequest,
    ClaimIntentInspectResponse,
    ClaimIntentStageRequest,
    ClaimIntentStageResponse,
    ClaimIntentWireRecord,
} from "../../hooks/magic-context/module-wire";
import { log } from "../../shared/logger";
import type { Database, Statement } from "../../shared/sqlite";
import { withPrivilegedWriter } from "../../shared/sqlite";
import { encodeClaimOperationResult } from "./memory/claim-operation-contract";

export const AUTHORITY_DOMAINS = ["memories", "notes"] as const;
export type AuthorityDomain = (typeof AUTHORITY_DOMAINS)[number];
export type AuthorityState = "TS" | "PREPARING" | "MODULE" | "DRAINING";

export interface AuthorityStatus {
    context_store_uuid: string;
    project: string;
    domain: AuthorityDomain;
    state: AuthorityState;
    generation: number;
    captured_upper_bound?: number | null;
    drain_cursor?: number;
    step_seed?: boolean;
    step_memories?: boolean;
    step_notes?: boolean;
    step_compartments?: boolean;
    step_reconcile?: boolean;
    step_verify?: boolean;
    step_flip?: boolean;
    coordinator_lease?: string | null;
    lease_expires_at?: number | null;
    /** Attempt-unique drain coordinator token minted at begin/takeover. */
    coordinator_token?: string | null;
    checksum_expected?: string | null;
    checksum_actual?: string | null;
    checksum_ok?: number | boolean | null;
}

export interface AuthorityDrainContended {
    code: "authority_drain_contended";
    retryable: true;
    state: "DRAINING";
    attempts: number;
    authority: AuthorityStatus | null;
}

export type AuthorityDrainResult = AuthorityStatus | AuthorityDrainContended;

export interface AuthorityDrainResponse {
    authority?: AuthorityStatus;
    code?: string;
    retryable?: boolean;
}

export interface AuthorityModuleClient {
    authorityStatus(args: {
        context_store_uuid: string;
        project: string;
        projectRoot?: string;
        domain: AuthorityDomain;
    }): Promise<{ authority: AuthorityStatus | null }>;
    authorityPrepare(args: Record<string, unknown>): Promise<{ authority: AuthorityStatus }>;
    authorityDrain?(args: Record<string, unknown>): Promise<AuthorityDrainResponse>;
    authoritySeed?(
        args: Record<string, unknown>,
    ): Promise<{ seeded: number; module_row_ids?: number[] }>;
    mirrorPull?(args: {
        domain: AuthorityDomain;
        cursor: number;
        limit: number;
        live_only?: boolean;
        projectRoot?: string;
    }): Promise<{ page: ChangefeedPage }>;
    claimIntentStage?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentStageRequest;
    }): Promise<ClaimIntentStageResponse>;
    claimIntentInspect?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentInspectRequest;
    }): Promise<ClaimIntentInspectResponse>;
    claimIntentAck?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimIntentAckRequest;
    }): Promise<ClaimIntentAckResponse>;
    claimEffectsApply?(args: {
        sessionId: string;
        projectRoot: string;
        request: ClaimEffectDeliveryRequest;
    }): Promise<ClaimEffectDeliveryResponse>;
}

export interface ContextClaimCommit {
    response: string;
    producer: string;
    operationKey: string;
    requestDigest: string;
    resultJson: string;
}

function sameIntentBinding(
    left: ClaimIntentWireRecord["binding"],
    right: ClaimIntentWireRecord["binding"],
): boolean {
    return (
        left.databaseIncarnationId === right.databaseIncarnationId &&
        left.formatEpoch === right.formatEpoch &&
        left.authorityProject === right.authorityProject &&
        left.authorityGeneration === right.authorityGeneration
    );
}

function terminalClaimResult(reason: string): string {
    return encodeClaimOperationResult({
        resultEncodingVersion: 1,
        outcome: "stale",
        staleReason: reason,
        payload: null,
        effects: [],
        generations: {},
    });
}

export async function commitModuleClaimIntent(args: {
    client: Required<
        Pick<AuthorityModuleClient, "claimIntentStage" | "claimIntentInspect" | "claimIntentAck">
    >;
    sessionId: string;
    projectRoot: string;
    request: ClaimIntentStageRequest;
    commitContext: () => ContextClaimCommit;
    settleContext: (commit: ContextClaimCommit) => Promise<void>;
}): Promise<string> {
    const inspected = await args.client.claimIntentInspect({
        sessionId: args.sessionId,
        projectRoot: args.projectRoot,
        request: {
            protocolVersion: args.request.protocolVersion,
            command: args.request.command,
            unresolvedOnly: false,
            limit: 1,
        },
    });
    const prior = inspected.intents[0];
    if (prior && !sameIntentBinding(prior.binding, args.request.binding)) {
        if (prior.state === "staged") {
            await args.client.claimIntentAck({
                sessionId: args.sessionId,
                projectRoot: args.projectRoot,
                request: {
                    protocolVersion: args.request.protocolVersion,
                    binding: prior.binding,
                    command: prior.command,
                    requestDigest: prior.requestDigest,
                    kind: "terminal-rejected",
                    resultJson: terminalClaimResult(
                        "context database incarnation or authority changed",
                    ),
                },
            });
        }
        throw new Error("claim intent belongs to an obsolete context incarnation or authority");
    }

    const staged = await args.client.claimIntentStage({
        sessionId: args.sessionId,
        projectRoot: args.projectRoot,
        request: args.request,
    });
    if (staged.intent.state === "terminal-rejected") {
        throw new Error("claim intent was terminally rejected");
    }

    const commit = args.commitContext();
    if (
        commit.producer !== args.request.command.producer ||
        commit.operationKey !== args.request.command.operationKey
    ) {
        throw new Error("context receipt identity does not match staged claim intent");
    }
    if (commit.requestDigest !== staged.intent.requestDigest) {
        throw new Error("context receipt digest does not match staged claim intent");
    }

    let intent = staged.intent;
    if (intent.state === "staged") {
        const acknowledged = await args.client.claimIntentAck({
            sessionId: args.sessionId,
            projectRoot: args.projectRoot,
            request: {
                protocolVersion: args.request.protocolVersion,
                binding: intent.binding,
                command: intent.command,
                requestDigest: intent.requestDigest,
                kind: "context-committed",
                resultJson: commit.resultJson,
            },
        });
        intent = acknowledged.intent;
    } else if (intent.resultJson !== commit.resultJson) {
        throw new Error("module claim intent result differs from durable context receipt");
    }
    if (intent.state !== "context-committed" && intent.state !== "acknowledged") {
        throw new Error(`claim intent did not record context commit: ${intent.state}`);
    }

    await args.settleContext(commit);
    if (intent.state !== "acknowledged") {
        const acknowledged = await args.client.claimIntentAck({
            sessionId: args.sessionId,
            projectRoot: args.projectRoot,
            request: {
                protocolVersion: args.request.protocolVersion,
                binding: intent.binding,
                command: intent.command,
                requestDigest: intent.requestDigest,
                kind: "acknowledged",
                resultJson: null,
            },
        });
        if (acknowledged.intent.state !== "acknowledged") {
            throw new Error("claim intent settlement was not durable");
        }
    }
    return commit.response;
}

import type { DrainResult } from "./smart-notes/evaluator-worker";

export interface ModuleNoteEvaluationBridge {
    sync(): Promise<void>;
    drain(args: {
        deadline: number;
        signal?: AbortSignal;
        /** Ask the authority for sandbox-only phases (due, liveness). */
        excludeBillable?: boolean;
        /** Client-side bound on billable claims; absent = legacy per-run cap. */
        maxCompilePerRun?: number;
        maxFallbackPerRun?: number;
    }): Promise<DrainResult>;
    available(): boolean;
    /** Retry a failed or premature evaluator registration; no-op when live. */
    ensureRegistered?(): Promise<void>;
    dispose(): Promise<void>;
}

/** One registered bridge plus the number of plugin instances relying on it. */
interface ModuleNoteEvaluationBridgeEntry {
    bridge: ModuleNoteEvaluationBridge;
    owners: number;
}

const moduleNoteEvaluationBridges = new Map<string, ModuleNoteEvaluationBridgeEntry>();

/**
 * Composite registry key. Worktrees of one repository share a project
 * identity but bind different checkout roots, and each root's bridge closes
 * over its own transport route and filesystem capabilities, so identity alone
 * cannot address a bridge. NUL cannot appear in a filesystem path.
 */
export function moduleNoteEvaluationBridgeKey(projectPath: string, projectRoot: string): string {
    return `${projectPath}\u0000${projectRoot}`;
}

/** Registers the bridge (one owner) and returns its registry key for later disposal. */
export function registerModuleNoteEvaluationBridge(
    projectPath: string,
    projectRoot: string,
    bridge: ModuleNoteEvaluationBridge,
): string {
    const key = moduleNoteEvaluationBridgeKey(projectPath, projectRoot);
    moduleNoteEvaluationBridges.set(key, { bridge, owners: 1 });
    return key;
}

/**
 * Record another owner of an already-registered exact bridge and return its
 * registry key, or undefined when no such bridge exists. A second plugin
 * instance serving the same (identity, root) must retain rather than skip:
 * otherwise the first instance's disposal tears down the only registry entry
 * while the second instance still routes conditioned writes through it.
 */
export function retainModuleNoteEvaluationBridge(
    projectPath: string,
    projectRoot: string,
): string | undefined {
    const key = moduleNoteEvaluationBridgeKey(projectPath, projectRoot);
    const entry = moduleNoteEvaluationBridges.get(key);
    if (!entry) return undefined;
    entry.owners += 1;
    return key;
}

/**
 * With `projectRoot`: the bridge bound to that exact checkout. Without it: any
 * bridge for the identity, for identity-scoped questions such as "does a live
 * evaluator exist" or "does the module own drains for this project".
 */
export function getModuleNoteEvaluationBridge(
    projectPath: string,
    projectRoot?: string,
): ModuleNoteEvaluationBridge | undefined {
    if (projectRoot !== undefined) {
        return moduleNoteEvaluationBridges.get(
            moduleNoteEvaluationBridgeKey(projectPath, projectRoot),
        )?.bridge;
    }
    const prefix = `${projectPath}\u0000`;
    for (const [key, entry] of moduleNoteEvaluationBridges) {
        if (key.startsWith(prefix)) return entry.bridge;
    }
    return undefined;
}

/**
 * Bridge lookup for drain paths: exact (identity, root) first — worktrees of
 * one repository share an identity, and each bridge's filesystem capabilities
 * bind to one checkout — then any bridge for the identity, because an
 * undrained module queue is the worse failure: pending notes would sit
 * forever in a process whose exact-root bridge never registered. Claims carry
 * no originating root, so the cross-root exposure already exists in claim
 * selection itself; root-fenced selection is tracked as magic-context-c0c and
 * must land here, once, for every drain caller.
 */
export function findModuleNoteEvaluationBridgeForDrain(
    projectPath: string,
    projectRoot: string | undefined,
): ModuleNoteEvaluationBridge | undefined {
    return (
        (projectRoot !== undefined
            ? getModuleNoteEvaluationBridge(projectPath, projectRoot)
            : undefined) ?? getModuleNoteEvaluationBridge(projectPath)
    );
}

/**
 * Release the named owners' claims (registry keys returned by register or
 * retain). The registry is process-global while plugin instances are disposed
 * individually, so an instance passes the keys it owns; a bridge is removed
 * and disposed only when its last owner releases it, and sibling instances'
 * bridges stay live.
 */
export async function disposeModuleNoteEvaluationBridges(
    bridgeKeys: Iterable<string>,
): Promise<void> {
    const bridges: ModuleNoteEvaluationBridge[] = [];
    for (const key of bridgeKeys) {
        const entry = moduleNoteEvaluationBridges.get(key);
        if (!entry) continue;
        entry.owners -= 1;
        if (entry.owners > 0) continue;
        moduleNoteEvaluationBridges.delete(key);
        bridges.push(entry.bridge);
    }
    await Promise.allSettled(bridges.map((bridge) => bridge.dispose()));
}

export interface ChangefeedRow {
    feed_seq: number;
    domain: AuthorityDomain;
    op: "insert" | "update" | "tombstone";
    module_row_id: number;
    full_row_snapshot: Record<string, unknown>;
    content_hash: string | null;
}

export interface ChangefeedPage {
    domain: AuthorityDomain;
    cursor: number;
    next_cursor: number;
    has_more: boolean;
    rows: ChangefeedRow[];
}

interface StoreMetaRow {
    value: string;
}

export function getContextStoreUuid(db: Database): string | null {
    const row = db.prepare("SELECT value FROM context_store_meta WHERE key = 'store_uuid'").get() as
        | StoreMetaRow
        | undefined;
    return typeof row?.value === "string" && row.value.length > 0 ? row.value : null;
}

/** Mint the store identity once. Restoring a database restores this value too,
 * which is what lets the module recognize a regressed marker. */
export function ensureContextStoreUuid(db: Database): string {
    const existing = getContextStoreUuid(db);
    if (existing) return existing;
    const minted = randomUUID();
    withPrivilegedWriter(db, () => {
        db.transaction(() => {
            db.prepare(
                "INSERT INTO context_store_meta(key, value) VALUES ('store_uuid', ?) ON CONFLICT(key) DO NOTHING",
            ).run(minted);
        }).immediate();
    });
    return getContextStoreUuid(db) ?? minted;
}

/** Tails keyed by store uuid + domain; process-global so every plugin instance
 * sharing one database file joins the same chain. */
const mirrorDomainSyncChains = new Map<string, Promise<void>>();

/**
 * Serialize mirror pulls for one (database, domain) across every caller in
 * the process. Each pull reads the durable cursor before requesting a page,
 * so two concurrent pulls request the same page and the loser throws a
 * cursor mismatch in {@link applyMirrorPage}. Instance-local chains are not
 * enough: several plugin instances can share one database file (the shared
 * evaluator bridge holds one instance's sync while another instance's tool
 * backend syncs the same domain), so the chain is keyed by the store uuid.
 */
export function chainMirrorDomainSync(
    db: Database,
    domain: "memories" | "notes",
    run: () => Promise<void>,
): Promise<void> {
    const key = `${ensureContextStoreUuid(db)}\u0000${domain}`;
    const tail = mirrorDomainSyncChains.get(key) ?? Promise.resolve();
    const next = tail.then(run, run);
    mirrorDomainSyncChains.set(
        key,
        next.then(
            () => undefined,
            () => undefined,
        ),
    );
    return next;
}

export interface AuthorityManagedMarker {
    project_path: string;
    context_store_uuid: string;
    marked_at: number;
}

export function getAuthorityManagedMarker(
    db: Database,
    projectPath: string,
): AuthorityManagedMarker | null {
    return (
        (db
            .prepare(
                "SELECT project_path, context_store_uuid, marked_at FROM authority_managed WHERE project_path = ?",
            )
            .get(projectPath) as AuthorityManagedMarker | undefined) ?? null
    );
}

export function listAuthorityManagedMarkers(db: Database): AuthorityManagedMarker[] {
    return db
        .prepare(
            "SELECT project_path, context_store_uuid, marked_at FROM authority_managed ORDER BY project_path",
        )
        .all() as AuthorityManagedMarker[];
}

export function installAuthorityManagedMarker(
    db: Database,
    projectPath: string,
    contextStoreUuid = ensureContextStoreUuid(db),
): void {
    withPrivilegedWriter(db, () => {
        db.prepare(
            "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, ?, ?) ON CONFLICT(project_path) DO UPDATE SET context_store_uuid = excluded.context_store_uuid, marked_at = excluded.marked_at",
        ).run(projectPath, contextStoreUuid, Date.now());
    });
}

export function removeAuthorityManagedMarker(db: Database, projectPath: string): void {
    withPrivilegedWriter(db, () => {
        db.prepare("DELETE FROM authority_managed WHERE project_path = ?").run(projectPath);
    });
}

function setRepairPending(db: Database, projectPath: string): void {
    withPrivilegedWriter(db, () => {
        db.prepare(
            "INSERT INTO authority_repair_pending(project_path, started_at) VALUES (?, ?) ON CONFLICT(project_path) DO UPDATE SET started_at = excluded.started_at",
        ).run(projectPath, Date.now());
    });
}

function clearRepairPending(db: Database, projectPath: string): void {
    withPrivilegedWriter(db, () => {
        db.prepare("DELETE FROM authority_repair_pending WHERE project_path = ?").run(projectPath);
    });
}

/**
 * Repair a marker lost by restoring an older context.db snapshot. The write barrier
 * makes the repair atomic with the marker installation; callers keep application
 * writes closed until this function resolves.
 */
export async function reconcileAuthorityMarker(args: {
    db: Database;
    projectPath: string;
    module: AuthorityModuleClient;
}): Promise<{ status: "legacy" | "ok" | "repaired"; authority: AuthorityStatus | null }> {
    const contextStoreUuid = ensureContextStoreUuid(args.db);
    const marker = getAuthorityManagedMarker(args.db, args.projectPath);
    if (marker) {
        const statuses = await Promise.all(
            AUTHORITY_DOMAINS.map((domain) =>
                args.module.authorityStatus({
                    context_store_uuid: contextStoreUuid,
                    project: args.projectPath,
                    domain,
                }),
            ),
        );
        return {
            status: "ok",
            authority: statuses.find((result) => result.authority !== null)?.authority ?? null,
        };
    }

    // A missing marker is ambiguous until the module answers. Keep all writes closed
    // during that round-trip so a restored store cannot accept a write before repair.
    setRepairPending(args.db, args.projectPath);
    // Keep the durable pending marker if the module request fails: this host is expected
    // to reach the module, so an unknown result remains fail-closed until a later retry.
    const statuses: Array<{ authority: AuthorityStatus | null }> = await Promise.all(
        AUTHORITY_DOMAINS.map((domain) =>
            args.module.authorityStatus({
                context_store_uuid: contextStoreUuid,
                project: args.projectPath,
                domain,
            }),
        ),
    );
    const authority =
        statuses.find((result) => result.authority !== null && result.authority.state !== "TS")
            ?.authority ?? null;
    if (!authority) {
        clearRepairPending(args.db, args.projectPath);
        return { status: "legacy", authority: null };
    }

    // The module still owns this UUID, so a marker-less restore is regressed rather
    // than a new store. Hold the SQLite writer lock while reinstalling the fence.
    withPrivilegedWriter(args.db, () => {
        installAuthorityManagedMarker(args.db, args.projectPath, contextStoreUuid);
        args.db
            .prepare("DELETE FROM authority_repair_pending WHERE project_path = ?")
            .run(args.projectPath);
    });
    return { status: "repaired", authority };
}

export async function reconcileAuthorityProject(args: {
    db: Database;
    projectPath: string;
    module: AuthorityModuleClient;
}): Promise<void> {
    await reconcileAuthorityMarker(args);
    const contextStoreUuid = ensureContextStoreUuid(args.db);
    for (const domain of ["notes"] as const) {
        const status = await args.module.authorityStatus({
            context_store_uuid: contextStoreUuid,
            project: args.projectPath,
            domain,
        });
        if (status.authority?.state !== "MODULE") continue;
        const identity = args.db
            .prepare(
                "SELECT 1 FROM mirror_identity WHERE domain = ? AND module_project = ? LIMIT 1",
            )
            .get(domain, args.projectPath);
        if (identity) continue;
        if (!args.module.mirrorPull) {
            throw new Error(`authority reconciliation requires mirror.pull for ${domain}`);
        }
        withPrivilegedWriter(args.db, () => {
            args.db
                .transaction(() => {
                    args.db
                        .prepare(
                            "DELETE FROM mirror_identity WHERE domain = ? AND module_project = ?",
                        )
                        .run(domain, args.projectPath);
                    args.db
                        .prepare(
                            "DELETE FROM mirror_pending_references WHERE domain = ? AND module_project = ?",
                        )
                        .run(domain, args.projectPath);
                    args.db
                        .prepare("DELETE FROM mirror_note_revisions WHERE module_project = ?")
                        .run(args.projectPath);
                    args.db
                        .prepare(
                            "INSERT INTO mirror_cursors(domain, cursor, updated_at) VALUES (?, 0, ?) ON CONFLICT(domain) DO UPDATE SET cursor = 0, updated_at = excluded.updated_at",
                        )
                        .run(domain, Date.now());
                })
                .immediate();
        });
        for (;;) {
            const cursor = getMirrorCursor(args.db, domain);
            const response = await args.module.mirrorPull({ domain, cursor, limit: 1000 });
            const next = applyMirrorPage({ db: args.db, page: response.page });
            if (!response.page.has_more || next === cursor) break;
        }
    }
}

export interface PrepareAuthorityArgs {
    db: Database;
    projectPath: string;
    domains?: readonly AuthorityDomain[];
    module: AuthorityModuleClient;
    seedPages: (domain: AuthorityDomain) => Promise<readonly Record<string, unknown>[]>;
    /** Test seam for alternate canonical encoders. Production uses the shared row digest. */
    checksum?: (domain: AuthorityDomain, rows: readonly Record<string, unknown>[]) => string;
}

function canonicalizeSeedValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalizeSeedValue);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
        Object.keys(record)
            .sort()
            .map((key) => [key, canonicalizeSeedValue(record[key])]),
    );
}

export function checksumAuthoritySeedRows(rows: readonly Record<string, unknown>[]): string {
    const ordered = [...rows].sort((left, right) => {
        const leftId = seedSourceRowId(left) ?? Number.MAX_SAFE_INTEGER;
        const rightId = seedSourceRowId(right) ?? Number.MAX_SAFE_INTEGER;
        return leftId - rightId;
    });
    return createHash("sha256")
        .update(JSON.stringify(ordered.map(canonicalizeSeedValue)))
        .digest("hex");
}

function maxDomainRowId(db: Database, domain: AuthorityDomain, projectPath: string): number {
    if (domain === "memories") return 0;
    const row = db
        .prepare(
            `SELECT COALESCE(MAX(n.rowid), 0) AS max_rowid
               FROM notes n
              WHERE n.project_path = ?
                 OR (n.project_path IS NULL AND EXISTS (
                     SELECT 1 FROM session_projects sp
                      WHERE sp.session_id = n.session_id AND sp.project_path = ?
                 ))`,
        )
        .get(projectPath, projectPath) as { max_rowid?: number } | undefined;
    return typeof row?.max_rowid === "number" ? row.max_rowid : 0;
}

/** Read the transactionally maintained domain mutation epoch (0 when never bumped). */
export function readDomainMutationEpoch(
    db: Database,
    projectPath: string,
    domain: AuthorityDomain,
): number {
    const row = db
        .prepare("SELECT epoch FROM domain_mutation_epoch WHERE project_path = ? AND domain = ?")
        .get(projectPath, domain) as { epoch?: number } | undefined;
    return typeof row?.epoch === "number" ? row.epoch : 0;
}

/**
 * Bump the domain mutation epoch inside the current privileged write transaction.
 * Same-connection privileged UPDATEs do not advance PRAGMA data_version; this epoch
 * is the capture bound that detects those writes.
 */
export function bumpDomainMutationEpoch(
    db: Database,
    projectPath: string,
    domain: AuthorityDomain,
): void {
    db.prepare(
        `INSERT INTO domain_mutation_epoch(project_path, domain, epoch) VALUES (?, ?, 1)
         ON CONFLICT(project_path, domain) DO UPDATE SET epoch = epoch + 1`,
    ).run(projectPath, domain);
}

function installMarkerAndCaptureBounds(args: {
    db: Database;
    projectPath: string;
    contextStoreUuid: string;
    domains: readonly AuthorityDomain[];
}): void {
    args.db.exec("BEGIN IMMEDIATE");
    try {
        withPrivilegedWriter(args.db, () => {
            args.db
                .prepare(
                    "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, ?, ?) ON CONFLICT(project_path) DO UPDATE SET context_store_uuid = excluded.context_store_uuid, marked_at = excluded.marked_at",
                )
                .run(args.projectPath, args.contextStoreUuid, Date.now());
            const capture = args.db.prepare(
                "INSERT INTO authority_capture_bounds(project_path, domain, max_rowid, data_version, mutation_epoch, captured_at) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(project_path, domain) DO UPDATE SET max_rowid = excluded.max_rowid, data_version = excluded.data_version, mutation_epoch = excluded.mutation_epoch, captured_at = excluded.captured_at",
            );
            for (const domain of args.domains) {
                capture.run(
                    args.projectPath,
                    domain,
                    maxDomainRowId(args.db, domain, args.projectPath),
                    readDomainMutationEpoch(args.db, args.projectPath, domain),
                    Date.now(),
                );
            }
        });
        args.db.exec("COMMIT");
    } catch (error) {
        try {
            args.db.exec("ROLLBACK");
        } catch {
            // Preserve the capture failure.
        }
        throw error;
    }
}

function capturedBoundsUnchanged(
    db: Database,
    projectPath: string,
    domains: readonly AuthorityDomain[],
): boolean {
    db.exec("BEGIN IMMEDIATE");
    try {
        const read = db.prepare(
            "SELECT max_rowid, mutation_epoch FROM authority_capture_bounds WHERE project_path = ? AND domain = ?",
        );
        const unchanged = domains.every((domain) => {
            const captured = read.get(projectPath, domain) as
                | { max_rowid: number; mutation_epoch: number }
                | undefined;
            return (
                captured !== undefined &&
                captured.max_rowid === maxDomainRowId(db, domain, projectPath) &&
                captured.mutation_epoch === readDomainMutationEpoch(db, projectPath, domain)
            );
        });
        db.exec("COMMIT");
        return unchanged;
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // Preserve the verification failure.
        }
        throw error;
    }
}

export async function prepareAuthority(args: PrepareAuthorityArgs): Promise<AuthorityStatus[]> {
    const contextStoreUuid = ensureContextStoreUuid(args.db);
    const domains = args.domains ?? AUTHORITY_DOMAINS;
    if (!args.module.authoritySeed) {
        throw new Error("authority preparation requires the authority.seed module route");
    }

    installMarkerAndCaptureBounds({
        db: args.db,
        projectPath: args.projectPath,
        contextStoreUuid,
        domains,
    });

    const startedGenerations = new Map<AuthorityDomain, number>();
    const prepared: Array<{
        domain: AuthorityDomain;
        generation: number;
    }> = [];
    try {
        for (const domain of domains) {
            const started = await args.module.authorityPrepare({
                method: "authority.prepare",
                phase: "begin",
                context_store_uuid: contextStoreUuid,
                project: args.projectPath,
                domain,
            });
            startedGenerations.set(domain, started.authority.generation);
            const rows = await args.seedPages(domain);
            for (const page of chunkRowsForFrame(rows)) {
                const seedResponse = await args.module.authoritySeed({
                    method: "authority.seed",
                    context_store_uuid: contextStoreUuid,
                    project: args.projectPath,
                    domain,
                    rows: page,
                });
                const identityByModuleRowId = new Map<
                    number,
                    { moduleRowId: number; sourceRowId: number }
                >();
                for (const [index, moduleRowId] of (seedResponse.module_row_ids ?? []).entries()) {
                    const sourceRowId = seedSourceRowId(page[index]);
                    if (sourceRowId === null) continue;
                    // The module coalesces same-frame natural-key duplicates to the
                    // last snapshot. Repeated module ids therefore choose the last
                    // source id as the canonical mirror-back target as well.
                    identityByModuleRowId.set(moduleRowId, { moduleRowId, sourceRowId });
                }
                const identities = [...identityByModuleRowId.values()];
                if (identities.length > 0) {
                    // Seed identities are one response batch: keeping the SELECT+insert
                    // sequence in one local transaction prevents one SQLite write lock per row.
                    args.db
                        .transaction(() => {
                            for (const identity of identities) {
                                rememberIdentity(
                                    args.db,
                                    domain,
                                    args.projectPath,
                                    identity.moduleRowId,
                                    identity.sourceRowId,
                                );
                            }
                        })
                        .immediate();
                }
            }
            const digest = args.checksum?.(domain, rows) ?? checksumAuthoritySeedRows(rows);
            const completed = await args.module.authorityPrepare({
                method: "authority.prepare",
                phase: "complete",
                context_store_uuid: contextStoreUuid,
                project: args.projectPath,
                domain,
                generation: started.authority.generation,
                checksum_expected: digest,
            });
            const authority = completed.authority;
            const checksumOk = authority.checksum_ok === true || authority.checksum_ok === 1;
            if (
                authority.state !== "PREPARING" ||
                !checksumOk ||
                authority.checksum_expected !== digest ||
                authority.checksum_actual !== digest
            ) {
                log(
                    `[magic-context] authority seed checksum mismatch for ${domain}; aborting module ownership`,
                );
                throw new Error(`authority seed verification failed for ${domain}`);
            }
            prepared.push({ domain, generation: started.authority.generation });
        }

        if (!capturedBoundsUnchanged(args.db, args.projectPath, domains)) {
            log(
                "[magic-context] authority capture bound drifted while writers were fenced; aborting module ownership",
            );
            throw new Error("authority capture bound changed while TypeScript writers were fenced");
        }

        const results: AuthorityStatus[] = [];
        for (const item of prepared) {
            const acknowledged = await args.module.authorityPrepare({
                method: "authority.prepare",
                phase: "ack",
                context_store_uuid: contextStoreUuid,
                project: args.projectPath,
                domain: item.domain,
                generation: item.generation,
            });
            if (acknowledged.authority.state !== "MODULE") {
                throw new Error(`authority acknowledgement failed for ${item.domain}`);
            }
            results.push(acknowledged.authority);
        }
        return results;
    } catch (error) {
        let moduleOwnsDomain = false;
        for (const [domain, generation] of startedGenerations) {
            try {
                const aborted = await args.module.authorityPrepare({
                    method: "authority.prepare",
                    phase: "abort",
                    context_store_uuid: contextStoreUuid,
                    project: args.projectPath,
                    domain,
                    generation,
                });
                moduleOwnsDomain ||= aborted.authority.state === "MODULE";
            } catch {
                moduleOwnsDomain = true;
            }
        }
        if (!moduleOwnsDomain) removeAuthorityManagedMarker(args.db, args.projectPath);
        throw error;
    }
}

function authorityDrainErrorCode(error: unknown): string | null {
    let current = error;
    for (let depth = 0; depth < 3; depth += 1) {
        if (!current || typeof current !== "object") break;
        const record = current as { code?: unknown; cause?: unknown };
        if (typeof record.code === "string") return record.code;
        current = record.cause;
    }
    return error instanceof Error && error.message.includes("authority_feed_head_advanced")
        ? "authority_feed_head_advanced"
        : null;
}

const MAX_DRAIN_RECAPTURE_ATTEMPTS = 5;

export async function drainAuthority(args: {
    db: Database;
    projectPath: string;
    domain: AuthorityDomain;
    module: AuthorityModuleClient;
    checksum: string | (() => string);
    limit?: number;
}): Promise<AuthorityDrainResult> {
    if (!args.module.authorityDrain) {
        throw new Error("authority drain is unavailable on this module client");
    }
    if (!args.module.mirrorPull) {
        throw new Error("memory authority drain requires the mirror.pull module route");
    }
    const contextStoreUuid = ensureContextStoreUuid(args.db);
    const limit = Math.max(1, Math.min(args.limit ?? 100, 1000));
    let recaptureAttempts = 0;

    drainAttempt: while (true) {
        const leaseStartedAt = Date.now();
        const beginResponse = await args.module.authorityDrain({
            method: "authority.drain.begin",
            context_store_uuid: contextStoreUuid,
            project: args.projectPath,
            domain: args.domain,
            action: "begin",
            lease: `ts:${contextStoreUuid}`,
            lease_started_at: leaseStartedAt,
            lease_expires_at: leaseStartedAt + 60_000,
        });
        if (!beginResponse.authority) {
            if (authorityDrainErrorCode(beginResponse) === "authority_feed_head_advanced") {
                if (recaptureAttempts >= MAX_DRAIN_RECAPTURE_ATTEMPTS) {
                    return {
                        code: "authority_drain_contended",
                        retryable: true,
                        state: "DRAINING",
                        attempts: recaptureAttempts,
                        authority: beginResponse.authority ?? null,
                    };
                }
                recaptureAttempts += 1;
                continue;
            }
            throw new Error("authority drain begin omitted authority");
        }
        let status = beginResponse.authority;
        const coordinatorToken = status.coordinator_token;
        if (typeof coordinatorToken !== "string" || coordinatorToken.length === 0) {
            throw new Error("authority drain begin omitted coordinator_token");
        }

        const upperBound = status.captured_upper_bound ?? status.drain_cursor ?? 0;
        if (args.domain === "memories" && upperBound > getMirrorCursor(args.db, args.domain)) {
            throw new Error(
                "memories authority drain found legacy module feed rows; reset the module store instead of draining",
            );
        }
        while (getMirrorCursor(args.db, args.domain) < upperBound) {
            const cursor = getMirrorCursor(args.db, args.domain);
            const page = await args.module.mirrorPull({
                domain: args.domain,
                cursor,
                limit,
            });
            applyMirrorPage({ db: args.db, page: page.page });
            const next = getMirrorCursor(args.db, args.domain);
            if (next === cursor) break;
        }
        for (const step of [
            "seed",
            "memories",
            "notes",
            "compartments",
            "reconcile",
            "verify",
        ] as const) {
            const stepResponse = await args.module.authorityDrain({
                method: `authority.drain_${step}`,
                context_store_uuid: contextStoreUuid,
                project: args.projectPath,
                domain: args.domain,
                action: step,
                generation: status.generation,
                cursor: getMirrorCursor(args.db, args.domain),
                coordinator_token: coordinatorToken,
                now_ms: Date.now(),
            });
            if (!stepResponse.authority) {
                if (authorityDrainErrorCode(stepResponse) === "authority_feed_head_advanced") {
                    if (recaptureAttempts >= MAX_DRAIN_RECAPTURE_ATTEMPTS) {
                        return {
                            code: "authority_drain_contended",
                            retryable: true,
                            state: "DRAINING",
                            attempts: recaptureAttempts,
                            authority: status,
                        };
                    }
                    recaptureAttempts += 1;
                    continue drainAttempt;
                }
                throw new Error(`authority drain ${step} omitted authority`);
            }
            status = stepResponse.authority;
        }
        const drainChecksum = typeof args.checksum === "function" ? args.checksum() : args.checksum;
        let finished: AuthorityStatus;
        try {
            const finishResponse = await args.module.authorityDrain({
                method: "authority.drain.finish",
                context_store_uuid: contextStoreUuid,
                project: args.projectPath,
                domain: args.domain,
                action: "finish",
                generation: status.generation,
                checksum_expected: drainChecksum,
                checksum_actual: drainChecksum,
                verified: true,
                coordinator_token: coordinatorToken,
                now_ms: Date.now(),
            });
            if (!finishResponse.authority) {
                if (authorityDrainErrorCode(finishResponse) === "authority_feed_head_advanced") {
                    throw Object.assign(new Error("authority_feed_head_advanced"), {
                        code: "authority_feed_head_advanced",
                    });
                }
                throw new Error("authority drain finish omitted authority");
            }
            finished = finishResponse.authority;
        } catch (error) {
            if (authorityDrainErrorCode(error) === "authority_feed_head_advanced") {
                if (recaptureAttempts >= MAX_DRAIN_RECAPTURE_ATTEMPTS) {
                    // Historian publication and state sync legitimately remain writable while
                    // DRAINING. They are bursty, so a later scheduled drain normally converges;
                    // bounding this coordinator prevents a steady producer from livelocking it.
                    return {
                        code: "authority_drain_contended",
                        retryable: true,
                        state: "DRAINING",
                        attempts: recaptureAttempts,
                        authority: status,
                    };
                }
                recaptureAttempts += 1;
                // A non-facade writer may append after the prior bound. Beginning the next
                // attempt captures a fresh head; replay remains bounded to that captured head.
                continue;
            }
            throw error;
        }
        if (finished.state !== "TS") {
            throw new Error("memory authority drain did not reactivate TypeScript ownership");
        }
        // A project marker fences both authority domains. Remove it only after neither
        // domain remains module-owned; a one-domain drain must not reopen the other domain.
        const remaining = await Promise.all(
            AUTHORITY_DOMAINS.map((domain) =>
                args.module.authorityStatus({
                    context_store_uuid: contextStoreUuid,
                    project: args.projectPath,
                    domain,
                }),
            ),
        );
        if (remaining.every((result) => !result.authority || result.authority.state === "TS")) {
            removeAuthorityManagedMarker(args.db, args.projectPath);
        }
        return finished;
    }
}

function seedSourceRowId(row: Record<string, unknown>): number | null {
    const direct = row.source_row_id;
    if (typeof direct === "number" && Number.isInteger(direct)) return direct;
    const snapshot = row.snapshot;
    if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
        const sourceId = (snapshot as Record<string, unknown>).id;
        return typeof sourceId === "number" && Number.isInteger(sourceId) ? sourceId : null;
    }
    const id = row.id;
    return typeof id === "number" && Number.isInteger(id) ? id : null;
}

const MAX_AUTHORITY_SEED_FRAME_BYTES = 900 * 1024;

function chunkRowsForFrame<T>(rows: readonly T[]): T[][] {
    const chunks: T[][] = [];
    let current: T[] = [];
    let currentBytes = 2;
    for (const row of rows) {
        const rowBytes = new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
        if (current.length > 0 && currentBytes + rowBytes > MAX_AUTHORITY_SEED_FRAME_BYTES) {
            chunks.push(current);
            current = [];
            currentBytes = 2;
        }
        current.push(row);
        currentBytes += rowBytes;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

export function getMirrorCursor(db: Database, domain: AuthorityDomain): number {
    const row = db.prepare("SELECT cursor FROM mirror_cursors WHERE domain = ?").get(domain) as
        | { cursor?: number }
        | undefined;
    return typeof row?.cursor === "number" ? row.cursor : 0;
}

function rowNumber(row: Record<string, unknown>, key: string, fallback = 0): number {
    const value = row[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function rowString(row: Record<string, unknown>, key: string, fallback = ""): string {
    const value = row[key];
    return typeof value === "string" ? value : fallback;
}

function rowNullableString(row: Record<string, unknown>, key: string): string | null {
    const value = row[key];
    return typeof value === "string" ? value : null;
}

function hasSnapshotField(row: Record<string, unknown>, key: string): boolean {
    // Own-property checks distinguish a missing snapshot field from an explicit null clear.
    // biome-ignore lint/suspicious/noPrototypeBuiltins: snapshot objects may have an untrusted prototype
    return Object.prototype.hasOwnProperty.call(row, key);
}

interface MirrorPageStatements {
    identityByModule: Statement;
    insertIdentity: Statement;
    deleteIdentityByContext: Statement;
    deleteIdentity: Statement;
    noteById: Statement;
    noteIdByStoreId: Statement;
    insertNote: Statement;
    deleteNote: Statement;
    deleteNoteRevisions: Statement;
    updateNote: Statement;
    upsertNoteRevision: Statement;
    updateCursor: Statement;
    contextStoreUuid: string | null;
}

function prepareMirrorPageStatements(db: Database): MirrorPageStatements {
    return {
        identityByModule: db.prepare(
            "SELECT context_row_id FROM mirror_identity WHERE domain = ? AND module_project = ? AND module_row_id = ?",
        ),
        insertIdentity: db.prepare(
            "INSERT OR IGNORE INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES (?, ?, ?, ?)",
        ),
        deleteIdentityByContext: db.prepare(
            "DELETE FROM mirror_identity WHERE domain = ? AND context_row_id = ?",
        ),
        deleteIdentity: db.prepare(
            "DELETE FROM mirror_identity WHERE domain = ? AND module_project = ? AND module_row_id = ?",
        ),
        noteById: db.prepare("SELECT * FROM notes WHERE id = ?"),
        noteIdByStoreId: db.prepare(
            "SELECT id FROM notes WHERE id = ? AND type = 'smart' AND project_path = ?",
        ),
        insertNote: db.prepare(
            "INSERT INTO notes (type, status, content, project_path, session_id, created_at, updated_at) VALUES ('smart', 'active', '', ?, ?, 0, 0)",
        ),
        deleteNote: db.prepare("DELETE FROM notes WHERE id = ?"),
        deleteNoteRevisions: db.prepare(
            "DELETE FROM mirror_note_revisions WHERE module_project = ? AND module_row_id = ?",
        ),
        updateNote: db.prepare(
            `UPDATE notes SET type = ?, status = ?, project_path = ?, session_id = ?, content = ?,
             surface_condition = ?, compiled_provider = ?, compiled_config = ?, compiled_at = ?, compile_status = ?,
             ready_at = ?, ready_reason = ?, manifest_json = ?, compiled_check = ?,
             check_hash = ?, check_cron = ?, check_failure_count = ?, check_network_failure_count = ?,
             check_quarantined_until = ?, check_next_due_at = ?, check_compiled_at = ?, check_false_since_at = ?,
             check_last_liveness_at = ?, last_checked_at = ?, check_status = ?, check_version = ?,
             policy_version = ?, anchor_block_id = ?, anchor_ordinal = ?, created_at = ?, updated_at = ?,
             source_revision = ?, state_version = ? WHERE id = ?`,
        ),
        upsertNoteRevision: db.prepare(
            "INSERT OR REPLACE INTO mirror_note_revisions(module_project, module_row_id, context_row_id, status_version) VALUES (?, ?, ?, ?)",
        ),
        updateCursor: db.prepare(
            "INSERT INTO mirror_cursors(domain, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at",
        ),
        contextStoreUuid: getContextStoreUuid(db),
    };
}

function mirrorIdentity(
    db: Database,
    domain: AuthorityDomain,
    moduleProject: string,
    moduleRowId: number,
    statements?: MirrorPageStatements,
): { context_row_id: number } | null {
    return (
        ((
            statements?.identityByModule ??
            db.prepare(
                "SELECT context_row_id FROM mirror_identity WHERE domain = ? AND module_project = ? AND module_row_id = ?",
            )
        ).get(domain, moduleProject, moduleRowId) as { context_row_id: number } | undefined) ?? null
    );
}

function rememberIdentity(
    db: Database,
    domain: AuthorityDomain,
    moduleProject: string,
    moduleRowId: number,
    contextRowId: number,
    statements?: MirrorPageStatements,
): void {
    const existing = mirrorIdentity(db, domain, moduleProject, moduleRowId, statements);
    if (existing) return;
    // A note can be re-minted with a new module row id when authority is prepared
    // again. Replace its stale canonical identity so note evaluation joins the live
    // revision instead of retaining an id that the module no longer recognizes.
    if (domain === "notes") {
        (
            statements?.deleteIdentityByContext ??
            db.prepare("DELETE FROM mirror_identity WHERE domain = ? AND context_row_id = ?")
        ).run(domain, contextRowId);
    }
    (
        statements?.insertIdentity ??
        db.prepare(
            "INSERT OR IGNORE INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES (?, ?, ?, ?)",
        )
    ).run(domain, moduleProject, moduleRowId, contextRowId);
}

function contextNoteId(
    db: Database,
    feed: ChangefeedRow,
    moduleProject: string,
    statements?: MirrorPageStatements,
): number {
    const mapped = mirrorIdentity(db, feed.domain, moduleProject, feed.module_row_id, statements);
    if (mapped) return mapped.context_row_id;
    const row = feed.full_row_snapshot;
    const sourceId = rowNumber(row, "context_row_id", -1);
    const sourceUuid = rowNullableString(row, "context_store_uuid");
    const localStoreUuid = statements?.contextStoreUuid ?? getContextStoreUuid(db);
    if (sourceUuid && sourceUuid === localStoreUuid && sourceId >= 0) {
        const existing = (
            statements?.noteIdByStoreId ??
            db.prepare("SELECT id FROM notes WHERE id = ? AND type = 'smart' AND project_path = ?")
        ).get(sourceId, moduleProject) as { id?: number } | undefined;
        if (existing?.id !== undefined) {
            rememberIdentity(
                db,
                feed.domain,
                moduleProject,
                feed.module_row_id,
                existing.id,
                statements,
            );
            return existing.id;
        }
    }
    const result = (
        statements?.insertNote ??
        db.prepare(
            "INSERT INTO notes (type, status, content, project_path, session_id, created_at, updated_at) VALUES ('smart', 'active', '', ?, ?, 0, 0)",
        )
    ).run(moduleProject, rowNullableString(row, "session_id"));
    const contextId = Number(result.lastInsertRowid);
    rememberIdentity(db, feed.domain, moduleProject, feed.module_row_id, contextId, statements);
    return contextId;
}

function applyNoteRow(db: Database, feed: ChangefeedRow, statements: MirrorPageStatements): void {
    const row = feed.full_row_snapshot;
    const moduleProject = rowString(row, "project_path");
    if (!moduleProject) throw new Error("note feed snapshot has no project_path");
    if (feed.op === "tombstone") {
        const mapped = mirrorIdentity(
            db,
            feed.domain,
            moduleProject,
            feed.module_row_id,
            statements,
        );
        if (!mapped) return;
        statements.deleteNote.run(mapped.context_row_id);
        statements.deleteIdentity.run(feed.domain, moduleProject, feed.module_row_id);
        statements.deleteNoteRevisions.run(moduleProject, feed.module_row_id);
        return;
    }
    const contextId = contextNoteId(db, feed, moduleProject, statements);
    const existing = statements.noteById.get(contextId) as Record<string, unknown> | undefined;
    // Historical v23 feed rows contain only the small note surface. Preserve every
    // rich TS-owned column that is absent from such a snapshot, while still honoring
    // explicit nulls in current complete rows.
    const effectiveRow: Record<string, unknown> = { ...(existing ?? {}), ...row };
    if (!hasSnapshotField(row, "created_at_ms") && existing?.created_at !== undefined) {
        effectiveRow.created_at_ms = existing.created_at;
    }
    if (!hasSnapshotField(row, "updated_at_ms") && existing?.updated_at !== undefined) {
        effectiveRow.updated_at_ms = existing.updated_at;
    }
    // Delivery-only module states are collapsed to the TS vocabulary. The ledger remains
    // authoritative for at-least-once delivery; context.db must not invent a new status.
    const moduleStatus = rowString(effectiveRow, "status", "active");
    const contextStatus =
        moduleStatus === "surfaced" || moduleStatus === "surfacing" ? "ready" : moduleStatus;
    statements.updateNote.run(
        rowString(effectiveRow, "type", "smart"),
        contextStatus,
        moduleProject,
        rowNullableString(effectiveRow, "session_id"),
        rowString(effectiveRow, "content"),
        rowNullableString(effectiveRow, "surface_condition"),
        rowNullableString(effectiveRow, "compiled_provider"),
        rowNullableString(effectiveRow, "compiled_config"),
        typeof effectiveRow.compiled_at === "number" ? effectiveRow.compiled_at : null,
        rowNullableString(effectiveRow, "compile_status"),
        typeof effectiveRow.ready_at === "number" ? effectiveRow.ready_at : null,
        rowNullableString(effectiveRow, "ready_reason"),
        rowNullableString(effectiveRow, "manifest_json"),
        rowNullableString(effectiveRow, "compiled_check"),
        rowNullableString(effectiveRow, "check_hash"),
        rowNullableString(effectiveRow, "check_cron"),
        rowNumber(effectiveRow, "check_failure_count"),
        rowNumber(effectiveRow, "check_network_failure_count"),
        typeof effectiveRow.check_quarantined_until === "number"
            ? effectiveRow.check_quarantined_until
            : null,
        typeof effectiveRow.check_next_due_at === "number" ? effectiveRow.check_next_due_at : null,
        typeof effectiveRow.check_compiled_at === "number" ? effectiveRow.check_compiled_at : null,
        typeof effectiveRow.check_false_since_at === "number"
            ? effectiveRow.check_false_since_at
            : null,
        typeof effectiveRow.check_last_liveness_at === "number"
            ? effectiveRow.check_last_liveness_at
            : null,
        typeof effectiveRow.last_checked_at === "number" ? effectiveRow.last_checked_at : null,
        rowString(effectiveRow, "check_status", "uncompiled"),
        rowNumber(effectiveRow, "check_version"),
        rowNumber(effectiveRow, "policy_version", 1),
        rowNullableString(effectiveRow, "anchor_block_id"),
        typeof effectiveRow.anchor_ordinal === "number" ? effectiveRow.anchor_ordinal : null,
        rowNumber(effectiveRow, "created_at_ms"),
        rowNumber(effectiveRow, "updated_at_ms"),
        // The evaluator fences claims and compile artifacts on these counters;
        // dropping them from the mirror would rewind revisions on a drain back
        // to TypeScript or a reseed into the module.
        rowNumber(effectiveRow, "source_revision"),
        rowNumber(effectiveRow, "state_version"),
        contextId,
    );
    statements.upsertNoteRevision.run(
        moduleProject,
        feed.module_row_id,
        contextId,
        rowNumber(effectiveRow, "status_version"),
    );
}

export function applyMirrorPage(args: { db: Database; page: ChangefeedPage }): number {
    const { db, page } = args;
    // Project memory is claims-native: the module consumes the claim mirror and
    // no supported feed carries memory rows, so any non-notes page is refused
    // without touching authoritative state.
    if (page.domain !== "notes") {
        throw new Error(
            `unsupported mirror domain ${page.domain}: only the notes changefeed is mirrored`,
        );
    }
    const durableCursor = getMirrorCursor(db, page.domain);
    if (page.cursor !== durableCursor) {
        throw new Error(
            `mirror cursor mismatch for ${page.domain}: expected ${durableCursor}, got ${page.cursor}`,
        );
    }
    if (page.next_cursor < durableCursor) {
        throw new Error("mirror page moved its cursor backwards");
    }

    const hasNewRows = page.rows.some(
        (feed) => feed.domain === page.domain && feed.feed_seq > durableCursor,
    );
    if (!hasNewRows) {
        if (page.next_cursor <= durableCursor) return durableCursor;
        withPrivilegedWriter(db, () => {
            db.prepare(
                "INSERT INTO mirror_cursors(domain, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at",
            ).run(page.domain, page.next_cursor, Date.now());
        });
        return page.next_cursor;
    }

    let nextCursor = durableCursor;
    withPrivilegedWriter(db, () => {
        db.transaction(() => {
            const statements = prepareMirrorPageStatements(db);
            const touchedProjects = new Set<string>();
            for (const feed of page.rows) {
                if (feed.domain !== page.domain || feed.feed_seq <= nextCursor) continue;
                const projectPath = rowString(feed.full_row_snapshot, "project_path");
                if (projectPath) touchedProjects.add(projectPath);
                applyNoteRow(db, feed, statements);
                nextCursor = feed.feed_seq;
            }
            for (const projectPath of touchedProjects) {
                bumpDomainMutationEpoch(db, projectPath, page.domain);
            }
            if (page.next_cursor < nextCursor) {
                throw new Error("mirror page moved its cursor backwards");
            }
            nextCursor = Math.max(nextCursor, page.next_cursor);
            statements.updateCursor.run(page.domain, nextCursor, Date.now());
        }).immediate();
    });
    return nextCursor;
}
