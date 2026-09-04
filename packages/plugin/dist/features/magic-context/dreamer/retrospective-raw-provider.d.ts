import type { Database } from "../../../shared/sqlite";
export declare const RETROSPECTIVE_MAX_MESSAGES_PER_SESSION = 80;
export declare const RETROSPECTIVE_MAX_MESSAGES_PER_RUN = 240;
export declare const RETROSPECTIVE_MAX_SESSIONS_PER_RUN = 20;
export type RetrospectiveMessageRole = "user" | "assistant" | "tool";
export interface RetrospectiveProjectSession {
    sessionId: string;
    path?: string;
    updatedAt?: number;
}
export interface RetrospectiveRawMessage {
    sessionId: string;
    ordinal: number;
    role: RetrospectiveMessageRole;
    text: string;
    toolName?: string;
    isError?: boolean;
    ts: number;
}
/** A per-session since-read. `truncated` is the EXACT saturation signal (the
 *  underlying read hit `capPerSession` with more rows available) — never inferred
 *  from `messages.length`, because normalization both drops rows (assistant/empty)
 *  and adds rows (one assistant message → many tool rows), so a length-based guess
 *  can false-NEGATIVE and lose data. */
export interface RetrospectiveSinceRead {
    messages: RetrospectiveRawMessage[];
    truncated: boolean;
}
export interface RetrospectiveRawProvider {
    listProjectSessions(projectIdentity: string): RetrospectiveProjectSession[] | Promise<RetrospectiveProjectSession[]>;
    readUserMessagesSince(sessionId: string, sinceMs: number, capPerSession: number): RetrospectiveSinceRead | Promise<RetrospectiveSinceRead>;
    /** Oldest raw message timestamp still pending per session. Providers with an
     *  indexed store use this to order the bounded session scan by true backlog
     *  frontier, not by coarse session updated_at. */
    readOldestMessageTimesSince?(sessionIds: readonly string[], sinceMs: number): Map<string, number> | Promise<Map<string, number>>;
    /** The ~`count` most recent typed USER messages at or before `beforeMs` — the
     *  run-boundary overlap so friction spanning two runs isn't missed. */
    readUserMessagesBefore(sessionId: string, beforeMs: number, count: number): RetrospectiveRawMessage[] | Promise<RetrospectiveRawMessage[]>;
    /** Release any reused resources (e.g. a pooled DB handle) after a run. */
    dispose?(): void;
}
interface OpenCodeRetrospectiveRawProviderDeps {
    contextDb: Database;
    openOpenCodeDb?: () => Database | null;
    /** Test-only shortcut: when provided, this connection is not closed by the provider. */
    opencodeDb?: Database;
}
export declare class OpenCodeRetrospectiveRawProvider implements RetrospectiveRawProvider {
    private readonly deps;
    private readonly openDb;
    private sharedDb;
    private sharedDbOpened;
    constructor(deps: OpenCodeRetrospectiveRawProviderDeps);
    listProjectSessions(projectIdentity: string): RetrospectiveProjectSession[];
    private resolveDb;
    readUserMessagesSince(sessionId: string, sinceMs: number, capPerSession: number): RetrospectiveSinceRead;
    readOldestMessageTimesSince(sessionIds: readonly string[], sinceMs: number): Map<string, number>;
    readUserMessagesBefore(sessionId: string, beforeMs: number, count: number): RetrospectiveRawMessage[];
    /** Close the reused read-only handle. Safe to call multiple times. */
    dispose(): void;
}
export interface RetrospectiveScanWindow {
    /** All scanned messages (user rows + tool metadata), oldest→newest, ordinals
     *  reassigned globally. Includes the pre-watermark overlap (user-only). */
    messages: RetrospectiveRawMessage[];
    /** The max message ts ACTUALLY scanned this run (the content watermark to
     *  persist on completion). Never less than `watermarkMs` (overlap rows are
     *  ≤ watermark and cannot pull it back). */
    maxScannedTs: number;
}
/**
 * The retrospective scan window for one run: everything new since the content
 * watermark, PLUS the ~`overlapUserCount` user lines immediately before the
 * watermark for sessions that have kept new rows (so friction straddling a run
 * boundary isn't missed).
 * The since portion carries user rows + tool metadata (the deepen context); the
 * overlap portion is user-only (gate context). Ordinals are reassigned globally.
 */
export declare function readRetrospectiveScanWindow(provider: RetrospectiveRawProvider, projectIdentity: string, watermarkMs: number, overlapUserCount: number, options?: {
    maxMessagesPerRun?: number;
    capPerSession?: number;
    maxSessionsPerRun?: number;
}): Promise<RetrospectiveScanWindow>;
export {};
//# sourceMappingURL=retrospective-raw-provider.d.ts.map