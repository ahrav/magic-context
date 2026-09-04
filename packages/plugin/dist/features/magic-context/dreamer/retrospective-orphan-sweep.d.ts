import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
type OpencodeClient = PluginContext["client"];
/**
 * Privacy backstop for dreamer children that carry raw user or project text.
 *
 * These child sessions normally delete themselves in `finally`, but a hard
 * SIGKILL/OOM BETWEEN session-create and that delete would leave their prompts
 * on disk. This sweep removes such crash-orphaned children.
 *
 * CONCURRENCY: `session.delete` has no cross-process "active session" lease (OC
 * peer confirmed), so the ONLY safe filter is AGE — a child older than any
 * legitimate run cannot belong to a live run on another OpenCode process.
 * OpenCode sets `title` + `time_created` immediately at create (not lazily), so
 * the age gate is airtight. 404 on delete = already-swept = success.
 */
export declare const RETROSPECTIVE_CHILD_TITLE = "magic-context-dream-retrospective";
export declare const USER_MEMORIES_CHILD_TITLE = "magic-context-dream-user-memories";
export declare const CURATE_CHILD_TITLE = "magic-context-dream-curate";
export declare const MAINTAIN_DOCS_CHILD_TITLE = "magic-context-dream-maintain-docs";
export declare const REFRESH_PRIMERS_CHILD_TITLE = "magic-context-dream-refresh-primers";
export declare const SMART_NOTE_COMPILE_CHILD_TITLE_PREFIX = "magic-context-smart-note-compile-";
export declare const SMART_NOTE_CONFIRM_CHILD_TITLE_PREFIX = "magic-context-smart-note-confirm-";
export declare const PRIVACY_SENSITIVE_CHILD_TASKS: readonly ["retrospective", "review-user-memories", "curate", "maintain-docs", "refresh-primers", "evaluate-smart-notes"];
export interface PrivacySensitiveChildTitleMatches {
    exact: readonly string[];
    prefixes: readonly string[];
}
export declare const PRIVACY_SENSITIVE_CHILD_TITLE_MATCHES: PrivacySensitiveChildTitleMatches;
/** Stale threshold from task timeout(s): max(60min, maxTimeout×3) — comfortably
 *  past every swept child type so a live child is never swept. */
export declare function retrospectiveOrphanStaleMs(taskTimeoutMinutes: number | undefined | readonly (number | undefined)[]): number;
/**
 * Delete crash-orphaned privacy-sensitive dreamer children for THIS project
 * directory when they are older than `staleMs`. Best-effort + fail-open: any
 * DB/schema/API error is logged and skipped (never throws into the caller's
 * sweep). Returns the count deleted.
 */
export declare function sweepOrphanedRetrospectiveChildren(args: {
    opencodeDb: Database | null;
    client: OpencodeClient;
    sessionDirectory: string;
    staleMs: number;
    titleMatches?: PrivacySensitiveChildTitleMatches;
    now?: number;
}): Promise<number>;
export {};
//# sourceMappingURL=retrospective-orphan-sweep.d.ts.map