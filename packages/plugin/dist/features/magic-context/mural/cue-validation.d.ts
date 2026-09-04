/**
 * Per-cue validation, applied ON WRITE (not at parse time). The compress-cues
 * host validates each cue independently; an initial failure leaves a NULL cue for
 * the next run, while the durable rejection latch eventually writes a fallback
 * rather than rejecting the whole chunk for one bad cue. This is the per-cue half
 * of the retired validateMuralManifest; manifest-level checks for duplicate ids and
 * room/merge targets are gone with the author flow.
 */
export interface CueValidationFailure {
    reason: string;
}
/**
 * Validate a single compressed cue against the grammar the renderer and the
 * prompt agree on. Returns null when the cue is acceptable, or a failure with a
 * short machine-loggable reason. The `importance` selects the budget.
 *
 * Rules enforced (all independent of other cues):
 *  - non-empty after trim
 *  - within the per-importance character budget
 *  - no leaked source id matching this memory's own claim id
 *  - balanced parentheses (prohibition mechanisms use them)
 *  - a prohibition trigger word requires a ⊘ polarity marker
 *  - every ⊘ marker needs a parenthesized mechanism
 */
export declare function validateCue(cue: string, importance: number, ownId?: string): CueValidationFailure | null;
//# sourceMappingURL=cue-validation.d.ts.map