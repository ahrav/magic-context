import type { SidekickConfig } from "../../../config/schema/magic-context";
import type { PluginContext } from "../../../plugin/types";
import { SIDEKICK_SYSTEM_PROMPT } from "./core";
export { SIDEKICK_SYSTEM_PROMPT };
export declare function runSidekick(deps: {
    client: PluginContext["client"];
    sessionId?: string;
    projectPath: string;
    userMessage: string;
    config: SidekickConfig;
    sessionDirectory?: string;
    language?: string;
}): Promise<string | null>;
//# sourceMappingURL=agent.d.ts.map