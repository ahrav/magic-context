import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import type { Database } from "../../shared/sqlite";
type ReadMessages = ((sessionId: string) => RawMessage[]) & {
    readPage?: (sessionId: string, afterOrdinal: number, limit: number, finalWatermark: number) => RawMessage[];
    getCount?: (sessionId: string) => number;
};
type ReadSingleMessage = (sessionId: string, messageId: string) => RawMessage | null;
type IncrementalMessageSource = ReadSingleMessage | RawMessage;
export declare function scheduleReconciliation(db: Database, sessionId: string, readMessages: ReadMessages): void;
export declare function scheduleIncrementalIndex(db: Database, sessionId: string, messageId: string, messageSource: IncrementalMessageSource): void;
export declare function scheduleClearAndReindex(db: Database, sessionId: string, readMessages: ReadMessages): void;
export declare function isSessionReconciled(sessionId: string): boolean;
export declare function clearSessionTracking(sessionId: string): void;
export declare function __resetMessageIndexAsyncForTests(): void;
export {};
//# sourceMappingURL=message-index-async.d.ts.map