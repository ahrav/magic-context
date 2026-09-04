export interface SmartNoteScheduleOptions {
    now?: number;
    noteId?: number;
    hash?: string | null;
    floorMs?: number;
    ceilingMs?: number;
}
export declare function nextSmartNoteCheckDueAt(cron: string | null | undefined, options?: SmartNoteScheduleOptions): number;
//# sourceMappingURL=schedule.d.ts.map