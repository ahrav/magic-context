import type { Database } from "../../shared/sqlite";
export interface CloneCompartmentRow {
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
}
export interface CloneTagRow {
    messageId: string;
    type: string;
    tagNumber: number;
    toolOwnerMessageId: string | null;
}
export interface CloneSessionStateFilter {
    resolveBoundaryOrdinal(messageId: string): number | undefined;
    includeTag(tag: CloneTagRow): boolean;
    includeMessageId(messageId: string): boolean;
    /** Map a source message/content id into the destination session. */
    mapMessageId?: (messageId: string) => string;
    /** Opt into remapping globally keyed tag ids; leave undefined for Pi compatibility. */
    mapTagId?: (sourceTagId: number, destinationTagId: number) => number;
    /** Pi forks inherit session notes/facts in the same atomic prefix copy. */
    copySessionNotesAndFacts?: boolean;
    /** Return the destination ordinal for an inherited source anchor. */
    mapOrdinal?: (sourceOrdinal: number) => number | undefined;
    selectPendingPiMarker(rawState: string | null, copiedCompartments: readonly CloneCompartmentRow[]): string | null;
}
export interface CopySessionStateForCloneResult {
    kind: "migrated" | "destination-not-empty";
    compartmentsCopied: number;
    tagsCopied: number;
    pendingOpsCopied: number;
    notesCopied: number;
    factsCopied: number;
    pendingMarkerMigrated: boolean;
}
/**
 * Copy durable session content into a clone under one immediate transaction.
 * The destination guard runs after the write lock is acquired so two plugin
 * processes cannot both observe an empty clone and duplicate its state.
 */
export declare function copySessionStateForClone(db: Database, sourceSessionId: string, destinationSessionId: string, filter: CloneSessionStateFilter): CopySessionStateForCloneResult;
//# sourceMappingURL=storage-clone.d.ts.map