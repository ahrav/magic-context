import type { ContextDatabase } from "../../features/magic-context/storage";
import { type Tagger } from "../../features/magic-context/tagger";
import { type ToolCallIndex, type ToolDropResult, ToolMutationBatch } from "./tool-drop-target";
type ToolOwnerFallbackLookup = {
    kind: "candidates";
    callId: string;
} | {
    kind: "messageTimes";
    messageIds: readonly string[];
};
export type MessageInfo = {
    id?: string;
    role?: string;
    sessionID?: string;
    summary?: boolean;
    /** Marks one of the two m[0]/m[1] messages prepended by compartment injection. */
    syntheticHead?: boolean;
    finish?: string;
    error?: unknown;
};
export interface ThinkingLikePart {
    type: string;
    thinking?: string;
    text?: string;
}
export type MessageLike = {
    info: MessageInfo;
    parts: unknown[];
};
export interface TagNormalizationTarget {
    tagNumber: number;
    message: MessageLike;
    part: unknown;
    field: "text" | "tool_state_output" | "tool_result_content";
}
export type TagTarget = {
    setContent: (content: string) => boolean;
    getContent?: () => string | null;
    drop?: () => ToolDropResult;
    truncate?: () => ToolDropResult;
    /** Edit-marker compression for an edit/write superseded by a later edit to
     * the same file: keep the call + filePath + a region hint of the diff,
     * output → [dropped §N§]. Used by smart-drops. */
    editMarker?: () => ToolDropResult;
    /** Non-mutating: would drop()/truncate() actually reclaim bytes? Tool
     * targets only; absent on message/file targets. */
    canDrop?: () => boolean;
    /** Non-mutating read of the tool invocation's input object (e.g. to read
     * `ctx_note`'s action or an edit's filePath for supersession selection).
     * Tool targets only; null when no invocation part is present. */
    readInput?: () => Record<string, unknown> | null;
    message?: MessageLike;
};
export interface TagMessagesResult {
    targets: Map<number, TagTarget>;
    reasoningByMessage: Map<MessageLike, ThinkingLikePart[]>;
    messageTagNumbers: Map<MessageLike, number>;
    toolCallIndex: ToolCallIndex;
    batch: ToolMutationBatch;
    hasRecentReduceCall: boolean;
    /** Whether recent assistant messages contain git commit hash patterns */
    hasRecentCommit: boolean;
    /** Exact part references that received a Magic Context tag prefix while tagMessages processed them. */
    normalizationTargets: TagNormalizationTarget[];
}
export interface TagMessagesOptions {
    /**
     * When true, skip injecting §N§ prefix into message text/tool output parts.
     * DB-level tag records are still created normally — this flag only affects
     * whether the agent-visible part content gets the tag prefix. Used when
     * the session's tool allow-list denies ctx_reduce so agents don't see tag
     * markers they can't act on. Cache-safe: the availability verdict is frozen
     * per session, so message shape stays stable.
     */
    skipPrefixInjection?: boolean;
    /** @internal diagnostic hook used by cache-stability/perf tests. */
    onToolOwnerFallbackLookup?: (lookup: ToolOwnerFallbackLookup) => void;
}
export declare function tagMessages(sessionId: string, messages: MessageLike[], tagger: Tagger, db: ContextDatabase, options?: TagMessagesOptions): TagMessagesResult;
export {};
//# sourceMappingURL=tag-messages.d.ts.map