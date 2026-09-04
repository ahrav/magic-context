export declare const MAINTAIN_DOCS_SNAPSHOT_FILES: readonly ["ARCHITECTURE.md", "STRUCTURE.md"];
export type MaintainDocsDocSnapshot = Map<string, string>;
/** Read canonical pre-task bytes for maintain-docs enforcement. */
export declare function snapshotMaintainDocsFiles(docsDir: string): MaintainDocsDocSnapshot;
/**
 * After maintain-docs, re-read on-disk docs and restore protected regions from the pre-task snapshot.
 * Best-effort: read/write failures are logged, not thrown.
 */
export declare function enforceMaintainDocsProtectedRegions(args: {
    docsDir: string;
    snapshot: MaintainDocsDocSnapshot;
}): void;
//# sourceMappingURL=maintain-docs-protected-enforcement.d.ts.map