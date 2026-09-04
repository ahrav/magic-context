import { type ToolDefinition } from "@opencode-ai/plugin";
import { type UnifiedSearchResult } from "../../features/magic-context/search";
import { type ExplicitDeliveryReason } from "./render";
import type { CtxSearchArgs, CtxSearchToolDeps } from "./types";
export { CTX_SEARCH_LIGHT_DESCRIPTION } from "../light-descriptions";
export interface CtxSearchCallContext {
    sessionID: string;
    directory: string;
}
/** Structured explicit-delivery outcome. `invalid` carries the same error
 *  text the tool returns; `complete` carries the rendered text plus the
 *  pre-pack ranking and the results whose blocks survived packing. A search
 *  failure propagates as a thrown error — incomplete evidence, never an
 *  empty ranking. */
export type CtxSearchExecution = {
    status: "invalid";
    text: string;
} | {
    status: "complete";
    text: string;
    prePack: UnifiedSearchResult[];
    delivered: UnifiedSearchResult[];
    tokenCount: number;
    omittedCount: number;
    reason: ExplicitDeliveryReason;
};
/**
 * Execute one explicit ctx_search call. The tool's `execute` delegates here,
 * so direct-ID lookup, multi-probe recall, source filters, visible-memory
 * filtering, ordinal cutoffs, and token packing stay on one shared path
 * whether the caller wants text or the structured outcome.
 */
export declare function executeCtxSearch(deps: CtxSearchToolDeps, rawArgs: CtxSearchArgs, toolContext: CtxSearchCallContext): Promise<CtxSearchExecution>;
export declare function createCtxSearchTools(deps: CtxSearchToolDeps): Record<string, ToolDefinition>;
//# sourceMappingURL=tools.d.ts.map