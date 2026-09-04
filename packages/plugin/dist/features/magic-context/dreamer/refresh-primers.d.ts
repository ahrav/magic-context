import { type RawMessageProvider } from "../../../hooks/magic-context/read-session-chunk";
import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
import { type LeaseAcquisition } from "./lease";
export interface RefreshPrimersArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    model?: string;
    fallbackModels?: readonly string[];
    language?: string;
    onProgress?: (processed: number) => void;
    /**
     * Pi only: builds a RawMessageProvider for an arbitrary historical session id
     * (JSONL), so the orientation seed read works on Pi-only installs where there
     * is no opencode.db. OpenCode leaves this undefined — the seed read falls to
     * the read-only opencode.db path. Returning null → closed-book fallback.
     * May be async (Pi JSONL discovery is async); the returned provider's
     * `readMessages()` itself is synchronous (wraps already-loaded entries).
     */
    rawProviderFactory?: (sessionId: string) => Promise<RawMessageProvider | null> | RawMessageProvider | null;
}
export interface RefreshPrimersResult {
    refreshed: number;
    skipped: number;
}
export declare function refreshPrimers(args: RefreshPrimersArgs): Promise<RefreshPrimersResult>;
//# sourceMappingURL=refresh-primers.d.ts.map