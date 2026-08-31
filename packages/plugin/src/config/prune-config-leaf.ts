/**
 * Cloning traversed objects prevents mutations to `block` and its nested objects.
 *
 * Pruning a nested field preserves sibling fields.
 *
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The function removes a reachable leaf or an existing non-object segment that blocks traversal.
 * The function returns `null` for an empty path or when traversal cannot reach an existing field.
 */
export function pruneNestedConfigLeaf(
    block: Record<string, unknown>,
    relativePath: readonly PropertyKey[],
): { block: Record<string, unknown>; removed: string } | null {
    if (relativePath.length === 0) return null;

    const result: Record<string, unknown> = { ...block };
    let cursor = result;

    for (let i = 0; i < relativePath.length - 1; i++) {
        const seg = String(relativePath[i]);
        const child = cursor[seg];
        if (!isPlainObject(child)) {
            if (!(seg in cursor)) return null;
            delete cursor[seg];
            return {
                block: result,
                removed: relativePath
                    .slice(0, i + 1)
                    .map(String)
                    .join("."),
            };
        }
        const clonedChild: Record<string, unknown> = { ...child };
        cursor[seg] = clonedChild;
        cursor = clonedChild;
    }

    const leaf = String(relativePath[relativePath.length - 1]);
    if (!(leaf in cursor)) return null;
    delete cursor[leaf];
    return { block: result, removed: relativePath.map(String).join(".") };
}
