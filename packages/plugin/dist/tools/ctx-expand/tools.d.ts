import { type ToolDefinition } from "@opencode-ai/plugin";
import type { ContextDatabase } from "../../features/magic-context/storage";
export { CTX_EXPAND_LIGHT_DESCRIPTION } from "../light-descriptions";
export interface CtxExpandToolDeps {
    db: ContextDatabase;
}
export declare function createCtxExpandTools(deps: CtxExpandToolDeps): Record<string, ToolDefinition>;
//# sourceMappingURL=tools.d.ts.map