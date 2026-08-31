/* */
export const CTX_REDUCE_KEEP = 3;

/**
 *
 */
export function newestCtxReduceTagNumbers(
    tags: readonly { tagNumber: number; toolName: string | null }[],
): Set<number> {
    return new Set(
        tags
            .filter((tag) => tag.toolName === "ctx_reduce")
            .sort((left, right) => right.tagNumber - left.tagNumber)
            .slice(0, CTX_REDUCE_KEEP)
            .map((tag) => tag.tagNumber),
    );
}
