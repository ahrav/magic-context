import { type ConflictResult } from "./conflict-detector";
/**
 * Options for {@link fixConflicts}.
 *
 * `compactionEnabled` is the boot-resolved MC compaction mode (the result of
 * {@link isCompactionEnabled} on the resolved user-tier config). When `false`
 * (compaction-off mode), the fixer MUST NOT flip `compaction.auto`/`prune` to
 * `false` — native compaction fields are left byte-for-byte as found, because
 * native compaction (or nothing) is the user's chosen window manager. DCP and
 * OMO hook fixes keep their existing policy in BOTH modes.
 *
 * Default `true` (mode-on) preserves today's fix behavior for call sites that
 * cannot supply the resolved mode; they fail toward mode-on, never silently
 * skipping the fix.
 */
export interface FixConflictsOptions {
    compactionEnabled?: boolean;
}
export declare function fixConflicts(directory: string, conflicts: ConflictResult["conflicts"], options?: FixConflictsOptions): string[];
//# sourceMappingURL=conflict-fixer.d.ts.map