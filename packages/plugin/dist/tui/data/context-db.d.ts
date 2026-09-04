import { MagicContextRpcClient } from "../../shared/rpc-client";
import type { EmbedDetail, SidebarSnapshot, StatusDetail } from "../../shared/rpc-types";
export type { EmbedDetail, SidebarSnapshot, StatusDetail };
/** Initialize the RPC client. Call once on TUI startup. */
export declare function initRpcClient(directory: string): void;
export declare function getRpcGeneration(): number;
/** The live RPC client (for the WS notification socket's endpoint discovery).
 *  Null before init / after close. */
export declare function getRpcClient(): MagicContextRpcClient | null;
/** Clean up the RPC client. */
export declare function closeRpc(): void;
/** Fetch sidebar snapshot from the server via RPC. */
export declare function loadSidebarSnapshot(sessionId: string, directory: string): Promise<SidebarSnapshot>;
/** Fetch full status detail from the server via RPC. */
export declare function loadStatusDetail(sessionId: string, directory: string, modelKey?: string): Promise<StatusDetail>;
/** Fetch embedding coverage status for `/ctx-embed` via RPC. */
export declare function loadEmbedDetail(sessionId: string, directory: string): Promise<EmbedDetail>;
export type CompartmentCountResult = {
    ok: true;
    count: number;
} | {
    ok: false;
    error: string;
};
/** Get compartment count without making transport failure look like a real zero. */
export declare function getCompartmentCount(sessionId: string): Promise<CompartmentCountResult>;
/** Send recomp request to server via RPC. */
export declare function requestRecomp(sessionId: string): Promise<boolean>;
/** Run `/ctx-session-upgrade` for the session (full recomp + once-per-project
 *  memory migration). Fired from the upgrade dialog's "Run upgrade now" action. */
export declare function requestUpgrade(sessionId: string): Promise<boolean>;
/** Mark the upgrade reminder dismissed (the user made an explicit Confirm/Cancel
 *  choice), setting the durable stamp so the FRESH dialog won't re-show. Resume
 *  prompts are staging-driven and unaffected. */
export declare function dismissUpgradeReminder(sessionId: string): Promise<boolean>;
/** Resolve global toast duration from server config via RPC. */
export declare function loadToastDurationMs(): Promise<number>;
/**
 * Fetch the current startup announcement from the server, if any.
 * Returns `{show: false}` when there's nothing to announce or when the
 * configured ANNOUNCEMENT_VERSION has already been dismissed.
 */
export interface AnnouncementResponse {
    show: boolean;
    version?: string;
    features?: string[];
    footer?: string;
}
export declare function getAnnouncement(): Promise<AnnouncementResponse>;
/** Mark the current ANNOUNCEMENT_VERSION as dismissed on the server. */
export declare function markAnnounced(): Promise<boolean>;
//# sourceMappingURL=context-db.d.ts.map