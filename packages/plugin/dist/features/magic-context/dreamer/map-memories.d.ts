import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
import { type LeaseAcquisition } from "./lease";
import { type MapMemoryInput } from "./map-memories-prompt";
import type { DreamerModuleRoute } from "./module-apply";
export declare const MAX_INDEPENDENT_REQUEUE_PER_RUN = 80;
export interface MapMemoriesArgs {
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
    moduleRoute?: DreamerModuleRoute;
    onProgress?: (processed: number) => void;
}
export interface MapMemoriesResult {
    mapped: number;
    independent: number;
    batches: number;
    remaining: number;
    complete: boolean;
}
export declare function shouldRequeueIndependentMapping(state: {
    hasSentinel: boolean;
    files: readonly string[];
}, content: string, repoDir: string): boolean;
export declare function selectMapMemoryInputs(db: Database, projectIdentity: string, repoDir: string): MapMemoryInput[];
export declare function mapMemories(args: MapMemoriesArgs): Promise<MapMemoriesResult>;
export declare function applyBatchMappings(args: MapMemoriesArgs, batch: MapMemoryInput[], manifestText: string): Promise<{
    mapped: number;
    independent: number;
}>;
//# sourceMappingURL=map-memories.d.ts.map