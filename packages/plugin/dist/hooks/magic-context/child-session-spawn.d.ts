import { type ChildSpawnFenceFailure } from "../../features/magic-context/schema-fence-probe";
import type { Database } from "../../shared/sqlite";
import { type NotificationParams } from "./send-session-notification";
export declare const STALE_PLUGIN_RESTART_NOTICE = "Magic Context: plugin build is older than its database \u2014 restart OpenCode";
export declare const SCHEMA_PROBE_FAILURE_NOTICE = "Magic Context: unable to verify the database schema before spawning a child \u2014 run npx @cortexkit/magic-context@latest doctor";
interface ChildSessionClient {
    session: {
        create(input: never): unknown | Promise<unknown>;
    };
}
interface ChildSessionSpawnArgs {
    client: ChildSessionClient;
    db: Database | null;
    parentSessionId?: string;
    title: string;
    directory?: string;
    notificationParams?: NotificationParams;
    /** Test seam for the one-shot, N-consecutive failure surface. */
    onFenceLatched?: (failure: ChildSpawnFenceFailure) => void | Promise<void>;
}
/**
 * Shared OpenCode child-session choke point. Every historian/recomp, dreamer,
 * and sidekick child must pass this probe before asking OpenCode to create it.
 */
export declare function createChildSessionWithFence(args: ChildSessionSpawnArgs): Promise<unknown | null>;
export {};
//# sourceMappingURL=child-session-spawn.d.ts.map