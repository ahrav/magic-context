import type { PluginContext } from "../../../plugin/types";
import type { Database } from "../../../shared/sqlite";
import { type LeaseAcquisition } from "./lease";
export interface PromotePrimersArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    promotionThreshold?: number;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void> | void;
}
export interface PromotePrimersResult {
    promoted: number;
    updated: number;
    candidates: number;
    pruned: number;
}
/** Re-embeds primer candidates and active primers whose vectors are missing or
 *  were produced under a retired provider identity. Search skips any vector
 *  whose model id differs from the query's, so stale rows are semantically
 *  invisible until rewritten. Runs from the always-reachable project sweep as
 *  well as the promotion pass, because primer SEARCH stays enabled even when
 *  dreamer scheduling is disabled. `checkpoint` runs before each write so the
 *  promotion path can assert its lease mid-batch; the sweep path passes
 *  nothing — the writes are idempotent (equivalent vectors under the same
 *  identity), so concurrent sweeps waste at most a little compute.
 *  Returns the number of rows rewritten. */
export declare function reembedStalePrimerEmbeddings(db: Database, projectIdentity: string, checkpoint?: () => void): Promise<number>;
export declare function promotePrimers(args: PromotePrimersArgs): Promise<PromotePrimersResult>;
//# sourceMappingURL=promote-primers.d.ts.map