import { Database } from "../../shared/sqlite";
/**
 * Whether OpenCode's session DB file exists. Raw-message readers consult this
 * before opening it so a harness with no OpenCode DB (a Pi-only install, or a
 * transform whose per-session RawMessageProvider was unregistered out-of-band)
 * degrades to "no messages" instead of throwing `unable to open database file`.
 */
export declare function openCodeDbExists(): boolean;
export declare function withReadOnlySessionDb<T>(fn: (db: Database) => T): T;
export declare function closeReadOnlySessionDb(): void;
export declare function getRawSessionMessageCountFromDb(db: Database, sessionId: string): number;
export declare function isMidTurn(_deps: unknown, sessionId: string): boolean;
export declare function isMidTurnFromOpenCodeDb(db: Database, sessionId: string): boolean;
/**
 * Resolve `time_created` (ms since epoch) for a set of OpenCode message IDs.
 * Returns a Map keyed by message ID. Missing IDs are simply omitted.
 *
 * Used by temporal-awareness to map compartment start/end message IDs to
 * wall-clock dates for `## start-end · date · title` headings in
 * `<session-history>`.
 */
export declare function getMessageTimesFromOpenCodeDb(sessionId: string, messageIds: readonly string[]): Map<string, number>;
export declare function findLastAssistantModelFromOpenCodeDb(sessionId: string): {
    providerID: string;
    modelID: string;
    agent?: string;
} | null;
//# sourceMappingURL=read-session-db.d.ts.map