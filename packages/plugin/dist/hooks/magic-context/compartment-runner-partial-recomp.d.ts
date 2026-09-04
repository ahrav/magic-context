import type { Compartment } from "../../features/magic-context/compartment-storage";
import type { CompartmentRunnerDeps } from "./compartment-runner-types";
export interface PartialRecompRange {
    /** Inclusive raw message ordinal to start rebuilding from. */
    start: number;
    /** Inclusive raw message ordinal to stop rebuilding at. */
    end: number;
}
export interface SnappedPartialRange {
    /** Snapped start = first enclosing compartment's startMessage. */
    snapStart: number;
    /** Snapped end = last enclosing compartment's endMessage. */
    snapEnd: number;
    priorCompartments: Compartment[];
    rangeCompartments: Compartment[];
    tailCompartments: Compartment[];
}
/**
 * Preview-only snap computation. Shown in the first-tap confirmation warning so
 * the user sees which compartments will be replaced before executing.
 *
 * Returns an error string when the requested range cannot be snapped (e.g. no
 * compartments exist yet, or the range is entirely after the last compartment).
 */
export declare function snapRangeToCompartments(compartments: Compartment[], range: PartialRecompRange): SnappedPartialRange | {
    error: string;
};
export declare function executePartialRecompInternal(deps: CompartmentRunnerDeps, range: PartialRecompRange): Promise<string>;
//# sourceMappingURL=compartment-runner-partial-recomp.d.ts.map