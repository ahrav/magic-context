import type { SidebarSnapshot } from "../shared/rpc-types";
/**
 * Apply the sticky-cache policy to a freshly built snapshot.
 *
 * Returns either the live snapshot (preferred) or a hybrid snapshot that
 * preserves token-breakdown values from the previous good reading while keeping
 * fresh DB-backed counts (compartmentCount, memoryCount, historian state, etc.)
 * from the current build.
 */
export declare function applyStickySnapshotCache(sessionId: string, fresh: SidebarSnapshot): SidebarSnapshot;
/**
 * Drop the cached snapshot for a session. Wired to `session.deleted`.
 */
export declare function clearSidebarSnapshotCache(sessionId: string): void;
/**
 * Test helper — drop the entire cache.
 */
export declare function resetSidebarSnapshotCache(): void;
//# sourceMappingURL=sidebar-snapshot-cache.d.ts.map