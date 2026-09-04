import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
import { type LeaseAcquisition } from "./lease";
import type { DreamerModuleRoute } from "./module-apply";
import { type VerifyPromptMemory } from "./verify-prompt";
export interface VerifyArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    forceBroad?: boolean;
    model?: string;
    fallbackModels?: readonly string[];
    language?: string;
    moduleRoute?: DreamerModuleRoute;
    onProgress?: (processed: number) => void;
}
export interface VerifyResult {
    verified: number;
    updated: number;
    archived: number;
    batches: number;
    inScope: number;
    remaining: number;
    complete: boolean;
    mode: string;
    broadCycleStartAt?: number;
}
export declare function runVerify(args: VerifyArgs): Promise<VerifyResult>;
export declare function applyVerifyManifest(args: VerifyArgs, batch: VerifyPromptMemory[], manifestText: string): Promise<{
    verified: number;
    updated: number;
    archived: number;
}>;
//# sourceMappingURL=verify.d.ts.map