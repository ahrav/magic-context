/** Number of recent ctx_reduce arcs retained as visible housekeeping exemplars. */
export declare const CTX_REDUCE_KEEP = 3;
/**
 * Return the tag numbers of the newest visible ctx_reduce arcs.
 *
 * Callers supply their active tool population so every reclaim lane protects the
 * same exemplars even when its other eligibility rules differ.
 */
export declare function newestCtxReduceTagNumbers(tags: readonly {
    tagNumber: number;
    toolName: string | null;
}[]): Set<number>;
//# sourceMappingURL=reclaim-protection.d.ts.map