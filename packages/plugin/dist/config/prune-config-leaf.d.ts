/**
 * Immutable nested-config-leaf pruning for config recovery.
 *
 * When Zod validation flags an invalid nested field, recovery prunes just that
 * field and keeps valid siblings (so one bad value doesn't reset a whole block
 * and silently restore disabled behavior via schema defaults). The naive version
 * deleted the FIRST child under the top-level key (`path[1]`), which is wrong for
 * paths deeper than two levels: an invalid `memory.git_commit_indexing.since_days`
 * has `path = ["memory","git_commit_indexing","since_days"]`, and deleting
 * `path[1]` ("git_commit_indexing") drops the entire sub-block — losing a
 * user's `enabled: false` so the default `enabled: true` is restored.
 *
 * `pruneNestedConfigLeaf` walks the full path and removes only the deepest leaf,
 * deep-cloning each object along the way so sibling values (and the caller's
 * original object) are never mutated.
 */
/**
 * Remove a single nested leaf from `block`, given a path RELATIVE to it
 * (i.e. the Zod issue path with its top-level key sliced off). Returns the new
 * block plus the dotted label of the removed leaf, or null when the path can't
 * be fully navigated to an object that contains the leaf.
 */
export declare function pruneNestedConfigLeaf(block: Record<string, unknown>, relativePath: readonly PropertyKey[]): {
    block: Record<string, unknown>;
    removed: string;
} | null;
//# sourceMappingURL=prune-config-leaf.d.ts.map