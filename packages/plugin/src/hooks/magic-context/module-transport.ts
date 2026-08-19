import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
    AdmissionClass,
    type BindIdentity,
    isConsumerReconnectTransient,
    Priority,
    type RouteHandle,
    type RouteTarget,
    SocketClosedError,
    SocketTimeoutError,
    StaleRouteHandleError,
    SubcClient,
} from "@cortexkit/subc-client";
import type {
    AuthorityDrainResponse,
    AuthorityStatus,
    ChangefeedPage,
} from "../../features/magic-context/context-authority";
import { getDataDir } from "../../shared/data-path";
import { getHarness } from "../../shared/harness";
import { isRecord } from "../../shared/record-type-guard";

const DEFAULT_MODULE_ID = "magic-context";
const CONNECT_BACKOFF_INITIAL_MS = 1_000;
const CONNECT_BACKOFF_MAX_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 2_000;
const MODULE_SEND_TIMEOUT_MS = 15_000;
const TRANSFORM_SEND_TIMEOUT_MS = 5_000;
/** Consumer deadline for the module's exported historian::MAX_WRAPUP_REQUEST_BUDGET. */
export const MAX_WRAPUP_REQUEST_BUDGET_MS = 3_800_000;
const SERIAL_LANE_MAX_WAITERS = 16;
const SERIAL_LANE_MAX_WAITERS_PER_SESSION = 8;
const SERIAL_LANE_MIN_REMAINING_MS = 25;
const CANONICAL_ROOT_CACHE_MAX_ENTRIES = 256;

function getDefaultConnectionFile(): string {
    return join(getDataDir(), "cortexkit", "run", "subc-connection.json");
}

function errorChainSome(
    error: unknown,
    predicate: (value: Record<string, unknown>) => boolean,
): boolean {
    let current = error;
    const seen = new Set<unknown>();
    while (isRecord(current) && !seen.has(current)) {
        seen.add(current);
        if (predicate(current)) return true;
        current = current.cause;
    }
    return false;
}

/** Route errors must be recognized by wire-visible shape because plugin bundles can carry a
 *  different copy of subc-client from the client that originated the error. */
function isStaleOrDeadRouteFailure(error: unknown): boolean {
    return errorChainSome(error, (current) => {
        const code = typeof current.code === "string" ? current.code : "";
        const name = typeof current.name === "string" ? current.name : "";
        const message = typeof current.message === "string" ? current.message : "";
        return (
            [
                "stale_route_handle",
                "route_closed",
                "unknown_channel",
                "unrecognized_channel",
                "route_gone",
            ].includes(code) ||
            name === "StaleRouteHandleError" ||
            /route handle \(\d+,\s*\d+\) is not live on the current connection/i.test(message) ||
            /\b(?:unknown|unrecognized) channel\b/i.test(message)
        );
    });
}

function isConnectionFailure(error: unknown): boolean {
    if (
        error instanceof SocketClosedError ||
        error instanceof SocketTimeoutError ||
        error instanceof StaleRouteHandleError ||
        isConsumerReconnectTransient(error) ||
        isStaleOrDeadRouteFailure(error)
    ) {
        return true;
    }
    return errorChainSome(error, (current) => {
        const code = typeof current.code === "string" ? current.code : "";
        const message = typeof current.message === "string" ? current.message : "";
        return (
            [
                "ENOENT",
                "ECONNREFUSED",
                "ECONNRESET",
                "EPIPE",
                "ETIMEDOUT",
                "request_deadline",
                "deadline_exceeded_no_drop_observed",
                "connection_dropped",
                "SUBC_CONNECTION_BACKOFF",
            ].includes(code) ||
            /\bclient closed\b|\bconnection closed\b|\bclosed the connection\b/i.test(message)
        );
    });
}

interface CachedRoute {
    route: RouteHandle;
    generation: number;
}

interface EnsuredRoute {
    client: SubcClient;
    route: RouteHandle;
    routeKey: string;
    generation: number;
}

export interface ModuleTransportGenerationChangedResult {
    transport_status: "connection_generation_changed";
    previous_generation: number;
    current_generation: number;
}

export function isModuleTransportGenerationChangedResult(
    value: unknown,
): value is ModuleTransportGenerationChangedResult {
    return (
        isRecord(value) &&
        value.transport_status === "connection_generation_changed" &&
        typeof value.previous_generation === "number" &&
        typeof value.current_generation === "number"
    );
}

interface SerialLaneWaiter {
    signal?: AbortSignal;
    deadlineMs: number;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    onAbort: () => void;
    timer: ReturnType<typeof setTimeout>;
    settled: boolean;
}

interface SerialLane {
    active: boolean;
    waiters: SerialLaneWaiter[];
}

interface OpeningRoute {
    client: SubcClient;
    generation: number;
    promise: Promise<EnsuredRoute>;
}

export class SubcModuleTransport {
    private readonly connectionFile: string;
    private readonly moduleId: string;
    private readonly requestTimeoutMs: number;
    private readonly routeSessionPrefix: string;
    private client: SubcClient | null = null;
    private routes = new Map<string, CachedRoute>();
    private routeOpenings = new Map<string, OpeningRoute>();
    private canonicalRootCache = new Map<string, string>();
    // Preserve request order within a session while allowing independent sessions to overlap.
    // Both the aggregate and per-session counts cap queued work; active calls are not waiters.
    private sessionLanes = new Map<string, SerialLane>();
    private queuedLaneWaiters = 0;
    private wrapupSessions = new Map<string, number>();
    private nextProbeMs = 0;
    private connectionPromise: Promise<SubcClient> | null = null;
    private authorityProjectRoot = "";
    /**
     * Filesystem root used to bind authority/mirror routes. Authority request
     * bodies carry the MC project IDENTITY (git:<sha> / dir:<hash>), which is not
     * a path — the daemon validates BindIdentity.project_root against the real
     * filesystem and rejects identity strings outright.
     */
    private authorityBindRoot = "";
    private backoffMs = CONNECT_BACKOFF_INITIAL_MS;
    private connectionGeneration = 0;
    private stateSyncCapabilityCache: {
        generation: number;
        capabilities: { state_sync_deltas?: boolean };
    } | null = null;

    /** Returns the capability snapshot for the currently live SUBC connection. */
    getCachedStateSyncCapabilities(): { state_sync_deltas?: boolean } | undefined {
        const cached = this.stateSyncCapabilityCache;
        if (!cached || cached.generation !== this.connectionGeneration) return undefined;
        return cached.capabilities;
    }

    /** Clears the snapshot after a module signal that can change its wire capabilities. */
    invalidateStateSyncCapabilities(): void {
        this.stateSyncCapabilityCache = null;
    }

    async stateSyncCapabilities(args: {
        sessionId: string;
        projectRoot: string;
    }): Promise<{ state_sync_deltas?: boolean }> {
        const cached = this.getCachedStateSyncCapabilities();
        if (cached) return cached;
        const response = await this.call({
            sessionId: args.sessionId,
            projectRoot: args.projectRoot,
            method: "session.status",
            body: { method: "session.status", v: 1, session_id: args.sessionId },
        });
        const raw = isRecord(response) ? response : {};
        const value = isRecord(raw.result) ? raw.result : raw;
        const epochs = isRecord(value.epochs) ? value.epochs : {};
        const capabilities = { state_sync_deltas: epochs.state_sync_deltas === true };
        this.stateSyncCapabilityCache = { generation: this.connectionGeneration, capabilities };
        return capabilities;
    }

    constructor(
        connectionFile?: string,
        moduleId = DEFAULT_MODULE_ID,
        requestTimeoutMs = MODULE_SEND_TIMEOUT_MS,
        routeSessionPrefix = "",
    ) {
        this.connectionFile = connectionFile ?? getDefaultConnectionFile();
        this.moduleId = moduleId;
        this.requestTimeoutMs = requestTimeoutMs;
        this.routeSessionPrefix = routeSessionPrefix;
    }

    private deadlineError(detail: string): Error & { code?: string } {
        const error = new Error(`module transport deadline expired ${detail}`) as Error & {
            code?: string;
        };
        error.code = "ETIMEDOUT";
        return error;
    }

    private laneTimeoutError(): Error & { code?: string } {
        return this.deadlineError("while queued");
    }

    private connectionChangedError(detail: string): Error & { code?: string } {
        const error = new Error(detail) as Error & { code?: string };
        error.code = "ECONNRESET";
        return error;
    }

    private async beforeDeadline<T>(
        operation: Promise<T>,
        deadlineMs: number,
        detail: string,
    ): Promise<T> {
        // The race can abandon `operation` (deadline fires first, or the caller's
        // catch invalidates the connection). A later rejection of the abandoned
        // promise — close() failing every pending request with "client closed" —
        // would then be UNHANDLED and Bun prints a crash-shaped stack to the
        // host's stderr. Subscribe a no-op handler up front: the race still
        // receives the original settlement, and a post-race rejection is
        // delivered here instead of the process-level unhandled hook.
        operation.catch(() => {});
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) throw this.deadlineError(detail);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                operation,
                new Promise<T>((_resolve, reject) => {
                    timer = setTimeout(() => reject(this.deadlineError(detail)), remainingMs);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private cleanupLane(sessionId: string, lane: SerialLane): void {
        if (
            !lane.active &&
            lane.waiters.length === 0 &&
            this.sessionLanes.get(sessionId) === lane
        ) {
            this.sessionLanes.delete(sessionId);
        }
    }

    private laneRelease(sessionId: string, lane: SerialLane): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            lane.active = false;
            this.dispatchNextLaneWaiter(sessionId, lane);
        };
    }

    private dispatchNextLaneWaiter(sessionId: string, lane: SerialLane): void {
        if (lane.active) return;
        while (lane.waiters.length > 0) {
            const waiter = lane.waiters.shift();
            if (!waiter) continue;
            this.queuedLaneWaiters = Math.max(0, this.queuedLaneWaiters - 1);
            if (waiter.settled) continue;
            waiter.settled = true;
            clearTimeout(waiter.timer);
            waiter.signal?.removeEventListener("abort", waiter.onAbort);
            if (waiter.signal?.aborted) {
                waiter.reject(waiter.signal.reason ?? new Error("module transport call aborted"));
                continue;
            }
            if (waiter.deadlineMs - Date.now() < SERIAL_LANE_MIN_REMAINING_MS) {
                waiter.reject(this.laneTimeoutError());
                continue;
            }
            lane.active = true;
            waiter.resolve(this.laneRelease(sessionId, lane));
            return;
        }
        this.cleanupLane(sessionId, lane);
    }

    private queueFullError(): Error & { code?: string } {
        const error = new Error("module transport queue is full") as Error & { code?: string };
        error.code = "EBUSY";
        return error;
    }

    private acquireCorrectnessLane(
        sessionId: string,
        signal: AbortSignal | undefined,
        deadlineMs: number,
    ): Promise<() => void> {
        if (signal?.aborted) {
            return Promise.reject(signal.reason ?? new Error("module transport call aborted"));
        }
        if (deadlineMs - Date.now() < SERIAL_LANE_MIN_REMAINING_MS) {
            return Promise.reject(this.laneTimeoutError());
        }
        const lane = this.sessionLanes.get(sessionId) ?? { active: false, waiters: [] };
        this.sessionLanes.set(sessionId, lane);
        if (!lane.active && lane.waiters.length === 0) {
            lane.active = true;
            return Promise.resolve(this.laneRelease(sessionId, lane));
        }
        if (
            this.queuedLaneWaiters >= SERIAL_LANE_MAX_WAITERS ||
            lane.waiters.length >= SERIAL_LANE_MAX_WAITERS_PER_SESSION
        ) {
            return Promise.reject(this.queueFullError());
        }
        return new Promise<() => void>((resolve, reject) => {
            const waiter = {} as SerialLaneWaiter;
            const removeAndReject = (error: unknown): void => {
                if (waiter.settled) return;
                waiter.settled = true;
                clearTimeout(waiter.timer);
                signal?.removeEventListener("abort", waiter.onAbort);
                const index = lane.waiters.indexOf(waiter);
                if (index >= 0) {
                    lane.waiters.splice(index, 1);
                    this.queuedLaneWaiters = Math.max(0, this.queuedLaneWaiters - 1);
                }
                reject(error);
                this.cleanupLane(sessionId, lane);
            };
            waiter.signal = signal;
            waiter.deadlineMs = deadlineMs;
            waiter.resolve = resolve;
            waiter.reject = reject;
            waiter.settled = false;
            waiter.onAbort = () =>
                removeAndReject(signal?.reason ?? new Error("module transport call aborted"));
            waiter.timer = setTimeout(
                () => removeAndReject(this.laneTimeoutError()),
                Math.max(0, deadlineMs - Date.now()),
            );
            signal?.addEventListener("abort", waiter.onAbort, { once: true });
            lane.waiters.push(waiter);
            this.queuedLaneWaiters += 1;
        });
    }

    async call(args: {
        sessionId: string;
        projectRoot: string;
        method:
            | "state_sync"
            | "transform"
            | "session.status"
            | "session.delete"
            | "session.flush"
            | "session.recomp"
            | "session.wrapup"
            | "todo_state.set"
            | "agent_drops.append"
            | "authority.status"
            | "authority.prepare"
            | "authority.seed"
            | "authority.drain.begin"
            | "authority.drain.finish"
            | "authority.drain_seed"
            | "authority.drain_memories"
            | "authority.drain_notes"
            | "authority.drain_compartments"
            | "authority.drain_reconcile"
            | "authority.drain_verify"
            | "authority.drain_flip"
            | "authority.drain_finish"
            | "mirror.pull"
            | "ctx_note"
            | "ctx_memory"
            | "note.evaluate"
            | "note.evaluation.register"
            | "note.evaluation.heartbeat"
            | "note.evaluation.unregister"
            | "note.evaluation.next"
            | "note.evaluation.renew"
            | "note.evaluation.complete"
            | "note.evaluation.abandon"
            | "transform.ack"
            | "transform.nack"
            | "dreamer.run_task"
            | "memory.set_classification";
        body: unknown;
        signal?: AbortSignal;
        /** Do not retry after reconnecting; let the caller rebuild for the new connection. */
        generationSensitive?: boolean;
        /** Producer-backed calls can outlive the default transport budget. */
        timeoutMs?: number;
    }): Promise<unknown> {
        const wrapupInFlight = (this.wrapupSessions.get(args.sessionId) ?? 0) > 0;
        const attemptTimeoutMs =
            args.timeoutMs ??
            (args.method === "session.wrapup" ||
            (args.method === "session.status" && wrapupInFlight)
                ? MAX_WRAPUP_REQUEST_BUDGET_MS
                : args.method === "transform"
                  ? Math.min(this.requestTimeoutMs, TRANSFORM_SEND_TIMEOUT_MS)
                  : this.requestTimeoutMs);
        const tracksWrapup = args.method === "session.wrapup";
        if (tracksWrapup) {
            this.wrapupSessions.set(
                args.sessionId,
                (this.wrapupSessions.get(args.sessionId) ?? 0) + 1,
            );
        }
        const finishWrapupTracking = (): void => {
            if (!tracksWrapup) return;
            const remaining = (this.wrapupSessions.get(args.sessionId) ?? 1) - 1;
            if (remaining > 0) this.wrapupSessions.set(args.sessionId, remaining);
            else this.wrapupSessions.delete(args.sessionId);
        };
        const laneDeadlineMs = Date.now() + attemptTimeoutMs;
        let releaseLane: (() => void) | undefined;
        try {
            releaseLane = await this.acquireCorrectnessLane(
                args.sessionId,
                args.signal,
                laneDeadlineMs,
            );
        } catch (error) {
            finishWrapupTracking();
            throw error;
        }
        let activeAttemptClient: SubcClient | null = null;
        const onAbort = () => this.invalidateConnection(activeAttemptClient ?? this.client);
        args.signal?.addEventListener("abort", onAbort, { once: true });
        try {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                activeAttemptClient = null;
                let ensuredRoute: EnsuredRoute | null = null;
                try {
                    if (args.signal?.aborted) {
                        throw args.signal.reason ?? new Error("module transport call aborted");
                    }
                    // Each attempt gets its own timeout, apart from the queue wait limit, so a dead
                    // socket can hit the deadline and still be replaced on one reconnect.
                    const attemptDeadlineMs = Date.now() + attemptTimeoutMs;
                    ensuredRoute = await this.ensureRoute(
                        args.sessionId,
                        args.projectRoot,
                        attemptDeadlineMs,
                    );
                    activeAttemptClient = ensuredRoute.client;
                    if (args.signal?.aborted) {
                        throw args.signal.reason ?? new Error("module transport call aborted");
                    }
                    const response = await this.beforeDeadline(
                        ensuredRoute.client.request(ensuredRoute.route, args.body, {
                            priority: Priority.Background,
                            admissionClass: AdmissionClass.Normal,
                            timeoutMs: Math.max(1, attemptDeadlineMs - Date.now()),
                        }),
                        attemptDeadlineMs,
                        "waiting for the module response",
                    );
                    if (
                        this.client !== ensuredRoute.client ||
                        this.connectionGeneration !== ensuredRoute.generation
                    ) {
                        throw this.connectionChangedError(
                            "subc connection changed while awaiting the module response",
                        );
                    }
                    return response;
                } catch (error) {
                    if (isConnectionFailure(error)) {
                        const previousGeneration =
                            ensuredRoute?.generation ?? this.connectionGeneration;
                        if (ensuredRoute) {
                            this.dropRoute(ensuredRoute.routeKey, ensuredRoute.route);
                            this.invalidateConnection(ensuredRoute.client);
                        } else {
                            this.invalidateConnection();
                        }
                        if (args.generationSensitive && !args.signal?.aborted) {
                            return {
                                transport_status: "connection_generation_changed",
                                previous_generation: previousGeneration,
                                current_generation: this.connectionGeneration,
                            } satisfies ModuleTransportGenerationChangedResult;
                        }
                        // Retry once on a fresh connection generation before the caller enters its
                        // LKG/raw fallback ladder.
                        if (attempt === 0 && !args.signal?.aborted) continue;
                    }
                    throw error;
                }
            }
            throw new Error("module transport route retry exhausted");
        } finally {
            args.signal?.removeEventListener("abort", onAbort);
            finishWrapupTracking();
            releaseLane();
        }
    }

    private async authorityRequest(
        sessionId: string,
        projectRoot: string,
        method:
            | "authority.status"
            | "authority.prepare"
            | "authority.seed"
            | "authority.drain.begin"
            | "authority.drain.finish"
            | "authority.drain_seed"
            | "authority.drain_memories"
            | "authority.drain_notes"
            | "authority.drain_compartments"
            | "authority.drain_reconcile"
            | "authority.drain_verify"
            | "authority.drain_finish"
            | "mirror.pull",
        body: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        // The transport serializes the body verbatim; the module dispatches on the
        // body's own method field, so it must always be present and canonical here.
        const response = (await this.call({
            sessionId,
            projectRoot,
            method,
            body: { ...body, method, v: 1 },
        })) as unknown;
        if (isRecord(response) && isRecord(response.result)) return response.result;
        if (isRecord(response)) return response;
        throw new Error(`module returned an invalid ${method} response`);
    }

    setAuthorityBindRoot(root: string): void {
        this.authorityBindRoot = root;
    }

    private bindRootForAuthority(): string {
        return this.authorityBindRoot.length > 0 ? this.authorityBindRoot : process.cwd();
    }

    async authorityStatus(args: {
        context_store_uuid: string;
        project: string;
        projectRoot?: string;
        domain: "memories" | "notes";
    }): Promise<{ authority: AuthorityStatus | null }> {
        this.authorityProjectRoot = args.project;
        const { projectRoot, ...body } = args;
        const response = await this.authorityRequest(
            args.project,
            projectRoot ?? this.bindRootForAuthority(),
            "authority.status",
            body,
        );
        return { authority: (response.authority as AuthorityStatus | null) ?? null };
    }

    async authorityPrepare(args: Record<string, unknown>): Promise<{ authority: AuthorityStatus }> {
        this.authorityProjectRoot = String(args.project ?? "");
        const { projectRoot, ...body } = args;
        const response = await this.authorityRequest(
            String(args.project ?? "authority"),
            typeof projectRoot === "string" ? projectRoot : this.bindRootForAuthority(),
            "authority.prepare",
            body,
        );
        if (!isRecord(response.authority)) throw new Error("authority.prepare omitted authority");
        return { authority: response.authority as unknown as AuthorityStatus };
    }

    async authoritySeed(
        args: Record<string, unknown>,
    ): Promise<{ seeded: number; module_row_ids?: number[] }> {
        this.authorityProjectRoot = String(args.project ?? "");
        const { projectRoot, ...body } = args;
        const response = await this.authorityRequest(
            String(args.project ?? "authority"),
            typeof projectRoot === "string" ? projectRoot : this.bindRootForAuthority(),
            "authority.seed",
            body,
        );
        return {
            seeded: typeof response.seeded === "number" ? response.seeded : 0,
            module_row_ids: Array.isArray(response.module_row_ids)
                ? response.module_row_ids.filter((id): id is number => typeof id === "number")
                : undefined,
        };
    }

    async authorityDrain(args: Record<string, unknown>): Promise<AuthorityDrainResponse> {
        this.authorityProjectRoot = String(args.project ?? this.authorityProjectRoot);
        const method = String(args.method ?? "authority.drain.step") as Parameters<
            SubcModuleTransport["authorityRequest"]
        >[2];
        const { projectRoot, ...body } = args;
        const response = await this.authorityRequest(
            String(args.project ?? "authority"),
            typeof projectRoot === "string" ? projectRoot : this.bindRootForAuthority(),
            method,
            body,
        );
        if (isRecord(response.authority)) {
            return { authority: response.authority as unknown as AuthorityStatus };
        }
        if (typeof response.code === "string") {
            return {
                code: response.code,
                retryable: response.retryable === true,
            };
        }
        throw new Error("authority.drain omitted authority");
    }

    async mirrorPull(args: {
        domain: "memories" | "notes";
        cursor: number;
        limit: number;
        live_only?: boolean;
        projectRoot?: string;
    }): Promise<{ page: ChangefeedPage }> {
        const { projectRoot, ...body } = args;
        const response = await this.authorityRequest(
            `mirror:${args.domain}`,
            projectRoot ?? this.bindRootForAuthority(),
            "mirror.pull",
            body,
        );
        if (!isRecord(response.page)) throw new Error("mirror.pull omitted page");
        return { page: response.page as unknown as ChangefeedPage };
    }

    async deleteSession(sessionId: string, projectRoot: string): Promise<void> {
        await this.call({
            sessionId,
            projectRoot,
            method: "session.delete",
            body: { method: "session.delete", v: 1, session_id: sessionId },
        });
    }

    closeSession(sessionId: string): void {
        const client = this.client;
        const prefix = `${sessionId}\0`;
        const routes = [...this.routes.entries()].filter(([key]) => key.startsWith(prefix));
        for (const [key, cachedRoute] of routes) {
            this.routes.delete(key);
            if (client) {
                void client.closeRoute(cachedRoute.route).catch((error: unknown) => {
                    if (this.client === client && isConnectionFailure(error)) {
                        this.invalidateConnection(client);
                    }
                });
            }
        }
        if (routes.length === 0 && this.sessionLanes.get(sessionId)?.active) {
            this.invalidateConnection(client);
        }
    }

    private async ensureRoute(
        sessionId: string,
        rawProjectRoot: string,
        deadlineMs = Date.now() + this.requestTimeoutMs,
    ): Promise<EnsuredRoute> {
        // The transform and tool lanes can observe the same directory under different
        // spellings when the project is reached through a symlink (OpenCode reports the
        // launch spelling on one lane and the resolved target on the other). The module
        // pairs (session, root) for lineage, and it canonicalizes on ITS filesystem —
        // which cannot see this process's mount/symlink namespace. Converge here, where
        // the paths are resolvable, so both lanes bind the same route root.
        const projectRoot = this.canonicalRoot(rawProjectRoot);
        // One identity may legitimately have multiple filesystem routes (for example,
        // worktrees). Reusing a route across roots would bind authority to the wrong tree.
        const routeKey = `${sessionId}\0${projectRoot}`;
        // Read the cached route only after the connection is settled. The generation check
        // makes a route from any earlier connection invisible even if a cache clear is missed.
        const client = await this.ensureConnected();
        const generation = this.connectionGeneration;
        const existing = this.routes.get(routeKey);
        if (existing?.generation === generation) {
            return { client, route: existing.route, routeKey, generation };
        }
        if (existing) this.routes.delete(routeKey);
        const opening = this.routeOpenings.get(routeKey);
        if (opening?.client === client && opening.generation === generation) {
            return await opening.promise;
        }

        const promise = (async (): Promise<EnsuredRoute> => {
            const target: RouteTarget = { kind: "tool_provider", module_id: this.moduleId };
            const identity: BindIdentity = {
                project_root: projectRoot,
                harness: getHarness(),
                session: `${this.routeSessionPrefix}${sessionId}`,
            };
            const route = await this.beforeDeadline(
                client.routeOpen(target, identity),
                deadlineMs,
                "opening the module route",
            );
            if (this.client !== client || generation !== this.connectionGeneration) {
                await client.closeRoute(route).catch(() => undefined);
                throw this.connectionChangedError(
                    "subc connection changed while opening module route",
                );
            }
            this.routes.set(routeKey, { route, generation });
            return { client, route, routeKey, generation };
        })();
        const routeOpening = { client, generation, promise };
        this.routeOpenings.set(routeKey, routeOpening);
        try {
            return await promise;
        } finally {
            if (this.routeOpenings.get(routeKey) === routeOpening) {
                this.routeOpenings.delete(routeKey);
            }
        }
    }

    private dropRoute(routeKey: string, route?: RouteHandle): void {
        const existing = this.routes.get(routeKey);
        if (!existing || (route && existing.route !== route)) return;
        this.routes.delete(routeKey);
    }

    /** Resolve symlinks with per-instance memoization; keep the input spelling when the
     *  path is gone (canonicalization must never fail a request). */
    private canonicalRoot(root: string): string {
        const cached = this.canonicalRootCache.get(root);
        if (cached !== undefined) {
            this.canonicalRootCache.delete(root);
            this.canonicalRootCache.set(root, cached);
            return cached;
        }
        let resolved = root;
        try {
            resolved = realpathSync.native(root);
        } catch {
            // Gone or unreadable roots keep their observed spelling.
        }
        this.canonicalRootCache.set(root, resolved);
        while (this.canonicalRootCache.size > CANONICAL_ROOT_CACHE_MAX_ENTRIES) {
            const oldestRoot = this.canonicalRootCache.keys().next().value as string | undefined;
            if (oldestRoot === undefined) break;
            this.canonicalRootCache.delete(oldestRoot);
        }
        return resolved;
    }

    private connectClient(): Promise<SubcClient> {
        return SubcClient.connect({
            connectionFile: this.connectionFile,
            handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        });
    }

    private async ensureConnected(): Promise<SubcClient> {
        if (this.client) return this.client;
        if (this.connectionPromise) return await this.connectionPromise;
        const now = Date.now();
        if (now < this.nextProbeMs) {
            const error = new Error(
                `subc connection backoff active until ${this.nextProbeMs}`,
            ) as Error & {
                code?: string;
            };
            error.code = "SUBC_CONNECTION_BACKOFF";
            throw error;
        }

        const generation = this.connectionGeneration;
        const connecting = (async (): Promise<SubcClient> => {
            let candidate: SubcClient | null = null;
            try {
                candidate = await this.connectClient();
                if (generation !== this.connectionGeneration) {
                    candidate.close();
                    throw this.connectionChangedError("subc connection attempt was superseded");
                }
                this.client = candidate;
                this.routes.clear();
                this.backoffMs = CONNECT_BACKOFF_INITIAL_MS;
                this.nextProbeMs = 0;
                return candidate;
            } catch (error) {
                candidate?.close();
                if (generation === this.connectionGeneration) this.invalidateConnection();
                this.nextProbeMs = Date.now() + this.backoffMs;
                this.backoffMs = Math.min(this.backoffMs * 2, CONNECT_BACKOFF_MAX_MS);
                throw error;
            }
        })();
        this.connectionPromise = connecting;
        try {
            return await connecting;
        } finally {
            if (this.connectionPromise === connecting) this.connectionPromise = null;
        }
    }

    private invalidateConnection(client: SubcClient | null = this.client): void {
        if (client && this.client !== client) return;
        this.connectionGeneration += 1;
        this.invalidateStateSyncCapabilities();
        this.client = null;
        this.routes.clear();
        this.routeOpenings.clear();
        client?.close();
    }
}

export const __moduleTransportTest = { isConnectionFailure, isStaleOrDeadRouteFailure };
