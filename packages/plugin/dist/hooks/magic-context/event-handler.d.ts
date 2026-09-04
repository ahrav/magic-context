import type { createCompactionHandler } from "../../features/magic-context/compaction";
import type { Tagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { type NotificationParams } from "./send-session-notification";
type CacheTtlConfig = string | Record<string, string>;
interface ContextUsageEntry {
    usage: ContextUsage;
    updatedAt: number;
    lastResponseTime?: number;
    hasUsageTokens?: boolean;
}
export interface EventHandlerDeps {
    contextUsageMap: Map<string, ContextUsageEntry>;
    compactionHandler: ReturnType<typeof createCompactionHandler>;
    /**
     * Compaction-off mode (issue #266), boot-resolved. Overflow recovery is
     * never armed in this mode (record the provider-reported limit only, so
     * raw-usage math stays accurate) and Channel-2 delivery stays silent;
     * the off-transition clears any persisted intent.
     */
    compactionOff?: boolean;
    onSessionCacheInvalidated?: (sessionId: string) => void;
    onRustWireInvalidated?: (sessionId: string) => void;
    onSessionDeleted?: (sessionId: string) => void;
    config: {
        protected_tags: number;
        clear_reasoning_age?: number;
        execute_threshold_percentage?: number | {
            default: number;
            [modelKey: string]: number;
        };
        execute_threshold_tokens?: {
            default?: number;
            [modelKey: string]: number | undefined;
        };
        cache_ttl: CacheTtlConfig;
        commit_cluster_trigger?: {
            enabled: boolean;
            min_clusters: number;
        };
    };
    tagger: Tagger;
    db: import("../../shared/sqlite").Database;
    /** The in-process client OpenCode hands the plugin; Channel 2 delivers through it. */
    client?: unknown;
    /** Channel 1 per-session metric baseline; read for the Channel 2 ceiling-nudge wording. */
    channel1StateBySession?: Map<string, import("./ctx-reduce-nudge").Channel1State>;
    /** Hold Rust module directives until the terminal `message.updated` event, just like TypeScript nudge directives, so both use the same host-side delivery path. */
    channel2DirectiveTextBySession?: Map<string, string>;
    getNotificationParams?: (sessionId: string) => NotificationParams;
    /**
     * Process-scoped set of Magic Context's own hidden child sessions, keyed by
     * sessionId. Populated here at `session.created` when the child's title
     * starts with `magic-context-`; read by the transform + system-prompt hooks
     * to fully exempt these sessions from the MC pipeline.
     */
    internalChildSessions?: Set<string>;
}
export declare function createEventHandler(deps: EventHandlerDeps): (input: {
    event: {
        type: string;
        properties?: unknown;
    };
}) => Promise<void>;
export {};
//# sourceMappingURL=event-handler.d.ts.map