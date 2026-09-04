import type { Database } from "../../shared/sqlite";
import type { CandidateCompartment, CompartmentRunnerDeps } from "./compartment-runner-types";
export declare function promoteRecompStagingWithM0Mutation(db: Database, sessionId: string, holderId: string): {
    compartments: CandidateCompartment[];
    facts: Array<{
        category: string;
        content: string;
    }>;
} | null;
export declare function executeContextRecompInternal(deps: CompartmentRunnerDeps): Promise<string>;
//# sourceMappingURL=compartment-runner-recomp.d.ts.map