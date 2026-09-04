import type { MagicContextConfig } from "../config/schema/magic-context";
import { type ContextDatabase as Database } from "../features/magic-context/storage";
import type { LiveSessionState } from "../hooks/magic-context/live-session-state";
import type { RustModeModuleClient } from "../hooks/magic-context/rust-mode-transform";
import type { MagicContextRpcServer } from "../shared/rpc-server";
import type { SidebarSnapshot, StatusDetail } from "../shared/rpc-types";
import { type WireTailHygieneBaseline } from "../shared/tail-hygiene-status";
export interface RustSessionStatus {
    usage?: {
        current_total_input_tokens?: number;
        context_limit_tokens?: number;
    };
    tail_hygiene?: WireTailHygieneBaseline | null;
    boundary_present?: boolean;
    coverage_ordinal?: number | null;
    compartment_count?: number;
    compartment_tokens?: number;
    pending_drop_count?: number;
    tag_count?: number;
    pending_m1_delta?: boolean;
    pending_m1_age_ms?: number | null;
    wrapup_active?: boolean;
    wrapup_rounds?: number | null;
}
export declare function buildSidebarSnapshot(db: Database, sessionId: string, directory: string, liveSessionState?: LiveSessionState, injectionBudgetTokens?: number, config?: Record<string, unknown>, moduleStatus?: RustSessionStatus, compactionEnabled?: boolean): SidebarSnapshot;
/** Convert snapshot-build failures into a transport-failure envelope. A genuine
 * zero snapshot remains a successful value so deleted sessions stay deleted. */
export declare function buildSidebarSnapshotRpcResponse(db: Database, sessionId: string, directory: string, liveSessionState?: LiveSessionState, injectionBudgetTokens?: number, config?: Record<string, unknown>, moduleStatus?: RustSessionStatus, compactionEnabled?: boolean): Record<string, unknown>;
export declare function buildStatusDetail(db: Database, sessionId: string, directory: string, modelKey?: string, config?: Record<string, unknown>, liveSessionState?: LiveSessionState, injectionBudgetTokens?: number, moduleStatus?: RustSessionStatus, compactionEnabled?: boolean): StatusDetail;
/**
 * Register all RPC handlers on the server.
 */
export declare function registerRpcHandlers(rpcServer: MagicContextRpcServer, args: {
    directory: string;
    config: MagicContextConfig;
    client: unknown;
    liveSessionState: LiveSessionState;
    rustModeModuleClient?: RustModeModuleClient;
}): void;
//# sourceMappingURL=rpc-handlers.d.ts.map