export interface ReferenceSeed {
    /** importance score parsed from the seed's <compartment importance="N"> attribute */
    readonly importance: number;
    /** full example XML unit (compartment + optional facts/events/user_observations) */
    readonly block: string;
}
export declare const REFERENCE_SEEDS: ReadonlyArray<ReferenceSeed>;
//# sourceMappingURL=reference-seeds.generated.d.ts.map