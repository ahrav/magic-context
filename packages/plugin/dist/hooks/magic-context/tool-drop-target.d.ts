import type { MessageLike, ThinkingLikePart } from "./tag-messages";
export type ToolDropResult = "removed" | "truncated" | "absent" | "incomplete";
interface ToolCallObservation {
    callId: string;
    kind: "invocation" | "result";
}
export interface IndexedOccurrence {
    message: MessageLike;
    part: unknown;
    kind: "invocation" | "result";
}
export interface ToolCallIndexEntry {
    occurrences: IndexedOccurrence[];
    hasResult: boolean;
}
export type ToolCallIndex = Map<string, ToolCallIndexEntry>;
export declare function hasMeaningfulPart(part: unknown): boolean;
/**
 * True when a tool part carries a COMPLETED result — i.e. the arc is closed and
 * OpenCode will not read its input again. This is the selection gate that keeps
 * open arcs (an invocation with no result yet) out of every drop/clamp selector.
 *
 * OpenCode's single-part `{ type: "tool" }` representation is classified as a
 * "result" observation by its TYPE even while the call is still pending/running
 * (no output written yet). The arc is closed in either of two arms: a completed
 * result (`state.output` is a string) OR an errored call (`state.status ===
 * "error"`, carrying `state.error`). OpenCode serializes an errored part as an
 * `output-error` block built from `state.error` and never reads its input again
 * (opencode message-v2.ts error arm), so it is just as safe to reclaim as a
 * completed one — excluding it would leak bulky inputs (e.g. a failed write with
 * a large content arg). Pending/running parts have neither an output nor an
 * error status and stay excluded. Anthropic's separate `tool_result` part only
 * exists after the call finished, so it always counts. Invocation-shaped parts
 * (`tool-invocation` / `tool_use`) never carry a result and are excluded here.
 */
export declare function partHasCompletedResult(part: unknown): boolean;
export declare function extractToolCallObservation(part: unknown): ToolCallObservation | null;
export declare class ToolMutationBatch {
    private partsToRemove;
    private affectedMessages;
    private messages;
    constructor(messages: MessageLike[]);
    markForRemoval(occurrence: IndexedOccurrence): void;
    finalize(): void;
}
/**
 * Build a TagTarget for a single tool composite key
 * (`<ownerMsgId>\x00<callId>`).
 *
 * v3.3.1 Layer C: pre-fix this took a bare `callId`. Two assistant turns
 * reusing the same callId produced two TagTargets that both pointed at
 * the same `index.get(callId)` entry — last-write-wins on `targets.set`
 * silently merged them into one drop target, and a queued drop on the
 * older tag would mutate the newer turn's content. Composite keys
 * guarantee one TagTarget per (owner, callId) pair, so each turn's tag
 * gets its own independent drop scope.
 *
 * The `index` map is keyed by composite key as well — see
 * `tag-messages.ts` for the matching producer.
 */
export declare function createToolDropTarget(compositeKey: string, thinkingParts: ThinkingLikePart[], index: ToolCallIndex, batch: ToolMutationBatch, tagId: number): {
    setContent: (content: string) => boolean;
    drop: () => ToolDropResult;
    truncate: () => ToolDropResult;
    editMarker: () => ToolDropResult;
    /**
     * Non-mutating predicate: would drop()/truncate() actually remove bytes?
     * False for an absent (compacted-away) or incomplete (invocation present,
     * no result part) entry — both return early without reclaiming anything.
     * The tiered emergency planner must filter on this, not on the mere
     * presence of a drop() function: counting a no-reclaim tag as droppable
     * makes the plan stop early and under-evict below the ceiling.
     */
    canDrop: () => boolean;
    readInput: () => Record<string, unknown> | null;
};
export {};
//# sourceMappingURL=tool-drop-target.d.ts.map