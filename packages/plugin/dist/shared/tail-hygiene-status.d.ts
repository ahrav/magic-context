import type { Channel1State } from "../hooks/magic-context/ctx-reduce-nudge";
import type { TailHygieneStatus } from "./rpc-types";
export interface WireTailHygieneBaseline {
    u?: number;
    t?: number;
    severity?: number;
    evaluable?: boolean;
    generation_invalidated?: boolean;
    baseline_generation?: number;
    computed_at_ms?: number;
}
/** Normalize either renderer authority's persisted baseline without dropping valid zeros. */
export declare function resolveTailHygieneStatus(tsBaseline: Channel1State | undefined, rustBaseline?: WireTailHygieneBaseline | null): TailHygieneStatus | undefined;
export declare function formatTailHygiene(status: TailHygieneStatus): string;
//# sourceMappingURL=tail-hygiene-status.d.ts.map