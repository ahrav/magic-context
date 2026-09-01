import type { SidebarSnapshot } from "../shared/rpc-types";

export interface CompactionOffSidebarRow {
    label: "Memories" | "Notes" | "Archived compartments";
    value: string;
}

/**
 */
export function nativeCompactionContextLabel(snapshot: SidebarSnapshot): string {
    if (snapshot.contextLimit <= 0) return "Context: unknown · native compaction";
    const percentage = (snapshot.inputTokens / snapshot.contextLimit) * 100;
    return `Context: ${percentage.toFixed(1)}% · native compaction`;
}

export function compactionOffSidebarRows(snapshot: SidebarSnapshot): CompactionOffSidebarRow[] {
    const rows: CompactionOffSidebarRow[] = [
        { label: "Memories", value: String(snapshot.memoryCount) },
        { label: "Notes", value: String(snapshot.sessionNoteCount) },
    ];
    const archivedCount = snapshot.archivedCompartmentCount ?? 0;
    if (archivedCount > 0) {
        rows.push({ label: "Archived compartments", value: String(archivedCount) });
    }
    return rows;
}
