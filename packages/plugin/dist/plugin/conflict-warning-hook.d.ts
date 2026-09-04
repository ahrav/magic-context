/**
 * Conflict warning for Desktop mode when magic-context is disabled.
 *
 * - When conflicts detected: reads Desktop app state → finds active session → sends ignored warning
 * - When no conflicts: cleans up any leftover warning messages from previous runs
 *
 * TUI handles this via a startup dialog — this covers Desktop only.
 */
import type { ConflictResult } from "../shared/conflict-detector";
/**
 * Send an ignored notification to the active Desktop session at plugin startup.
 */
export declare function sendConflictWarning(client: unknown, directory: string, conflictResult: ConflictResult): Promise<void>;
/**
 * Clean up leftover conflict warning messages from previous disabled runs.
 * Called at startup when no conflicts exist (plugin is enabled normally).
 */
export declare function cleanupConflictWarnings(client: unknown, directory: string, serverUrl?: string): Promise<void>;
/**
 * Desktop schema-fence warning. When OpenCode and Pi share context.db and one
 * harness auto-updates first, it migrates the DB to a newer schema; the lagging
 * harness then fail-closes and disables ALL of Magic Context. Previously this
 * was log-only, so the user just saw the plugin silently stop working. Surface
 * a clear ignored message telling them what happened and how to fix it. No
 * auto-remove: this is a real blocking state the user must act on (update the
 * lagging harness), unlike the transient TUI-setup notice.
 */
export declare function sendSchemaFenceWarning(client: unknown, directory: string, detail: {
    persistedVersion: number;
    supportedVersion: number;
}): Promise<void>;
/**
 * Desktop startup announcement: post a one-shot ignored message describing
 * what's new in this release. Mirrors the TUI's RPC-driven dialog path so both
 * surfaces deliver the same announcement once per ANNOUNCEMENT_VERSION.
 *
 * Persistence lives in `getMagicContextStorageDir()/last_announced_version`,
 * shared with the TUI handlers and the Pi plugin so a dismissal in any harness
 * suppresses the others for the same announcement.
 */
export declare function sendStartupAnnouncement(client: unknown, directory: string, version: string, features: ReadonlyArray<string>, footer: string, markSeen: (version: string) => void): Promise<void>;
//# sourceMappingURL=conflict-warning-hook.d.ts.map