export type PassDegradationKind = "degraded" | "fatal";
export interface PassDegradation {
    site: string;
    kind: PassDegradationKind;
}
export interface PassOutcome {
    degradations: PassDegradation[];
    finalized: boolean;
    record(site: string, kind?: PassDegradationKind): void;
    markFinalized(): void;
    readonly captureEligible: boolean;
    isCaptureEligible(): boolean;
}
export declare function createPassOutcome(): PassOutcome;
//# sourceMappingURL=pass-outcome.d.ts.map