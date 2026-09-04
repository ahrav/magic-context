import type { SidebarSnapshot } from "../shared/rpc-types";
export interface CompactionOffSidebarRow {
    label: "Memories" | "Notes" | "Archived compartments";
    value: string;
}
/**
 * Formats context pressure from the current wire input and the model context
 * limit. It deliberately does not use the stored Magic Context threshold
 * percentage, because native compaction acts on the model window instead.
 */
export declare function nativeCompactionContextLabel(snapshot: SidebarSnapshot): string;
export declare function compactionOffSidebarRows(snapshot: SidebarSnapshot): CompactionOffSidebarRow[];
//# sourceMappingURL=compaction-off.d.ts.map