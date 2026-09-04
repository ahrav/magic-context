import { type ToolDefinition } from "@opencode-ai/plugin";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import type { Database } from "../../shared/sqlite";
export { CTX_REDUCE_LIGHT_DESCRIPTION } from "../light-descriptions";
export interface CtxReduceToolDeps {
    db: Database;
    protectedTags: number;
    getSessionTokens?: (sessionId: string) => number;
    rustToolBackends?: RustToolBackends;
}
export declare function createCtxReduceTools(deps: CtxReduceToolDeps): Record<string, ToolDefinition>;
//# sourceMappingURL=tools.d.ts.map