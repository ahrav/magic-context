import type { Database } from "../../../shared/sqlite";
import type { ClassifyModuleClient } from "./classify";
export declare class DreamerModuleBusyError extends Error {
    readonly state: string;
    readonly transient = true;
    constructor(state: string);
}
export declare class DreamerModuleFailureError extends Error {
    readonly transient = true;
    constructor(operation: string, cause: unknown);
}
export interface DreamerModuleRoute {
    moduleClient: ClassifyModuleClient;
    moduleSessionId: string;
    moduleProjectRoot: string;
    moduleContextStoreUuid: string;
    moduleAuthorityGeneration: number;
    moduleCommandId: string;
}
/** Resolve ownership once for every dreamer applier. A rust transform setting alone is not
 * authority: the module's durable state is the fence that prevents TS fallback writes. */
export declare function resolveDreamerModuleRoute(args: {
    db: Database;
    projectIdentity: string;
    projectRoot: string;
    transformMode?: "ts" | "rust";
    moduleClient?: ClassifyModuleClient & {
        authorityStatus?: (args: {
            context_store_uuid: string;
            project: string;
            projectRoot?: string;
            domain: "memories" | "notes";
        }) => Promise<{
            authority: {
                state?: string;
                generation?: number;
            } | null;
        }>;
    };
    commandId: string;
}): Promise<DreamerModuleRoute | undefined>;
//# sourceMappingURL=module-apply.d.ts.map