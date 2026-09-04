import type { PluginInput } from "@opencode-ai/plugin";
import type { AutoUpdateCheckerOptions } from "./types";
type OpenCodeEvent = {
    type: string;
    properties?: unknown;
};
/**
 * Auto-update checker.
 *
 * Trigger model (rewritten in v0.17.1):
 *
 * The check fires from plugin initialization itself via a `setTimeout`
 * scheduled when this hook is created. We do NOT gate on
 * `session.created` events — that gate was unreliable because:
 *
 *   - TUI restart with a resumed session never fires `session.created`
 *     (the event fires on session creation, not on plugin reload).
 *   - Multi-project plugin reloads each get their own plugin lifetime
 *     with `hasChecked = false`, so only whichever project happens to
 *     create a fresh session first ever runs the check.
 *   - Sidebar/status polling and idle TUI use also never fire
 *     `session.created`.
 *
 * Multi-project coordination is now handled by an on-disk timestamp at
 * `<storageDir>/last-update-check.json`. Every plugin instance reads
 * the timestamp before checking; if it's within `checkIntervalMs` of
 * now, the check is skipped. The first instance to claim the slot
 * writes the timestamp atomically (temp + rename) so concurrent
 * instances don't all hit npm.
 *
 * The returned event hook is preserved as a no-op so existing tests
 * that pass synthetic events keep working — the hook itself never
 * triggers a check now.
 */
export declare function createAutoUpdateCheckerHook(ctx: PluginInput, options?: AutoUpdateCheckerOptions): (_input: {
    event: OpenCodeEvent;
}) => Promise<void>;
export declare function getAutoUpdateInstallDir(): string;
export type { AutoUpdateCheckerOptions } from "./types";
//# sourceMappingURL=index.d.ts.map