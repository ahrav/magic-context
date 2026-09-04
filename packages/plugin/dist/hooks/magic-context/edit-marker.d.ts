/** Region-hint length: enough to identify the edited section, cheap to keep. */
export declare const EDIT_REGION_HINT_LEN = 40;
/** True for the tools whose superseded older calls we compress. */
export declare function isEditTool(name: string | null | undefined): boolean;
/**
 * Mutate a tool input object in place into its edit-marker form: preserve
 * path-like keys verbatim, clamp the diff keys to a region-hint prefix, leave
 * other (small) keys untouched. Idempotent.
 */
export declare function applyEditMarkerToInput(input: Record<string, unknown>): void;
//# sourceMappingURL=edit-marker.d.ts.map