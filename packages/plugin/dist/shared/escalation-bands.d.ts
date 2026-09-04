export declare const MAX_EXECUTE_THRESHOLD = 90;
export declare const ABSOLUTE_EMERGENCY_PERCENTAGE = 95;
export interface EscalationBands {
    forceMaterializationPercentage: number;
    emergencyPercentage: number;
}
/** Keep force cleanup above normal execution while preserving the absolute 95% wall. */
export declare function escalationBands(effectiveThresholdPercentage: number): EscalationBands;
//# sourceMappingURL=escalation-bands.d.ts.map